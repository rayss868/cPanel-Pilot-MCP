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
    "Upload one or multiple local files from your computer to the cPanel server",
    {
      local_file_paths: z.array(z.string()).describe("Array of absolute paths to the local files on your computer (e.g., ['C:/Users/name/image.png', 'C:/Users/name/doc.pdf'])"),
      remote_dir: z.string().describe("Destination directory on cPanel (e.g., /home/user/public_html)"),
    },
    async ({ local_file_paths, remote_dir }) =>
      handleToolCall(async () => {
        try {
          const filesToUpload = [];
          
          for (let i = 0; i < local_file_paths.length; i++) {
            const localPath = local_file_paths[i];
            const fileBuffer = await fs.readFile(localPath);
            const fileName = pathModule.basename(localPath);
            
            filesToUpload.push({
              field: `file-${i + 1}`,
              name: fileName,
              content: fileBuffer
            });
          }
          
          const result = await client.uapiPostMultipart(
            "Fileman",
            "upload_files",
            { dir: remote_dir },
            filesToUpload
          );
          
          return formatSuccess(`Successfully uploaded ${filesToUpload.length} file(s) to ${remote_dir}`, result.data);
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
