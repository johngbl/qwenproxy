import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion = "";

export function getAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(currentDir, "../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) {
        cachedVersion = `v${pkg.version}`;
        return cachedVersion;
      }
    }
  } catch {}
  cachedVersion = "v1.6.2";
  return cachedVersion;
}
