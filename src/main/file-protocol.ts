/**
 * FileProtocolHandler — T10 implementation.
 * Validates and serves files via ezterm-file:// protocol.
 *
 * Security rules:
 * - CWD scope: resolved path must start with current CWD
 * - Extension whitelist: .txt .md .json .js .ts .html .css .png .jpg .jpeg .gif .svg
 * - 10 MB size limit
 * - Path traversal: reject paths containing ".." after normalization
 */

import fs from "node:fs/promises";
import path from "node:path";

const ALLOWED_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".js",
  ".ts",
  ".html",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
]);

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export type ValidateResult = { ok: true; filePath: string } | { ok: false; reason: string };

export class FileProtocolHandler {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  setCwd(newCwd: string): void {
    this.cwd = newCwd;
  }

  validate(rawPath: string): ValidateResult {
    // Check for ".." in the raw path (path traversal)
    if (rawPath.includes("..")) {
      return { ok: false, reason: "Path traversal rejected" };
    }

    const ext = path.extname(rawPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { ok: false, reason: `Extension not allowed: ${ext}` };
    }

    const resolved = path.resolve(rawPath);
    const normalizedCwd = path.resolve(this.cwd);

    // Check CWD scope
    if (!resolved.startsWith(normalizedCwd + path.sep) && resolved !== normalizedCwd) {
      return { ok: false, reason: "Path outside CWD scope" };
    }

    return { ok: true, filePath: resolved };
  }

  async serve(rawPath: string): Promise<{ data: Buffer; mimeType: string } | { error: string }> {
    const validation = this.validate(rawPath);
    if (!validation.ok) {
      return { error: validation.reason };
    }

    const filePath = validation.filePath;

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return { error: "File not found" };
    }

    if (stat.size > MAX_SIZE) {
      return { error: `File exceeds 10MB limit: ${stat.size}` };
    }

    let data: Buffer;
    try {
      data = await fs.readFile(filePath);
    } catch {
      return { error: "Failed to read file" };
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = getMimeType(ext);

    return { data, mimeType };
  }
}

function getMimeType(ext: string): string {
  switch (ext) {
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".js":
      return "application/javascript";
    case ".ts":
      return "application/typescript";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
