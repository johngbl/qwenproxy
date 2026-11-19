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

export function findLatestBackup(filePath: string): string | undefined {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  if (!fs.existsSync(dir)) return undefined;

  try {
    const files = fs.readdirSync(dir);
    const candidates = files
      .filter((f) => f.startsWith(base) && f.includes("qwenproxy") && f.endsWith(".bak"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });

    return candidates[0];
  } catch {
    return undefined;
  }
}

export function restoreFromBackup(filePath: string, backupPath?: string): boolean {
  const targetBackup = (backupPath && fs.existsSync(backupPath))
    ? backupPath
    : findLatestBackup(filePath);

  if (!targetBackup || !fs.existsSync(targetBackup)) {
    return false;
  }
  fs.copyFileSync(targetBackup, filePath);
  try {
    fs.unlinkSync(targetBackup);
  } catch {
    // Ignore cleanup error
  }
  return true;
}

/**
 * Format internal model slug to clean human-readable display name without bulky suffixes.
 * E.g. "qwen3.8-max" -> "Qwen 3.8 Max", "qwen3.8-omni-flash" -> "Qwen 3.8 Omni Flash"
 */
export function formatModelDisplayName(model: string): string {
  if (model === "qwen4-max") return "Qwen 4 Max";
  if (model === "qwen3.8-max") return "Qwen 3.8 Max";
  if (model === "qwen3.8-omni-flash") return "Qwen 3.8 Omni Flash";
  if (model === "qwen3.7-plus") return "Qwen 3.7 Plus";
  if (model === "qwen3.6-plus") return "Qwen 3.6 Plus";
  return model
    .replace(/^qwen/i, "Qwen ")
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
