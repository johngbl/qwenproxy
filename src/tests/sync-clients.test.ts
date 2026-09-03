import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  syncClaudeCode,
  restoreClaudeCode,
} from "../sync/claude-code.ts";
import {
  syncCodex,
  restoreCodex,
} from "../sync/codex.ts";
import {
  syncOpenCode,
  restoreOpenCode,
} from "../sync/opencode.ts";
import {
  syncOmp,
  restoreOmp,
} from "../sync/omp.ts";
import {
  syncAllClients,
  restoreAllClients,
  resolveApiKey,
  resolveBaseUrls,
} from "../sync/index.ts";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwenproxy-sync-test-"));
}

test("sync: resolveApiKey returns configured key, env API_KEY, or falls back to sk-qwenproxy-local", () => {
  assert.equal(resolveApiKey("custom-key", ""), "custom-key");
  assert.equal(resolveApiKey(undefined, "env-admin-key"), "env-admin-key");

  const originalEnvKey = process.env.API_KEY;
  try {
    process.env.API_KEY = "from-env-file";
    assert.equal(resolveApiKey(undefined, ""), "from-env-file");
  } finally {
    if (originalEnvKey !== undefined) {
      process.env.API_KEY = originalEnvKey;
    } else {
      delete process.env.API_KEY;
    }
  }

  assert.equal(resolveApiKey(undefined, ""), "sk-qwenproxy-local");
  assert.equal(resolveApiKey(undefined, undefined), "sk-qwenproxy-local");
});

test("sync: resolveBaseUrls computes correct URLs for Anthropic and OpenAI protocols", () => {
  const urls = resolveBaseUrls(3000, "127.0.0.1");
  assert.equal(urls.anthropicBaseUrl, "http://127.0.0.1:3000");
  assert.equal(urls.openaiBaseUrl, "http://127.0.0.1:3000/v1");
});

test("sync Claude Code: preserves existing settings, adds QwenProxy env, and restores cleanly", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "settings.json");

  const originalSettings = {
    hooks: {
      SessionStart: [{ command: "echo start" }],
    },
    statusLine: { showTurnTime: true },
    skipDangerousModePermissionPrompt: true,
    env: {
      EXISTING_VAR: "preserve-me",
    },
    model: "previous-model",
  };
  fs.writeFileSync(filePath, JSON.stringify(originalSettings, null, 2), "utf-8");

  // Perform sync
  const res = syncClaudeCode({
    filePath,
    apiKey: "test-token",
    baseUrl: "http://127.0.0.1:3000",
    model: "qwen3.8-max",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updated = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  // Existing settings preserved
  assert.deepEqual(updated.hooks, originalSettings.hooks);
  assert.equal(updated.statusLine.showTurnTime, true);
  assert.equal(updated.skipDangerousModePermissionPrompt, true);
  assert.equal(updated.env.EXISTING_VAR, "preserve-me");

  // QwenProxy settings injected
  assert.equal(updated.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3000");
  assert.equal(updated.env.ANTHROPIC_AUTH_TOKEN, "test-token");
  assert.equal(updated.env.ANTHROPIC_MODEL, "qwen3.8-max");
  assert.equal(updated.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
  assert.equal(updated.model, "qwen3.8-max");

  // Restore
  const restored = restoreClaudeCode(filePath, res.backupPath);
  assert.equal(restored.success, true);

  const afterRestore = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.deepEqual(afterRestore, originalSettings);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync Codex: preserves other providers and projects, adds qwenproxy provider, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "config.toml");

  const originalToml = `model = "gemini-3.8-flash"
model_provider = "cpa-gui"

[projects.'c:\\users\\john\\repo']
trust_level = "trusted"

[model_providers.cpa-gui]
name = "EasyCLIProxyAPI"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
experimental_bearer_token = "123456"
`;
  fs.writeFileSync(filePath, originalToml, "utf-8");

  const res = syncCodex({
    filePath,
    apiKey: "sk-qwen-key",
    baseUrl: "http://127.0.0.1:3000/v1",
    model: "qwen3.8-max",
    setActive: true,
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updated = fs.readFileSync(filePath, "utf-8");
  // Existing sections preserved
  assert.ok(updated.includes("[projects.'c:\\users\\john\\repo']"));
  assert.ok(updated.includes("[model_providers.cpa-gui]"));
  assert.ok(updated.includes('base_url = "http://127.0.0.1:8317/v1"'));

  // QwenProxy section injected
  assert.ok(updated.includes("[model_providers.qwenproxy]"));
  assert.ok(updated.includes('base_url = "http://127.0.0.1:3000/v1"'));
  assert.ok(updated.includes('experimental_bearer_token = "sk-qwen-key"'));
  assert.ok(updated.includes('wire_api = "responses"'));
  assert.ok(updated.includes('model_provider = "qwenproxy"'));
  assert.ok(updated.includes('model = "qwen3.8-max"'));
  assert.ok(updated.includes("model_context_window = 1000000"));

  // Restore
  const restored = restoreCodex(filePath, res.backupPath);
  assert.equal(restored.success, true);
  assert.equal(fs.readFileSync(filePath, "utf-8"), originalToml);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync OpenCode: preserves comments and sibling providers, adds qwenproxy, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "opencode.jsonc");

  const originalJsonc = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    // Existing custom provider
    "antigravity": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antigravity",
      "options": {
        "baseURL": "http://127.0.0.1:8317/v1",
        "apiKey": "sk-secret"
      },
      "models": {
        "gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash",
          "limit": { "context": 1048576, "output": 65536 }
        }
      }
    }
  }
}
`;
  fs.writeFileSync(filePath, originalJsonc, "utf-8");

  const res = syncOpenCode({
    filePath,
    apiKey: "sk-test",
    baseUrl: "http://127.0.0.1:3000/v1",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updated = fs.readFileSync(filePath, "utf-8");
  // Comments and existing provider preserved
  assert.ok(updated.includes("// Existing custom provider"));
  assert.ok(updated.includes('"antigravity": {'));
  assert.ok(updated.includes('"baseURL": "http://127.0.0.1:8317/v1"'));

  // QwenProxy injected
  assert.ok(updated.includes('"qwenproxy": {'));
  assert.ok(updated.includes('"baseURL": "http://127.0.0.1:3000/v1"'));
  assert.ok(updated.includes('"apiKey": "sk-test"'));
  assert.ok(updated.includes('"qwen3.8-max": {'));
  assert.ok(updated.includes('"qwen3.7-plus": {'));

  // Restore
  const restored = restoreOpenCode(filePath, res.backupPath);
  assert.equal(restored.success, true);
  assert.equal(fs.readFileSync(filePath, "utf-8"), originalJsonc);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync OMP: preserves other YAML providers and config, adds qwenproxy, and restores", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "models.yml");

  const originalYaml = `providers:
  antigravity:
    baseUrl: http://127.0.0.1:8317/v1
    api: openai-completions
    apiKey: "sk-antigravity"
    models:
      - id: gemini-3.8-flash-high
        name: Gemini 3.8 Flash
        input: [text, image]
        contextWindow: 1048576

  bai:
    baseUrl: https://api.b.ai/v1
    api: openai-completions
    apiKey: "sk-bai"
    models:
      - id: deepseek-v4-flash
        name: DeepSeek-V4-Flash
        contextWindow: 1000000
`;
  fs.writeFileSync(filePath, originalYaml, "utf-8");

  const res = syncOmp({
    filePath,
    apiKey: "sk-qwen-omp",
    baseUrl: "http://127.0.0.1:3000/v1",
  });

  assert.equal(res.success, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));

  const updated = fs.readFileSync(filePath, "utf-8");
  // Existing providers preserved
  assert.ok(updated.includes("antigravity:"));
  assert.ok(updated.includes("baseUrl: http://127.0.0.1:8317/v1"));
  assert.ok(updated.includes("bai:"));
  assert.ok(updated.includes("baseUrl: https://api.b.ai/v1"));

  // QwenProxy injected
  assert.ok(updated.includes("qwenproxy:"));
  assert.ok(updated.includes("baseUrl: http://127.0.0.1:3000/v1"));
  assert.ok(updated.includes('apiKey: "sk-qwen-omp"'));
  assert.ok(updated.includes("- id: qwen3.8-max"));
  assert.ok(updated.includes("- id: qwen3.7-plus"));
  assert.ok(updated.includes("contextWindow: 1000000"));

  // Restore
  const restored = restoreOmp(filePath, res.backupPath);
  assert.equal(restored.success, true);
  assert.equal(fs.readFileSync(filePath, "utf-8"), originalYaml);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("syncAllClients: orchestrates discovery and records state file for rollback", () => {
  const tmp = createTempDir();
  const claudePath = path.join(tmp, ".claude", "settings.json");
  const codexPath = path.join(tmp, ".codex", "config.toml");
  const opencodePath = path.join(tmp, ".config", "opencode", "opencode.jsonc");
  const ompPath = path.join(tmp, ".omp", "agent", "models.yml");
  const statePath = path.join(tmp, "sync-state.json");

  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
  fs.mkdirSync(path.dirname(ompPath), { recursive: true });

  fs.writeFileSync(claudePath, JSON.stringify({ env: {}, model: "old" }), "utf-8");
  fs.writeFileSync(codexPath, `model = "old"\n[model_providers.other]\nbase_url = "http://old"`, "utf-8");
  fs.writeFileSync(opencodePath, `{\n  "provider": {}\n}`, "utf-8");
  fs.writeFileSync(ompPath, `providers:\n  other:\n    baseUrl: http://old\n`, "utf-8");

  const syncResult = syncAllClients({
    stateFilePath: statePath,
    customPaths: {
      claudeCode: claudePath,
      codex: codexPath,
      openCode: opencodePath,
      omp: ompPath,
    },
    apiKey: "sk-all-sync",
    port: 3000,
  });

  assert.equal(syncResult.clients.claudeCode?.success, true);
  assert.equal(syncResult.clients.codex?.success, true);
  assert.equal(syncResult.clients.openCode?.success, true);
  assert.equal(syncResult.clients.omp?.success, true);
  assert.ok(fs.existsSync(statePath));

  // Verify all modified files have qwenproxy
  assert.ok(fs.readFileSync(claudePath, "utf-8").includes("qwen3.8-max"));
  assert.ok(fs.readFileSync(codexPath, "utf-8").includes("qwenproxy"));
  assert.ok(fs.readFileSync(opencodePath, "utf-8").includes("qwenproxy"));
  assert.ok(fs.readFileSync(ompPath, "utf-8").includes("qwenproxy"));

  // Restore via state file
  const restoreResult = restoreAllClients({ stateFilePath: statePath });
  assert.equal(restoreResult.restoredCount, 4);

  // Original state restored
  assert.equal(JSON.parse(fs.readFileSync(claudePath, "utf-8")).model, "old");
  assert.ok(!fs.readFileSync(codexPath, "utf-8").includes("qwenproxy"));
  assert.ok(!fs.readFileSync(opencodePath, "utf-8").includes("qwenproxy"));
  assert.ok(!fs.readFileSync(ompPath, "utf-8").includes("qwenproxy"));

  fs.rmSync(tmp, { recursive: true, force: true });
});
