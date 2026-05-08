import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CpanelClient } from "../cpanel-api.js";
import { handleToolCall, formatData, formatSuccess } from "../tool-helpers.js";
import { splitPath, validatePath } from "../validation.js";
import fs from "node:fs/promises";
import pathModule from "node:path";

export function registerFileTools(server: McpServer, client: CpanelClient) {
  server.tool(
    "list_files",
    "List files and directories in a specified path",
    { path: z.string().default("/").describe("Directory path to list") },
    async ({ path }) =>
      handleToolCall(async () => {
        validatePath(path);
        const result = await client.uapi("Fileman", "list_files", {
          dir: path,
          include_mime: "1",
          include_permissions: "1",
        });
        return formatData(result.data);
      })
  );

  server.tool(
    "create_file",
    "Create a new file with specified content",
    {
      path: z.string().describe("Full file path including filename"),
      content: z.string().describe("File content"),
    },
    async ({ path, content }) =>
      handleToolCall(async () => {
        const { dir, file } = splitPath(path);
        const result = await client.uapiPost("Fileman", "save_file_content", {
          dir,
          file,
          content,
        });
        return formatSuccess(`File created: ${path}`, result.data);
      })
  );

  server.tool(
    "read_file",
    "Read the contents of a file",
    { path: z.string().describe("Full file path to read") },
    async ({ path }) =>
      handleToolCall(async () => {
        const { dir, file } = splitPath(path);
        const result = await client.uapi("Fileman", "get_file_content", {
          dir,
          file,
        });
        return formatData(result.data);
      })
  );

  server.tool(
    "edit_file",
    "Update the contents of an existing file",
    {
      path: z.string().describe("Full file path to edit"),
      content: z.string().describe("New file content"),
    },
    async ({ path, content }) =>
      handleToolCall(async () => {
        const { dir, file } = splitPath(path);
        const result = await client.uapiPost("Fileman", "save_file_content", {
          dir,
          file,
          content,
        });
        return formatSuccess(`File updated: ${path}`, result.data);
      })
  );

  server.tool(
    "delete_file",
    "Delete a file or directory",
    { path: z.string().describe("Full path to delete") },
    async ({ path }) =>
      handleToolCall(async () => {
        const { dir, file } = splitPath(path);
        const result = await client.uapi("Fileman", "trash", {
          dir,
          file,
        });
        return formatSuccess(`Deleted: ${path}`, result.data);
      })
  );

  server.tool(
    "upload_file",
    "Upload files or directories from your computer to the cPanel server. Supports single file, multiple files to one/multiple destinations, and full directory uploads.",
    {
      uploads: z.array(z.object({
        local_path: z.string().describe("Absolute path to the local file or directory (e.g., 'C:/Users/name/image.png' or 'C:/Users/name/my_folder')"),
        remote_dir: z.string().describe("Destination directory on cPanel (e.g., '/home/user/public_html'). If uploading a directory, its contents will be placed inside this remote_dir."),
      })).describe("Array of upload tasks"),
    },
    async ({ uploads }) =>
      handleToolCall(async () => {
        try {
          let totalUploaded = 0;
          const results = [];

          // Helper function to recursively get all files in a directory
          async function getFilesRecursive(dir: string): Promise<string[]> {
            const dirents = await fs.readdir(dir, { withFileTypes: true });
            const files = await Promise.all(dirents.map(async (dirent) => {
              const res = pathModule.resolve(dir, dirent.name);
              return dirent.isDirectory() ? await getFilesRecursive(res) : [res];
            }));
            return Array.prototype.concat(...files);
          }

          for (const task of uploads) {
            const stat = await fs.stat(task.local_path);
            
            if (stat.isDirectory()) {
              // Handle directory upload
              const allFiles = await getFilesRecursive(task.local_path);
              
              // Group files by their relative directory structure
              const filesByDir: Record<string, { field: string; name: string; content: Buffer }[]> = {};
              
              for (let i = 0; i < allFiles.length; i++) {
                const filePath = allFiles[i];
                const relativePath = pathModule.relative(task.local_path, filePath);
                // Convert Windows backslashes to forward slashes for cPanel
                const normalizedRelativePath = relativePath.split(pathModule.sep).join('/');
                
                const fileDir = pathModule.dirname(normalizedRelativePath);
                const fileName = pathModule.basename(normalizedRelativePath);
                
                // Calculate the final remote directory for this specific file
                const finalRemoteDir = fileDir === '.' 
                  ? task.remote_dir 
                  : `${task.remote_dir}/${fileDir}`;
                
                if (!filesByDir[finalRemoteDir]) {
                  filesByDir[finalRemoteDir] = [];
                }
                
                const fileBuffer = await fs.readFile(filePath);
                filesByDir[finalRemoteDir].push({
                  field: `file-${filesByDir[finalRemoteDir].length + 1}`,
                  name: fileName,
                  content: fileBuffer
                });
              }
              
              // Upload grouped files directory by directory
              for (const [remoteDir, files] of Object.entries(filesByDir)) {
                // Note: cPanel's upload_files will automatically create the directory if it doesn't exist
                await client.uapiPostMultipart(
                  "Fileman",
                  "upload_files",
                  { dir: remoteDir },
                  files
                );
                totalUploaded += files.length;
              }
              
              results.push(`Directory '${task.local_path}' uploaded to '${task.remote_dir}'`);
              
            } else {
              // Handle single file upload
              const fileBuffer = await fs.readFile(task.local_path);
              const fileName = pathModule.basename(task.local_path);
              
              await client.uapiPostMultipart(
                "Fileman",
                "upload_files",
                { dir: task.remote_dir },
                [{
                  field: "file-1",
                  name: fileName,
                  content: fileBuffer
                }]
              );
              
              totalUploaded++;
              results.push(`File '${task.local_path}' uploaded to '${task.remote_dir}'`);
            }
          }
          
          return formatSuccess(`Successfully uploaded ${totalUploaded} file(s) across ${uploads.length} task(s).\nDetails:\n${results.join('\n')}`, { total_files: totalUploaded });
        } catch (error: any) {
          throw new Error(`Failed to read local files or upload: ${error.message}`);
        }
      })
  );

  server.tool(
    "extract_archive",
    "Extract a ZIP or TAR archive",
    {
      path: z.string().describe("Full path to the archive file (.zip, .tar.gz, etc)"),
      extract_to: z.string().describe("Directory where the archive should be extracted to"),
    },
    async ({ path, extract_to }) =>
      handleToolCall(async () => {
        const { dir, file } = splitPath(path);
        const result = await client.uapiPost("Fileman", "extract", {
          dir,
          file,
          destdir: extract_to,
        });
        return formatSuccess(`Archive extracted from ${path} to ${extract_to}`, result.data);
      })
  );

  server.tool(
    "change_permissions",
    "Change the CHMOD permissions of a file or directory",
    {
      path: z.string().describe("Full path to the file or directory"),
      permissions: z.string().describe("New permissions in octal format (e.g., 0644 or 0755)"),
    },
    async ({ path, permissions }) =>
      handleToolCall(async () => {
        const { dir, file } = splitPath(path);
        const result = await client.uapiPost("Fileman", "change_permissions", {
          dir,
          file,
          permissions,
        });
        return formatSuccess(`Permissions for ${path} changed to ${permissions}`, result.data);
      })
  );
}
