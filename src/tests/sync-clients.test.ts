import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
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
  inspectClientSyncStatus,
} from "../sync/index.ts";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwenproxy-sync-test-"));
}

test("sync: resolveApiKey returns configured key or env API_KEY and rejects placeholder", () => {
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

  assert.throws(
    () => resolveApiKey(undefined, ""),
    /placeholder API key/,
  );
  assert.throws(
    () => resolveApiKey("sk-qwenproxy-local", ""),
    /placeholder API key/,
  );
});

test("sync: resolveBaseUrls computes correct URLs for Anthropic and OpenAI protocols", () => {
  const defaultUrls = resolveBaseUrls();
  assert.equal(defaultUrls.anthropicBaseUrl, "http://127.0.0.1:7936");
  assert.equal(defaultUrls.openaiBaseUrl, "http://127.0.0.1:7936/v1");

  const customUrls = resolveBaseUrls(8080, "127.0.0.1");
  assert.equal(customUrls.anthropicBaseUrl, "http://127.0.0.1:8080");
  assert.equal(customUrls.openaiBaseUrl, "http://127.0.0.1:8080/v1");
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
  assert.equal(updated.env.CLAUDE_CODE_DISABLE_ARTIFACT, "1");
  assert.equal(updated.enableArtifact, false);
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
  const hermesPath = path.join(tmp, ".hermes", "config.yaml");
  const openclawPath = path.join(tmp, ".openclaw", "openclaw.json");
  const kiloPath = path.join(tmp, ".kilo", "kilo.json");
  const clinePath = path.join(tmp, "state.vscdb");
  const zedPath = path.join(tmp, "zed-settings.json");
  const aiderPath = path.join(tmp, ".aider.conf.yml");
  const statePath = path.join(tmp, "sync-state.json");

  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
  fs.mkdirSync(path.dirname(ompPath), { recursive: true });
  fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
  fs.mkdirSync(path.dirname(openclawPath), { recursive: true });
  fs.mkdirSync(path.dirname(kiloPath), { recursive: true });
  fs.mkdirSync(path.dirname(zedPath), { recursive: true });
  fs.mkdirSync(path.dirname(aiderPath), { recursive: true });

  const dbInit = new Database(clinePath);
  dbInit.exec(`CREATE TABLE ItemTable (key TEXT, value TEXT)`);
  dbInit.close();
  fs.writeFileSync(claudePath, JSON.stringify({ env: {}, model: "old" }), "utf-8");
  fs.writeFileSync(codexPath, `model = "old"\n[model_providers.other]\nbase_url = "http://old"`, "utf-8");
  fs.writeFileSync(opencodePath, `{\n  "provider": {}\n}`, "utf-8");
  fs.writeFileSync(ompPath, `providers:\n  other:\n    baseUrl: http://old\n`, "utf-8");
  fs.writeFileSync(hermesPath, `model:\n  default: "old"\n`, "utf-8");
  fs.writeFileSync(openclawPath, `{\n  "models": {}\n}`, "utf-8");
  fs.writeFileSync(kiloPath, `{\n  "provider": {}\n}`, "utf-8");
  fs.writeFileSync(zedPath, `{\n  "language_models": {}\n}`, "utf-8");
  fs.writeFileSync(aiderPath, `model: old\n`, "utf-8");

  const syncResult = syncAllClients({
    stateFilePath: statePath,
    customPaths: {
      claudeCode: claudePath,
      codex: codexPath,
      openCode: opencodePath,
      omp: ompPath,
      hermes: hermesPath,
      openClaw: openclawPath,
      kilo: kiloPath,
      cline: clinePath,
      zed: zedPath,
      aider: aiderPath,
    },
    apiKey: "sk-all-sync",
    port: 3000,
  });

  assert.equal(syncResult.clients.claudeCode?.success, true);
  assert.equal(syncResult.clients.codex?.success, true);
  assert.equal(syncResult.clients.openCode?.success, true);
  assert.equal(syncResult.clients.omp?.success, true);
  assert.equal(syncResult.clients.hermes?.success, true);
  assert.equal(syncResult.clients.openClaw?.success, true);
  assert.equal(syncResult.clients.kilo?.success, true);
  assert.equal(syncResult.clients.cline?.success, true);
  assert.equal(syncResult.clients.zed?.success, true);
  assert.equal(syncResult.clients.aider?.success, true);
  assert.ok(fs.existsSync(statePath));

  // Verify modified files have qwenproxy
  assert.ok(fs.readFileSync(claudePath, "utf-8").includes("qwen3.8-max"));
  assert.ok(fs.readFileSync(codexPath, "utf-8").includes("qwenproxy"));
  assert.ok(fs.readFileSync(opencodePath, "utf-8").includes("qwenproxy"));
  assert.ok(fs.readFileSync(ompPath, "utf-8").includes("qwenproxy"));
  assert.ok(fs.readFileSync(hermesPath, "utf-8").includes("qwenproxy"));
  assert.ok(fs.readFileSync(openclawPath, "utf-8").includes("qwenproxy"));
  assert.ok(fs.readFileSync(kiloPath, "utf-8").includes("qwenproxy"));
  assert.ok(fs.readFileSync(zedPath, "utf-8").includes("QwenProxy"));
  assert.ok(fs.readFileSync(aiderPath, "utf-8").includes("qwen3.8-max"));

  // Restore via state file
  const restoreResult = restoreAllClients({ stateFilePath: statePath });
  assert.equal(restoreResult.restoredCount, 10);

  // Original state restored
  assert.equal(JSON.parse(fs.readFileSync(claudePath, "utf-8")).model, "old");
  assert.ok(!fs.readFileSync(codexPath, "utf-8").includes("qwenproxy"));
  assert.ok(!fs.readFileSync(opencodePath, "utf-8").includes("qwenproxy"));
  assert.ok(!fs.readFileSync(ompPath, "utf-8").includes("qwenproxy"));

  fs.rmSync(tmp, { recursive: true, force: true });
});
test("syncAllClients: respects targets filter to sync only selected clients", () => {
  const tmp = createTempDir();
  const claudePath = path.join(tmp, ".claude", "settings.json");
  const codexPath = path.join(tmp, ".codex", "config.toml");

  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });

  fs.writeFileSync(claudePath, JSON.stringify({ env: {}, model: "old" }), "utf-8");
  fs.writeFileSync(codexPath, `model = "old"\n`, "utf-8");

  const syncResult = syncAllClients({
    targets: ["claude-code"],
    customPaths: {
      claudeCode: claudePath,
      codex: codexPath,
    },
    apiKey: "sk-targeted",
  });

  assert.ok(syncResult.clients.claudeCode);
  assert.equal(syncResult.clients.claudeCode.success, true);
  assert.equal(syncResult.clients.codex, undefined);
  assert.equal(syncResult.clients.openCode, undefined);
  assert.equal(syncResult.clients.omp, undefined);

  // Claude Code is updated, Codex remains untouched
  assert.ok(fs.readFileSync(claudePath, "utf-8").includes("qwen3.8-max"));
  assert.equal(fs.readFileSync(codexPath, "utf-8"), `model = "old"\n`);

  fs.rmSync(tmp, { recursive: true, force: true });
});
test("inspectClientSyncStatus correctly determines installed and synced states", () => {
  const tmp = createTempDir();
  const claudePath = path.join(tmp, "claude-settings.json");
  const codexPath = path.join(tmp, "codex-config.toml");

  // Missing file
  assert.deepEqual(inspectClientSyncStatus("claude-code", claudePath), {
    id: "claude-code",
    installed: false,
    synced: false,
  });

  // Installed with other provider
  fs.writeFileSync(claudePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, model: "claude-3" }), "utf-8");
  const otherStatus = inspectClientSyncStatus("claude-code", claudePath);
  assert.equal(otherStatus.installed, true);
  assert.equal(otherStatus.synced, false);

  // Synced with QwenProxy
  fs.writeFileSync(claudePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:7936", ANTHROPIC_MODEL: "qwen3.8-max" } }), "utf-8");
  const syncedStatus = inspectClientSyncStatus("claude-code", claudePath);
  assert.equal(syncedStatus.installed, true);
  assert.equal(syncedStatus.synced, true);
  assert.equal(syncedStatus.model, "qwen3.8-max");

  // Codex synced
  fs.writeFileSync(codexPath, `model = "qwen3.8-max"\nmodel_provider = "qwenproxy"\n\n[model_providers.qwenproxy]\nbase_url = "http://127.0.0.1:7936/v1"\n`, "utf-8");
  const codexSynced = inspectClientSyncStatus("codex", codexPath);
  assert.equal(codexSynced.installed, true);
  assert.equal(codexSynced.synced, true);
  assert.equal(codexSynced.model, "qwen3.8-max");

  // Codex pointing to another external URL must NOT be considered synced
  fs.writeFileSync(codexPath, `model = "qwen3.8-max"\nmodel_provider = "qwenproxy"\n\n[model_providers.qwenproxy]\nbase_url = "https://ai.external.net/v1"\n`, "utf-8");
  const codexOtherUrl = inspectClientSyncStatus("codex", codexPath);
  assert.equal(codexOtherUrl.installed, true);
  assert.equal(codexOtherUrl.synced, false);

  // OMP pointing to local port 7936
  const ompPath = path.join(tmp, "models.yml");
  fs.writeFileSync(ompPath, `providers:\n  qwenproxy:\n    baseUrl: http://127.0.0.1:7936/v1\n`, "utf-8");
  const ompSynced = inspectClientSyncStatus("omp", ompPath);
  assert.equal(ompSynced.installed, true);
  assert.equal(ompSynced.synced, true);

  // OMP pointing to external domain (e.g. traday.net) must NOT be considered synced
  fs.writeFileSync(ompPath, `providers:\n  qwenproxy:\n    baseUrl: https://ai.traday.net/v1\n`, "utf-8");
  const ompExternal = inspectClientSyncStatus("omp", ompPath);
  assert.equal(ompExternal.installed, true);
  assert.equal(ompExternal.synced, false);

  // OpenCode pointing to local port 7936
  const opencodePath = path.join(tmp, "opencode.jsonc");
  fs.writeFileSync(opencodePath, JSON.stringify({ provider: { qwenproxy: { options: { baseURL: "http://127.0.0.1:7936/v1" } } } }), "utf-8");
  const opencodeSynced = inspectClientSyncStatus("opencode", opencodePath);
  assert.equal(opencodeSynced.installed, true);
  assert.equal(opencodeSynced.synced, true);

  // OpenCode pointing to external provider
  fs.writeFileSync(opencodePath, JSON.stringify({ provider: { qwenproxy: { options: { baseURL: "https://remote.example.com/v1" } } } }), "utf-8");
  const opencodeExternal = inspectClientSyncStatus("opencode", opencodePath);
  assert.equal(opencodeExternal.installed, true);
  assert.equal(opencodeExternal.synced, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("restoreAllClients: merges state across multiple syncAllClients and supports selective rollback", () => {
  const tmp = createTempDir();
  const claudePath = path.join(tmp, "claude-settings.json");
  const codexPath = path.join(tmp, "codex-config.toml");
  const stateFilePath = path.join(tmp, "sync-state.json");

  fs.writeFileSync(claudePath, JSON.stringify({ env: { ANTHROPIC_MODEL: "claude-3-opus" } }), "utf-8");
  fs.writeFileSync(codexPath, `model = "gemini-flash"\nmodel_provider = "custom"\n`, "utf-8");

  // Sync 1: Claude Code only
  syncAllClients({
    targets: ["claude-code"],
    customPaths: { claudeCode: claudePath, codex: codexPath } as any,
    stateFilePath,
    apiKey: "sk-test-sync",
  });

  // Sync 2: Codex only (must merge into stateFilePath, not overwrite Claude!)
  syncAllClients({
    targets: ["codex"],
    customPaths: { claudeCode: claudePath, codex: codexPath } as any,
    stateFilePath,
    apiKey: "sk-test-sync",
  });

  const state = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
  assert.ok(state.clients.claudeCode, "State must retain claudeCode");
  assert.ok(state.clients.codex, "State must retain codex");

  // Selective Restore: Codex only
  const resCodex = restoreAllClients({
    targets: ["codex"],
    stateFilePath,
  });
  assert.equal(resCodex.restoredCount, 1);
  assert.equal(inspectClientSyncStatus("codex", codexPath).synced, false);
  assert.equal(inspectClientSyncStatus("claude-code", claudePath).synced, true);

  // State file must still have claudeCode
  const stateAfterSelective = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
  assert.ok(stateAfterSelective.clients.claudeCode, "Claude must remain in state");
  assert.equal(stateAfterSelective.clients.codex, undefined, "Codex must be removed from state");

  // Restore remaining
  const resRemaining = restoreAllClients({ stateFilePath });
  assert.equal(resRemaining.restoredCount, 1);
  assert.equal(inspectClientSyncStatus("claude-code", claudePath).synced, false);
  assert.equal(fs.existsSync(stateFilePath), false, "State file unlinked when all restored");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sync Claude Code: supports custom model and removes 1M Context suffix for minimalist display", () => {
  const tmp = createTempDir();
  const filePath = path.join(tmp, "settings.json");

  const res = syncClaudeCode({
    filePath,
    apiKey: "test-token",
    baseUrl: "http://127.0.0.1:7936",
    model: "qwen3.8-omni-flash",
  });
  assert.equal(res.success, true);

  const updated = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.equal(updated.env.ANTHROPIC_MODEL, "qwen3.8-omni-flash");
  assert.equal(updated.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "qwen3.8-omni-flash");
  assert.equal(updated.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "Qwen 3.8 Omni Flash");
  assert.equal(updated.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION, "QwenProxy qwen3.8-omni-flash");
  assert.ok(!updated.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME.includes("1M Context"));
  assert.ok(!updated.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION.includes("1M context window"));

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("syncAllClients: respects custom model parameter across multiple clients", () => {
  const tmp = createTempDir();
  const claudePath = path.join(tmp, ".claude", "settings.json");
  const codexPath = path.join(tmp, ".codex", "config.toml");
  const openCodePath = path.join(tmp, ".opencode", "config.json");

  const syncResult = syncAllClients({
    model: "qwen3.8-omni-flash",
    targets: ["claude-code", "codex", "opencode"],
    apiKey: "sk-test-sync",
    customPaths: {
      claudeCode: claudePath,
      codex: codexPath,
      openCode: openCodePath,
    },
  });

  assert.equal(syncResult.clients.claudeCode?.success, true);
  assert.equal(syncResult.clients.codex?.success, true);
  assert.equal(syncResult.clients.openCode?.success, true);

  // Verify Claude Code
  const claudeData = JSON.parse(fs.readFileSync(claudePath, "utf-8"));
  assert.equal(claudeData.env.ANTHROPIC_MODEL, "qwen3.8-omni-flash");
  assert.equal(claudeData.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "Qwen 3.8 Omni Flash");

  // Verify Codex
  const codexContent = fs.readFileSync(codexPath, "utf-8");
  assert.ok(codexContent.includes('model = "qwen3.8-omni-flash"'));

  // Verify OpenCode
  const openCodeData = JSON.parse(fs.readFileSync(openCodePath, "utf-8"));
  assert.ok(openCodeData.provider.qwenproxy.models["qwen3.8-omni-flash"]);
  assert.equal(openCodeData.provider.qwenproxy.models["qwen3.8-omni-flash"].name, "Qwen 3.8 Omni Flash");

  fs.rmSync(tmp, { recursive: true, force: true });
});
