import { invoke } from "@tauri-apps/api/core";

export interface FileTreeEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface AttachmentPathInfo {
  name: string;
  path: string;
  kind: "file" | "directory";
  mimeType?: string | null;
}

export interface ImageAttachmentPayload {
  base64: string;
  mimeType: string;
}

export async function getHomeDir(): Promise<string> {
  return invoke("get_home_dir");
}

export async function saveExportedSessionFile(
  defaultFilename: string,
  contents: string,
): Promise<string | null> {
  return invoke("save_exported_session_file", { defaultFilename, contents });
}

export async function saveDownloadedFile(options: {
  defaultFilename: string;
  mimeType?: string | null;
  contentsText?: string | null;
  contentsBase64?: string | null;
}): Promise<string | null> {
  const { defaultFilename, mimeType, contentsText, contentsBase64 } = options;
  return invoke("save_downloaded_file", {
    defaultFilename,
    mimeType: mimeType ?? null,
    contentsText: contentsText ?? null,
    contentsBase64: contentsBase64 ?? null,
  });
}

export async function pathExists(path: string): Promise<boolean> {
  return invoke("path_exists", { path });
}

export async function listFilesForMentions(
  roots: string[],
  maxResults = 1500,
): Promise<string[]> {
  return invoke("list_files_for_mentions", { roots, maxResults });
}

export async function listDirectoryEntries(
  path: string,
): Promise<FileTreeEntry[]> {
  return invoke("list_directory_entries", { path });
}

export async function inspectAttachmentPaths(
  paths: string[],
): Promise<AttachmentPathInfo[]> {
  return invoke("inspect_attachment_paths", { paths });
}

export async function readImageAttachment(
  path: string,
): Promise<ImageAttachmentPayload> {
  return invoke("read_image_attachment", { path });
}
