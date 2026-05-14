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
    "List files and directories in a specified cPanel directory. Example path: '/home/username/public_html' or '/home/username/public_html/images'.",
    {
      path: z.string().default("/").describe("Directory path to list. Example: '/home/username/public_html' or '/home/username/public_html/assets'.")
    },
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
    "Create a new text file on cPanel with the exact content you provide. Good for HTML, PHP, JS, JSON, TXT, and config files.",
    {
      path: z.string().describe("Full destination file path including filename. Example: '/home/username/public_html/index.html' or '/home/username/public_html/api/config.json'."),
      content: z.string().describe("Complete file content to write. Example: '<h1>Hello World</h1>' or '{\n  \"name\": \"demo\"\n}'.")
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
    "Read the contents of a text file from cPanel.",
    {
      path: z.string().describe("Full file path to read. Example: '/home/username/public_html/index.php' or '/home/username/public_html/.htaccess'.")
    },
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
    "Overwrite an existing text file with new content. Use this to replace the full content of HTML, PHP, JS, JSON, TXT, or config files.",
    {
      path: z.string().describe("Full file path to edit. Example: '/home/username/public_html/index.php' or '/home/username/public_html/assets/app.js'."),
      content: z.string().describe("New full file content that will replace the old content. Example: '<?php echo \"Updated\"; ?>'.")
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
    "Delete a file or directory from cPanel.",
    {
      path: z.string().describe("Full path to delete. Example: '/home/username/public_html/old-file.txt' or '/home/username/public_html/old-folder'.")
    },
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

  async function getFilesRecursive(dir: string): Promise<string[]> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(dirents.map(async (dirent) => {
      const res = pathModule.resolve(dir, dirent.name);
      return dirent.isDirectory() ? await getFilesRecursive(res) : [res];
    }));
    return Array.prototype.concat(...files);
  }

  async function runUploads(
    uploads: Array<{ local_path: string; remote_dir: string; overwrite?: boolean }>
  ) {
    let totalUploaded = 0;
    const results: string[] = [];

    for (const task of uploads) {
      const stat = await fs.stat(task.local_path);

      if (stat.isDirectory()) {
        const allFiles = await getFilesRecursive(task.local_path);
        const filesByDir: Record<string, { field: string; name: string; content: Buffer }[]> = {};

        for (let i = 0; i < allFiles.length; i++) {
          const filePath = allFiles[i];
          const relativePath = pathModule.relative(task.local_path, filePath);
          const normalizedRelativePath = relativePath.split(pathModule.sep).join("/");
          const fileDir = pathModule.dirname(normalizedRelativePath);
          const fileName = pathModule.basename(normalizedRelativePath);
          const finalRemoteDir = fileDir === "."
            ? task.remote_dir
            : `${task.remote_dir}/${fileDir}`;

          if (!filesByDir[finalRemoteDir]) {
            filesByDir[finalRemoteDir] = [];
          }

          const fileBuffer = await fs.readFile(filePath);
          filesByDir[finalRemoteDir].push({
            field: `file-${filesByDir[finalRemoteDir].length + 1}`,
            name: fileName,
            content: fileBuffer,
          });
        }

        for (const [remoteDir, files] of Object.entries(filesByDir)) {
          await client.uapiPostMultipart(
            "Fileman",
            "upload_files",
            { dir: remoteDir, overwrite: task.overwrite ? "1" : "0" },
            files
          );
          totalUploaded += files.length;
        }

        results.push(`Directory '${task.local_path}' uploaded to '${task.remote_dir}'`);
      } else {
        const fileBuffer = await fs.readFile(task.local_path);
        const fileName = pathModule.basename(task.local_path);

        await client.uapiPostMultipart(
          "Fileman",
          "upload_files",
          { dir: task.remote_dir, overwrite: task.overwrite ? "1" : "0" },
          [{
            field: "file-1",
            name: fileName,
            content: fileBuffer,
          }]
        );

        totalUploaded++;
        results.push(`File '${task.local_path}' uploaded to '${task.remote_dir}'`);
      }
    }

    return formatSuccess(
      `Successfully uploaded ${totalUploaded} file(s) across ${uploads.length} task(s).\nDetails:\n${results.join("\n")}`,
      { total_files: totalUploaded }
    );
  }

  server.tool(
    "upload_file",
    "Upload one local file or one local directory to cPanel. Use this when you want simple MCP UI fields to appear clearly. If local_path is a directory, all nested files are uploaded into remote_dir while preserving subfolder structure. Set overwrite=true to replace existing files.",
    {
      local_path: z.string().describe("Absolute path to one local file or one local directory on your computer. Example file: 'C:/Users/name/Desktop/logo.png'. Example folder: 'C:/Users/name/Desktop/site-assets'."),
      remote_dir: z.string().describe("Destination directory on cPanel. Example: '/home/user/public_html' or '/home/user/public_html/images'. If local_path is a directory, uploaded files keep their relative folder structure under this directory."),
      overwrite: z.boolean().optional().describe("Set true to overwrite existing remote files with the same name. Set false or omit to keep default cPanel behavior."),
    },
    async ({ local_path, remote_dir, overwrite }) =>
      handleToolCall(async () => runUploads([{ local_path, remote_dir, overwrite }]))
  );

  server.tool(
    "upload_file_batch",
    "Upload multiple local files or directories to cPanel in one call. Each item may use a different remote_dir. Use this for multi-file and multi-folder workflows.",
    {
      uploads: z.array(z.object({
        local_path: z.string().describe("Absolute path to the local file OR local directory on your computer. Examples: 'C:/Users/name/image.png', 'C:/Users/name/docs/report.pdf', 'C:/Users/name/my_folder'"),
        remote_dir: z.string().describe("Destination directory on cPanel. Examples: '/home/user/public_html', '/home/user/public_html/images', '/home/user/private/backups'. If local_path is a directory, all nested files are uploaded under this destination while preserving subfolder structure."),
        overwrite: z.boolean().optional().describe("Set true to overwrite existing remote files that have the same name in the destination. Set false or omit to keep default cPanel behavior."),
      })).min(1).describe("One or more upload tasks. Each task may target a different remote_dir, so you can upload multiple files to multiple different folders in a single tool call."),
    },
    async ({ uploads }) =>
      handleToolCall(async () => runUploads(uploads))
  );

  server.tool(
    "extract_archive",
    "Extract a ZIP or TAR archive on cPanel into a target directory.",
    {
      path: z.string().describe("Full path to the archive file. Example: '/home/username/public_html/site.zip' or '/home/username/backups/app.tar.gz'."),
      extract_to: z.string().describe("Directory where the archive should be extracted. Example: '/home/username/public_html/site' or '/home/username/public_html'.")
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
    "Change CHMOD permissions for a file or directory on cPanel.",
    {
      path: z.string().describe("Full path to the file or directory. Example: '/home/username/public_html/script.sh' or '/home/username/public_html/storage'."),
      permissions: z.string().describe("New permissions in octal format. Example: '0644', '0755', or '0777'.")
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
