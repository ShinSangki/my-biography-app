import fs from "node:fs";
import path from "node:path";
import mime from "mime-types";

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function toAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(process.cwd(), filePath);
}

export function toRelativePath(filePath: string): string {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function getMimeType(filePath: string): string {
  const detected = mime.lookup(filePath);
  if (detected) return detected;
  return "application/octet-stream";
}

export function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}