import fs from "node:fs";
import path from "node:path";
import type { ClientSyncResult, SyncOptions } from "./types.ts";
import { createTimestampBackup, restoreFromBackup } from "./utils.ts";

export function syncClaudeCode(options: SyncOptions): ClientSyncResult {
  const { filePath, apiKey, baseUrl, model = "qwen3.8-max" } = options;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let backupPath: string | undefined;
    let existingSettings: Record<string, any> = {};

    if (fs.existsSync(filePath)) {
      backupPath = createTimestampBackup(filePath);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        existingSettings = JSON.parse(content);
      } catch {
        existingSettings = {};
      }
    }

    const env = {
      ...(existingSettings.env || {}),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_CUSTOM_MODEL_OPTION: model,
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Qwen 3.8 Max (1M Context)",
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "QwenProxy model qwen3.8-max - 1M context window",
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    };

    const updatedSettings = {
      ...existingSettings,
      env,
      model,
    };

    fs.writeFileSync(filePath, JSON.stringify(updatedSettings, null, 2) + "\n", "utf-8");

    return {
      client: "claude-code",
      filePath,
      backupPath,
      success: true,
      action: backupPath ? "updated" : "created",
      message: `Configured Claude Code with model ${model} and baseUrl ${baseUrl}`,
    };
  } catch (err: any) {
    return {
      client: "claude-code",
      filePath,
      success: false,
      action: "failed",
      error: err?.message || String(err),
    };
  }
}

export function restoreClaudeCode(filePath: string, backupPath?: string): ClientSyncResult {
  const restored = restoreFromBackup(filePath, backupPath);
  return {
    client: "claude-code",
    filePath,
    backupPath,
    success: restored,
    action: restored ? "restored" : "failed",
    message: restored ? "Restored Claude Code settings from backup" : "Backup file not found",
  };
}
