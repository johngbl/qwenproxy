import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup } from "./utils.ts";

function buildOmpProviderYaml(baseUrl: string, apiKey: string): string {
  return `  qwenproxy:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: "${apiKey}"
    compat:
      supportsStore: true
      supportsReasoningEffort: true
      maxTokensField: max_completion_tokens
    models:
      - id: qwen3.8-max
        name: Qwen3.8-Max
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 131072
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high, max]
      - id: qwen3.7-plus
        name: Qwen3.7-Plus
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 131072
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high, max]
`;
}

export function syncOmp(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let content = "";

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      content = fs.readFileSync(filePath, "utf-8");
    }

    const providerBlock = buildOmpProviderYaml(baseUrl, apiKey);

    if (!content.trim()) {
      content = `providers:\n${providerBlock}`;
    } else {
      // Check if "qwenproxy:" already exists under "providers:"
      const existingQwenRegex = /^ {2}qwenproxy:[\s\S]*?(?=(?:^ {2}[a-zA-Z0-9_-]+:|\Z))/m;
      if (existingQwenRegex.test(content)) {
        content = content.replace(existingQwenRegex, providerBlock);
      } else {
        const providersMatch = content.match(/^providers:\s*$/m);
        if (providersMatch && providersMatch.index !== undefined) {
          const insertIdx = providersMatch.index + providersMatch[0].length;
          content =
            content.slice(0, insertIdx) +
            "\n" +
            providerBlock +
            content.slice(insertIdx);
        } else {
          content = content.trimEnd() + "\n\nproviders:\n" + providerBlock;
        }
      }
    }

    fs.writeFileSync(filePath, content.trimEnd() + "\n", "utf-8");

    return {
      client: "omp",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured OMP with provider qwenproxy (${baseUrl})`,
    };
  } catch (err: any) {
    return {
      client: "omp",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreOmp(filePath: string, backupPath?: string): ClientSyncResult {
  const restored = restoreFromBackup(filePath, backupPath);
  return {
    client: "omp",
    filePath,
    backupPath,
    success: restored,
    action: restored ? "restored" : "failed",
    message: restored ? "Restored OMP models config from backup" : "Backup file not found",
  };
}
