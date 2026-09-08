import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(packageRoot, "package.json");

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export function detectPackageManager(): PackageManager {
  const userAgent = process.env.npm_config_user_agent || "";
  if (userAgent.startsWith("bun")) return "bun";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";

  // Check which executable is actually running the script or installed in PATH
  const execPath = process.execPath.toLowerCase();
  if (execPath.includes("bun")) return "bun";

  // Check if installation path contains pnpm / bun / yarn markers
  const currentPath = packageRoot.toLowerCase();
  if (currentPath.includes(".pnpm") || currentPath.includes("pnpm")) return "pnpm";
  if (currentPath.includes(".bun") || currentPath.includes("bun")) return "bun";
  if (currentPath.includes("yarn")) return "yarn";

  return "npm";
}
export function getUpdateArgs(pm: PackageManager, packageName: string): { cmd: string; args: string[] } {
  switch (pm) {
    case "bun":
      return { cmd: "bun", args: ["add", "-g", `${packageName}@latest`] };
    case "pnpm":
      return { cmd: "pnpm", args: ["update", "-g", packageName] };
    case "yarn":
      return { cmd: "yarn", args: ["global", "upgrade", packageName] };
    case "npm":
    default:
      return { cmd: "npm", args: ["install", "-g", `${packageName}@latest`] };
  }
}

export function isNewerVersion(current: string, latest: string): boolean {
  const c = current.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
  const l = latest.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const cv = c[i] || 0;
    const lv = l[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

export async function runUpdateCommand(): Promise<void> {
  let pkg: any = { name: "qwenproxy-cli", version: "1.0.0" };
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch {}

  const currentVersion = pkg.version || "1.0.0";
  const packageName = pkg.name || "qwenproxy-cli";
  const pm = detectPackageManager();

  console.log(`\n📦 [QwenProxy] Versão local instalada: v${currentVersion}`);
  console.log(`⚙️ [QwenProxy] Gerenciador de pacotes detectado: ${pm}`);
  console.log(`🔍 [QwenProxy] Verificando se há novas versões de ${packageName} no npm registry...`);

  let latestVersion = "";
  try {
    const fullCmd = `npm view ${packageName} version`;
    const res = spawnSync(fullCmd, {
      encoding: "utf-8",
      shell: true,
      timeout: 10000,
    });
    latestVersion = res.stdout ? res.stdout.trim() : "";
  } catch {}

  if (!latestVersion) {
    console.warn("⚠️  [QwenProxy] Não foi possível consultar o registro online.");
    const manual = getUpdateArgs(pm, packageName);
    console.log(`👉 Você pode forçar a atualização manualmente com:\n   ${manual.cmd} ${manual.args.join(" ")}\n`);
    return;
  }

  console.log(`🌐 [QwenProxy] Versão mais recente disponível: v${latestVersion}`);

  if (!isNewerVersion(currentVersion, latestVersion)) {
    console.log(`\n✨ Você já está utilizando a versão mais recente (v${currentVersion})!\n`);
    return;
  }

  console.log(`\n🚀 Nova versão disponível: v${currentVersion} ➔ v${latestVersion}`);
  const { cmd, args } = getUpdateArgs(pm, packageName);
  console.log(`⏳ Atualizando globalmente via ${pm} (${cmd} ${args.join(" ")})...`);
  const fullUpdateCmd = `${cmd} ${args.join(" ")}`;
  const updateProc = spawnSync(fullUpdateCmd, {
    stdio: "inherit",
    shell: true,
  });
  if (updateProc.status === 0) {
    console.log(`\n✅ [QwenProxy] Atualizado com sucesso para a versão v${latestVersion}!`);
    console.log("👉 Digite 'qpx' para iniciar a nova versão.\n");
  } else {
    console.error(`\n❌ [QwenProxy] Falha ao atualizar automaticamente com ${cmd}.`);
    console.log(`👉 Tente executar manualmente:\n   ${cmd} ${args.join(" ")}\n`);
  }
}

// Execute if run directly via CLI runner, not when imported in unit tests
const isDirectRun =
  Boolean(process.argv[1]) &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith("update-cli.ts") ||
    process.argv[1].endsWith("update-cli.js"));

if (isDirectRun) {
  void runUpdateCommand();
}
