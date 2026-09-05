import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup } from "./utils.ts";

function updateTopLevelKey(content: string, key: string, value: string | number): string {
  // Find first section header [section]
  const firstSectionIdx = content.search(/^\[/m);
  const topPart = firstSectionIdx === -1 ? content : content.slice(0, firstSectionIdx);
  const restPart = firstSectionIdx === -1 ? "" : content.slice(firstSectionIdx);

  const formattedValue = typeof value === "string" ? `"${value}"` : String(value);
  const keyRegex = new RegExp(`^${key}\\s*=.*$`, "m");

  let newTopPart: string;
  if (keyRegex.test(topPart)) {
    newTopPart = topPart.replace(keyRegex, `${key} = ${formattedValue}`);
  } else {
    newTopPart = `${key} = ${formattedValue}\n` + topPart.trimStart();
  }

  return newTopPart + restPart;
}

export function syncCodex(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl, model = "qwen3.8-max", setActive = true } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let content = "";

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      content = fs.readFileSync(filePath, "utf-8");
    }

    // Build the qwenproxy model_provider block
    const providerBlock = `[model_providers.qwenproxy]
name = "QwenProxy"
base_url = "${baseUrl}"
wire_api = "responses"
experimental_bearer_token = "${apiKey}"
`;

    // Replace or append [model_providers.qwenproxy]
    const providerRegex = /\[model_providers\.qwenproxy\][\s\S]*?(?=(?:^\[|\Z))/m;
    if (providerRegex.test(content)) {
      content = content.replace(providerRegex, providerBlock);
    } else {
      content = content.trimEnd() + (content.length > 0 ? "\n\n" : "") + providerBlock;
    }

    // Set active model if requested
    if (setActive) {
      content = updateTopLevelKey(content, "model", model);
      content = updateTopLevelKey(content, "model_provider", "qwenproxy");
      content = updateTopLevelKey(content, "model_context_window", 1000000);
    }

    // If a custom model_catalog_json is configured, ensure the target model is listed in it
    const catalogMatch = content.match(/^model_catalog_json\s*=\s*["']([^"']+)["']/m);
    if (catalogMatch && catalogMatch[1]) {
      try {
        const rawCatalogPath = catalogMatch[1];
        const catalogPath = path.isAbsolute(rawCatalogPath)
          ? rawCatalogPath
          : path.resolve(path.dirname(filePath), rawCatalogPath);
        if (fs.existsSync(catalogPath)) {
          const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
          if (Array.isArray(catalog.models)) {
            const hasModel = catalog.models.some((m: any) => m?.slug === model);
            if (!hasModel) {
              const template = catalog.models[0] || {};
              catalog.models.unshift({
                ...template,
                slug: model,
                display_name: `Qwen (${model})`,
                description: `QwenProxy ${model} with 1,000,000 token context window`,
                context_window: 1000000,
                max_context_window: 1000000,
              });
              fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");
            }
          }
        }
      } catch {
        // Non-fatal catalog enhancement
      }
    }

    fs.writeFileSync(filePath, content.trimEnd() + "\n", "utf-8");

    return {
      client: "codex",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured Codex with provider qwenproxy (${baseUrl})`,
    };
  } catch (err: any) {
    return {
      client: "codex",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreCodex(filePath: string, backupPath?: string): ClientSyncResult {
  const restored = restoreFromBackup(filePath, backupPath);
  return {
    client: "codex",
    filePath,
    backupPath,
    success: restored,
    action: restored ? "restored" : "failed",
    message: restored ? "Restored Codex config from backup" : "Backup file not found",
  };
}
