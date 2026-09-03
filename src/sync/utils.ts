import fs from "node:fs";
import path from "node:path";

export function createTimestampBackup(filePath: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const backupPath = path.join(dir, `${base}.qwenproxy.${timestamp}${ext}.bak`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export function restoreFromBackup(filePath: string, backupPath?: string): boolean {
  if (!backupPath || !fs.existsSync(backupPath)) {
    return false;
  }
  fs.copyFileSync(backupPath, filePath);
  try {
    fs.unlinkSync(backupPath);
  } catch {
    // Ignore cleanup error
  }
  return true;
}
