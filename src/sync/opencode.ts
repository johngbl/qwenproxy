import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup } from "./utils.ts";

function buildOpenCodeProviderObject(baseUrl: string, apiKey: string): Record<string, any> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "QwenProxy",
    options: {
      baseURL: baseUrl,
      apiKey: apiKey,
    },
    models: {
      "qwen3.8-max": {
        name: "Qwen 3.8 Max",
        limit: { context: 1048576, output: 65536 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning: true,
        variants: {
          low: { effort: "low" },
          medium: { effort: "medium" },
          high: { effort: "high" },
          max: { effort: "max" },
        },
      },
      "qwen3.7-plus": {
        name: "Qwen 3.7 Plus",
        limit: { context: 1048576, output: 65536 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning: true,
        variants: {
          low: { effort: "low" },
          medium: { effort: "medium" },
          high: { effort: "high" },
        },
      },
    },
  };
}

export function syncOpenCode(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let content = "";

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      content = fs.readFileSync(filePath, "utf-8");
    }

    const providerObj = buildOpenCodeProviderObject(baseUrl, apiKey);
    const providerJson = JSON.stringify(providerObj, null, 6)
      .split("\n")
      .map((line, idx) => (idx === 0 ? line : "    " + line))
      .join("\n");

    const qwenEntry = `    "qwenproxy": ${providerJson}`;

    if (!content.trim()) {
      const initial = {
        $schema: "https://opencode.ai/config.json",
        provider: {
          qwenproxy: providerObj,
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
    } else {
      // Check if "qwenproxy" already exists under "provider"
      const existingQwenRegex = /"qwenproxy"\s*:\s*\{[\s\S]*?\n\s*\},?/m;
      if (existingQwenRegex.test(content)) {
        content = content.replace(existingQwenRegex, `"qwenproxy": ${providerJson},`);
      } else {
        const providerMatch = content.match(/"provider"\s*:\s*\{/);
        if (providerMatch && providerMatch.index !== undefined) {
          const insertIdx = providerMatch.index + providerMatch[0].length;
          content =
            content.slice(0, insertIdx) +
            "\n" +
            qwenEntry +
            "," +
            content.slice(insertIdx);
        } else {
          // If no "provider" object exists, add it before the final closing brace
          const lastBraceIdx = content.lastIndexOf("}");
          if (lastBraceIdx !== -1) {
            const comma = content.slice(0, lastBraceIdx).trimEnd().endsWith("{") ? "" : ",";
            content =
              content.slice(0, lastBraceIdx).trimEnd() +
              `${comma}\n  "provider": {\n${qwenEntry}\n  }\n}\n`;
          }
        }
      }
      fs.writeFileSync(filePath, content, "utf-8");
    }

    return {
      client: "opencode",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured OpenCode with provider qwenproxy (${baseUrl})`,
    };
  } catch (err: any) {
    return {
      client: "opencode",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreOpenCode(filePath: string, backupPath?: string): ClientSyncResult {
  const restored = restoreFromBackup(filePath, backupPath);
  return {
    client: "opencode",
    filePath,
    backupPath,
    success: restored,
    action: restored ? "restored" : "failed",
    message: restored ? "Restored OpenCode config from backup" : "Backup file not found",
  };
}
