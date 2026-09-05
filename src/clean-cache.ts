import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { pruneAllPlaywrightProfiles } from "./services/playwright.ts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function getDirStats(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  function walk(d: string) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          try {
            bytes += fs.statSync(full).size;
            files++;
          } catch {}
        }
      }
    } catch {}
  }
  walk(dir);
  return { bytes, files };
}

async function cleanPlaywrightBrowsers(cleanUnused: boolean): Promise<{
  activeBrowserDir: string | null;
  unusedDirs: { name: string; path: string; size: string; bytes: number }[];
  freedBytes: number;
}> {
  let activeBrowserDir: string | null = null;
  try {
    const execPath = chromium.executablePath();
    // E.g. C:\Users\...\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe
    // The browser folder is the first directory under ms-playwright
    const msPlaywrightDir = path.resolve(execPath, "..", "..", "..");
    const rel = path.relative(msPlaywrightDir, execPath);
    const topFolder = rel.split(path.sep)[0];
    activeBrowserDir = topFolder;
  } catch {}

  const msPlaywrightDir = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const unusedDirs: { name: string; path: string; size: string; bytes: number }[] = [];
  let freedBytes = 0;

  if (fs.existsSync(msPlaywrightDir)) {
    try {
      const entries = fs.readdirSync(msPlaywrightDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folderName = entry.name;
        // Keep active browser and critical tools like winldd/ffmpeg if needed
        if (folderName === activeBrowserDir) continue;
        if (folderName.startsWith("winldd") || folderName.startsWith(".links")) continue;

        const fullPath = path.join(msPlaywrightDir, folderName);
        const { bytes } = getDirStats(fullPath);
        if (bytes > 0) {
          unusedDirs.push({
            name: folderName,
            path: fullPath,
            size: formatBytes(bytes),
            bytes,
          });
        }
      }

      if (cleanUnused && unusedDirs.length > 0) {
        for (const item of unusedDirs) {
          try {
            fs.rmSync(item.path, { recursive: true, force: true });
            freedBytes += item.bytes;
          } catch (err) {
            console.warn(`[CleanCache] Warning: could not remove ${item.name}:`, err);
          }
        }
      }
    } catch (err) {
      console.warn("[CleanCache] Error reading ms-playwright directory:", err);
    }
  }

  return { activeBrowserDir, unusedDirs, freedBytes };
}

async function main() {
  const args = process.argv.slice(2);
  const cleanAll = args.includes("--all") || args.includes("--browsers");

  console.log("==================================================");
  console.log("  [QwenProxy] Cache & Storage Optimization Tool");
  console.log("==================================================\n");

  // 1. Profile Transient Cache Pruning (V8 Code Cache, GPU Cache)
  console.log("1. Limpando caches transitórios dos perfis (data/qwen_profiles/)...");
  const profileResult = pruneAllPlaywrightProfiles();
  if (profileResult.totalFreedFiles > 0) {
    console.log(
      `   [OK] Perfis limpos com sucesso!`,
    );
    console.log(
      `   Espaço liberado: ${formatBytes(profileResult.totalFreedBytes)} em ${profileResult.totalFreedFiles} arquivos (${profileResult.profilesCleaned} perfil(is)).`,
    );
    console.log(
      `   (Todos os cookies, sessões e logins foram 100% preservados!)`,
    );
  } else {
    console.log("   [OK] Nenhum cache transitório acumulado nos perfis.");
  }
  console.log("");

  // 2. Playwright Browser Binaries Cleanup
  console.log("2. Inspecionando diretório global do Playwright (ms-playwright)...");
  const browserResult = await cleanPlaywrightBrowsers(cleanAll);

  if (browserResult.activeBrowserDir) {
    console.log(`   Navegador ativo em uso pelo QwenProxy: ${browserResult.activeBrowserDir}`);
  }

  if (browserResult.unusedDirs.length > 0) {
    const totalReclaimable = browserResult.unusedDirs.reduce((acc, d) => acc + d.bytes, 0);

    if (cleanAll) {
      console.log(`   [OK] ${browserResult.unusedDirs.length} navegador(es) não utilizado(s) removido(s):`);
      for (const d of browserResult.unusedDirs) {
        console.log(`     - ${d.name} (${d.size})`);
      }
      console.log(`   Total recuperado no SSD: ${formatBytes(browserResult.freedBytes)}!`);
    } else {
      console.log(`   [INFO] Encontrados ${browserResult.unusedDirs.length} navegador(es) legados/não utilizados no seu SSD:`);
      for (const d of browserResult.unusedDirs) {
        console.log(`     - ${d.name} (${d.size})`);
      }
      console.log(`   Espaço recuperável no SSD: ${formatBytes(totalReclaimable)}.`);
      console.log(`   Para liberar esse espaço automaticamente, execute:`);
      console.log(`   npm run clean:all\n`);
    }
  } else {
    console.log("   [OK] O diretório do Playwright já está enxuto (sem navegadores órfãos).\n");
  }

  console.log("==================================================");
  console.log("  Otimização concluída com segurança!");
  console.log("==================================================\n");
}

main().catch((err) => {
  console.error("[CleanCache] Erro fatal durante a limpeza:", err);
  process.exit(1);
});
