/**
 * Unit tests for FileProtocolHandler [R-L3-04]
 * AC-L3-04-1: text preview
 * AC-L3-04-2: image preview
 * AC-L3-04-3: path traversal block
 * AC-L3-04-N1: blocked extension
 * AC-L3-04-N2: 10MB limit
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock node:fs/promises ---
const mockStat = vi.fn();
const mockReadFile = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    stat: mockStat,
    readFile: mockReadFile,
  },
  stat: mockStat,
  readFile: mockReadFile,
}));

const { FileProtocolHandler } = await import("../../src/main/file-protocol");

const CWD = path.resolve("/home/user/project");

describe("FileProtocolHandler validate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("AC-L3-04-3: Protocol traversal — rejects paths with ..", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate(`${CWD}/../secret.txt`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("traversal");
  });

  it("AC-L3-04-3: Protocol traversal — rejects encoded traversal", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate("/home/user/project/../../etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("AC-L3-04-N1: Protocol extension blocked — rejects .exe", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate(`${CWD}/malware.exe`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Extension");
  });

  it("AC-L3-04-N1: Protocol extension blocked — rejects .sh", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate(`${CWD}/script.sh`);
    expect(result.ok).toBe(false);
  });

  it("AC-L3-04-N1: Protocol extension blocked — rejects .bat", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate(`${CWD}/run.bat`);
    expect(result.ok).toBe(false);
  });

  it("accepts .txt within CWD", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate(`${CWD}/readme.txt`);
    expect(result.ok).toBe(true);
  });

  it("accepts .md within CWD", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate(`${CWD}/readme.md`);
    expect(result.ok).toBe(true);
  });

  it("accepts .png within CWD", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate(`${CWD}/image.png`);
    expect(result.ok).toBe(true);
  });

  it("accepts .svg within CWD", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate(`${CWD}/icon.svg`);
    expect(result.ok).toBe(true);
  });

  it("rejects path outside CWD scope", () => {
    const handler = new FileProtocolHandler(CWD);
    const result = handler.validate("/etc/passwd.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("scope");
  });
});

describe("FileProtocolHandler serve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("AC-L3-04-1: Preview text — serves text file with correct mime type", async () => {
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(Buffer.from("hello world"));

    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/readme.txt`);

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mimeType).toBe("text/plain");
      expect(result.data.toString()).toBe("hello world");
    }
  });

  it("AC-L3-04-1: Preview text — serves .md file", async () => {
    mockStat.mockResolvedValue({ size: 50 });
    mockReadFile.mockResolvedValue(Buffer.from("# Title"));

    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/readme.md`);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mimeType).toBe("text/markdown");
    }
  });

  it("AC-L3-04-2: Preview image — serves .png file with image/png", async () => {
    mockStat.mockResolvedValue({ size: 200 });
    mockReadFile.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic

    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/photo.png`);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mimeType).toBe("image/png");
    }
  });

  it("AC-L3-04-2: Preview image — serves .jpg file with image/jpeg", async () => {
    mockStat.mockResolvedValue({ size: 300 });
    mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic

    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/photo.jpg`);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mimeType).toBe("image/jpeg");
    }
  });

  it("AC-L3-04-N2: Preview size limit — rejects file > 10MB", async () => {
    mockStat.mockResolvedValue({ size: 11 * 1024 * 1024 });

    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/bigfile.txt`);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("10MB");
    }
  });

  it("AC-L3-04-N2: Preview size limit — allows file exactly at 10MB", async () => {
    mockStat.mockResolvedValue({ size: 10 * 1024 * 1024 });
    mockReadFile.mockResolvedValue(Buffer.alloc(10 * 1024 * 1024));

    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/exactsize.txt`);
    expect("error" in result).toBe(false);
  });

  it("AC-L3-04-3: Protocol traversal — serve rejects traversal path", async () => {
    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/../etc/passwd.txt`);
    expect("error" in result).toBe(true);
  });

  it("AC-L3-04-N1: Protocol extension blocked — serve rejects .exe", async () => {
    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/run.exe`);
    expect("error" in result).toBe(true);
  });

  it("returns error when file not found", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockStat.mockRejectedValue(err);

    const handler = new FileProtocolHandler(CWD);
    const result = await handler.serve(`${CWD}/missing.txt`);
    expect("error" in result).toBe(true);
  });

  it("setCwd updates scope for subsequent validation", () => {
    const handler = new FileProtocolHandler(CWD);
    const newCwd = path.resolve("/home/user/other");
    handler.setCwd(newCwd);
    const result = handler.validate(`${CWD}/readme.txt`);
    expect(result.ok).toBe(false); // old CWD path rejected
  });
});
