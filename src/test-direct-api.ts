/**
 * Teste Completo: Todos os endpoints do QwenBridge via HTTP puro
 *
 * Endpoints testados:
 * 1. Login HTTP
 * 2. User Status
 * 3. Fetch Models
 * 4. Create Chat
 * 5. Send Completion (com thinking)
 * 6. Send Completion (sem thinking / no-thinking mode)
 * 7. Multi-turn (continuação com parent_id)
 * 8. Fetch Chat History
 * 9. Disable Native Tools
 * 10. Delete Single Chat
 * 11. Delete All Chats
 */

import crypto from "crypto";
import "dotenv/config";

const QWEN_BASE = "https://chat.qwen.ai";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0";

// Parse QWEN_ACCOUNTS
function parseAccounts(): { email: string; password: string }[] {
  const envAccounts = process.env.QWEN_ACCOUNTS;
  if (!envAccounts) return [];
  return envAccounts
    .split(",")
    .map((entry) => {
      const trimmed = entry.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) return null;
      const email = trimmed.substring(0, colonIdx).trim();
      const password = trimmed.substring(colonIdx + 1).trim();
      if (!email || !password) return null;
      return { email, password };
    })
    .filter((a): a is { email: string; password: string } => a !== null);
}

const accounts = parseAccounts();
if (accounts.length === 0) {
  console.error("Defina QWEN_ACCOUNTS=email:password no .env");
  process.exit(1);
}
const { email: EMAIL, password: PASSWORD } = accounts[0];

// ============================================================
// Helpers
// ============================================================

interface TestResult {
  step: string;
  success: boolean;
  data?: any;
  error?: string;
  statusCode?: number;
  durationMs?: number;
}

const results: TestResult[] = [];

function log(step: string, result: TestResult) {
  results.push(result);
  const icon = result.success ? "✅" : "❌";
  const dur = result.durationMs ? ` (${result.durationMs}ms)` : "";
  console.log(`${icon} ${step}${dur}`);
  if (!result.success && result.error) console.log(`   Error: ${result.error}`);
  if (result.statusCode) console.log(`   Status: ${result.statusCode}`);
  if (result.data) {
    const s = JSON.stringify(result.data);
    console.log(`   Data: ${s.slice(0, 200)}${s.length > 200 ? "..." : ""}`);
  }
}

function buildHeaders(
  cookies: string,
  opts?: {
    chatId?: string;
    extra?: Record<string, string>;
    includeAntiBot?: boolean;
  },
): Record<string, string> {
  const headers: Record<string, string> = {
    // Content negotiation (como cliente web real)
    accept: "application/json, text/plain, */*",
    "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
    "accept-encoding": "gzip, deflate, br, zstd",

    // Body
    "content-type": "application/json",

    // Auth
    cookie: cookies,

    // CORS
    origin: QWEN_BASE,
    referer: opts?.chatId
      ? `${QWEN_BASE}/c/${opts.chatId}`
      : `${QWEN_BASE}/c/new-chat`,

    // Client Hints (Edge 148 on Windows)
    "sec-ch-ua":
      '"Chromium";v="148", "Microsoft Edge";v="148", "Not=A?Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',

    // Fetch metadata
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",

    // Connection
    connection: "keep-alive",

    // User agent
    "user-agent": USER_AGENT,

    // Request ID
    "x-request-id": crypto.randomUUID(),

    // Anti-bot (vazio, não obrigatório)
    "bx-v": "2.5.36",

    // Qwen-specific
    source: "web",
    version: "0.2.63",
    timezone: new Date().toString().split(" (")[0],

    ...opts?.extra,
  };
  return headers;
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

// ============================================================
// 1. Login
// ============================================================
let authCookies = "";

async function testLogin(): Promise<boolean> {
  const hashedPassword = crypto
    .createHash("sha256")
    .update(PASSWORD)
    .digest("hex");

  const { result, durationMs } = await timed(async () => {
    const response = await fetch(`${QWEN_BASE}/api/v2/auths/signin`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        source: "web",
        timezone: new Date().toString().split(" (")[0],
        "x-request-id": crypto.randomUUID(),
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        email: EMAIL,
        password: hashedPassword,
        login_type: "email",
      }),
    });
    const data = await response.json();
    const setCookies = response.headers.getSetCookie?.() || [];
    const allCookies = setCookies.map((c) => c.split(";")[0]).join("; ");
    return {
      ok: response.ok,
      data,
      cookies: allCookies,
      status: response.status,
    };
  });

  authCookies = result.cookies;

  // Decodificar JWT para ver expiração
  const tokenMatch = authCookies.match(/token=([^;]+)/);
  if (tokenMatch) {
    try {
      const parts = tokenMatch[1].split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
      const expDate = new Date(payload.exp * 1000);
      const hoursLeft = (payload.exp * 1000 - Date.now()) / (1000 * 60 * 60);
      console.log(
        `   JWT expira em: ${expDate.toISOString()} (${hoursLeft.toFixed(1)}h)`,
      );
    } catch {}
  }

  log("1. Login HTTP", {
    step: "login",
    success: result.ok && result.data.success !== false,
    data: {
      hasToken: authCookies.includes("token="),
      userId: result.data?.data?.id,
    },
    statusCode: result.status,
    durationMs,
  });

  return result.ok;
}

// ============================================================
// 2. User Status
// ============================================================
async function testStatus(): Promise<boolean> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(`${QWEN_BASE}/api/v2/users/status`, {
      method: "POST",
      headers: buildHeaders(authCookies),
      body: JSON.stringify({
        typarms: {
          typarm1: "web",
          typarm2: "",
          typarm3: "prod",
          typarm4: "qwen_chat",
          typarm5: "product",
          typarm6: "",
          orgid: "tongyi",
        },
      }),
    });
    const data = await response.json();
    return { ok: response.ok && data.success, data, status: response.status };
  });

  log("2. User Status", {
    step: "status",
    success: result.ok,
    data: result.data,
    statusCode: result.status,
    durationMs,
  });

  return result.ok;
}

// ============================================================
// 3. Fetch Models
// ============================================================
async function testFetchModels(): Promise<string[]> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(`${QWEN_BASE}/api/models`, {
      headers: buildHeaders(authCookies, {
        extra: { accept: "application/json" },
      }),
    });
    const data = await response.json();
    return { ok: response.ok, data, status: response.status };
  });

  const models: string[] = [];
  if (result.data?.data && Array.isArray(result.data.data)) {
    for (const m of result.data.data) {
      models.push(m.id);
    }
  }

  log("3. Fetch Models", {
    step: "models",
    success: result.ok && models.length > 0,
    data: { count: models.length, models: models.slice(0, 5) },
    statusCode: result.status,
    durationMs,
  });

  return models;
}

// ============================================================
// 4. Create Chat
// ============================================================
async function testCreateChat(model: string): Promise<string | null> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(`${QWEN_BASE}/api/v2/chats/new`, {
      method: "POST",
      headers: buildHeaders(authCookies),
      body: JSON.stringify({
        title: "Nova Conversa",
        models: [model],
        chat_mode: "normal",
        chat_type: "t2t",
        timestamp: Math.floor(Date.now() / 1000),
        project_id: "",
      }),
    });
    const data = await response.json();
    return { ok: response.ok && data.success, data, status: response.status };
  });

  const chatId = result.data?.data?.id || null;

  log("4. Create Chat", {
    step: "create-chat",
    success: !!chatId,
    data: { chatId },
    statusCode: result.status,
    durationMs,
  });

  return chatId;
}

// ============================================================
// 5. Send Completion (com thinking)
// ============================================================
interface CompletionResult {
  content: string;
  reasoning: string;
  responseId: string | null;
  parentId: string | null;
  usage: any;
}

async function testCompletion(
  chatId: string,
  message: string,
  model: string,
  parentId: string | null = null,
  enableThinking = true,
): Promise<CompletionResult | null> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(
      `${QWEN_BASE}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: "POST",
        headers: buildHeaders(authCookies, {
          chatId,
          extra: {
            accept: "application/json",
            "x-accel-buffering": "no",
          },
        }),
        body: JSON.stringify({
          stream: true,
          version: "2.1",
          incremental_output: true,
          chat_id: chatId,
          chat_mode: "normal",
          model,
          parent_id: parentId,
          messages: [
            {
              fid: crypto.randomUUID(),
              parentId,
              childrenIds: [],
              role: "user",
              content: message,
              user_action: "chat",
              files: [],
              timestamp: Math.floor(Date.now() / 1000),
              models: [model],
              chat_type: "t2t",
              feature_config: {
                thinking_enabled: enableThinking,
                output_schema: "phase",
                research_mode: "normal",
                auto_thinking: false,
                thinking_mode: "Thinking",
                thinking_format: "summary",
                auto_search: true,
              },
              extra: { meta: { subChatType: "t2t" } },
              sub_chat_type: "t2t",
            },
          ],
          timestamp: Math.floor(Date.now() / 1000) + 1,
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      return {
        ok: false,
        error: `HTTP ${response.status}: ${errText.slice(0, 200)}`,
        status: response.status,
      };
    }

    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      const body = await response.text();
      return {
        ok: false,
        error: `Não é SSE: ${body.slice(0, 200)}`,
        status: response.status,
      };
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let reasoning = "";
    let responseId: string | null = null;
    let respParentId: string | null = null;
    let usage: any = null;
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data["response.created"]) {
            responseId = data["response.created"].response_id;
            respParentId = data["response.created"].parent_id;
          }
          const delta = data?.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (delta?.extra?.summary_thought?.content) {
            reasoning += delta.extra.summary_thought.content.join("");
          }
          if (data?.usage) usage = data.usage;
          chunkCount++;
        } catch {}
      }
    }

    return {
      ok: content.length > 0,
      content,
      reasoning,
      responseId,
      parentId: respParentId,
      usage,
      chunkCount,
      status: 200,
    };
  });

  const completion: CompletionResult | null =
    result.ok && "content" in result
      ? {
          content: (result as any).content,
          reasoning: (result as any).reasoning,
          responseId: (result as any).responseId,
          parentId: (result as any).parentId,
          usage: (result as any).usage,
        }
      : null;

  log("5. Completion (thinking)", {
    step: "completion-thinking",
    success: result.ok,
    data: result.ok
      ? {
          content: (result as any).content?.slice(0, 80),
          reasoningLen: (result as any).reasoning?.length,
          responseId: (result as any).responseId,
          parentId: (result as any).parentId,
          tokens: (result as any)?.usage?.total_tokens,
          chunks: (result as any).chunkCount,
        }
      : undefined,
    error: !result.ok ? (result as any).error : undefined,
    statusCode: (result as any).status,
    durationMs,
  });

  return completion;
}

// ============================================================
// 6. Completion sem thinking (no-thinking mode)
// ============================================================
async function testCompletionNoThinking(
  chatId: string,
  model: string,
): Promise<CompletionResult | null> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(
      `${QWEN_BASE}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: "POST",
        headers: buildHeaders(authCookies, {
          chatId,
          extra: {
            accept: "application/json",
            "x-accel-buffering": "no",
          },
        }),
        body: JSON.stringify({
          stream: true,
          version: "2.1",
          incremental_output: true,
          chat_id: chatId,
          chat_mode: "normal",
          model,
          parent_id: null,
          messages: [
            {
              fid: crypto.randomUUID(),
              parentId: null,
              childrenIds: [],
              role: "user",
              content: "Responda apenas: OK",
              user_action: "chat",
              files: [],
              timestamp: Math.floor(Date.now() / 1000),
              models: [model],
              chat_type: "t2t",
              feature_config: {
                thinking_enabled: false,
                output_schema: "phase",
                research_mode: "normal",
                auto_thinking: false,
                thinking_mode: "Thinking",
                thinking_format: "summary",
                auto_search: false,
              },
              extra: { meta: { subChatType: "t2t" } },
              sub_chat_type: "t2t",
            },
          ],
          timestamp: Math.floor(Date.now() / 1000) + 1,
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      return {
        ok: false,
        error: `HTTP ${response.status}: ${errText.slice(0, 200)}`,
        status: response.status,
      };
    }

    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      const body = await response.text();
      return {
        ok: false,
        error: `Não é SSE: ${body.slice(0, 200)}`,
        status: response.status,
      };
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let responseId: string | null = null;
    let usage: any = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data["response.created"])
            responseId = data["response.created"].response_id;
          const delta = data?.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (data?.usage) usage = data.usage;
        } catch {}
      }
    }

    return { ok: content.length > 0, content, responseId, usage, status: 200 };
  });

  log("6. Completion (no-thinking)", {
    step: "completion-no-thinking",
    success: result.ok,
    data: result.ok
      ? {
          content: (result as any).content?.slice(0, 80),
          responseId: (result as any).responseId,
          tokens: (result as any)?.usage?.total_tokens,
        }
      : undefined,
    error: !result.ok ? (result as any).error : undefined,
    statusCode: (result as any).status,
    durationMs,
  });

  return result.ok
    ? {
        content: (result as any).content,
        reasoning: "",
        responseId: (result as any).responseId,
        parentId: null,
        usage: (result as any).usage,
      }
    : null;
}

// ============================================================
// 7. Multi-turn (continuação com parent_id)
// ============================================================
async function testMultiTurn(
  chatId: string,
  model: string,
  parentId: string,
): Promise<CompletionResult | null> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(
      `${QWEN_BASE}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: "POST",
        headers: buildHeaders(authCookies, {
          chatId,
          extra: {
            accept: "application/json",
            "x-accel-buffering": "no",
          },
        }),
        body: JSON.stringify({
          stream: true,
          version: "2.1",
          incremental_output: true,
          chat_id: chatId,
          chat_mode: "normal",
          model,
          parent_id: parentId,
          messages: [
            {
              fid: crypto.randomUUID(),
              parentId,
              childrenIds: [],
              role: "user",
              content: "Agora diga apenas: segundo turno OK",
              user_action: "chat",
              files: [],
              timestamp: Math.floor(Date.now() / 1000),
              models: [model],
              chat_type: "t2t",
              feature_config: {
                thinking_enabled: true,
                output_schema: "phase",
                research_mode: "normal",
                auto_thinking: false,
                thinking_mode: "Thinking",
                thinking_format: "summary",
                auto_search: true,
              },
              extra: { meta: { subChatType: "t2t" } },
              sub_chat_type: "t2t",
            },
          ],
          timestamp: Math.floor(Date.now() / 1000) + 1,
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      return {
        ok: false,
        error: `HTTP ${response.status}: ${errText.slice(0, 200)}`,
        status: response.status,
      };
    }

    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      const body = await response.text();
      return {
        ok: false,
        error: `Não é SSE: ${body.slice(0, 200)}`,
        status: response.status,
      };
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let responseId: string | null = null;
    let usage: any = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data["response.created"])
            responseId = data["response.created"].response_id;
          const delta = data?.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (data?.usage) usage = data.usage;
        } catch {}
      }
    }

    return { ok: content.length > 0, content, responseId, usage, status: 200 };
  });

  log("7. Multi-turn (parent_id)", {
    step: "multi-turn",
    success: result.ok,
    data: result.ok
      ? {
          content: (result as any).content?.slice(0, 80),
          responseId: (result as any).responseId,
          tokens: (result as any)?.usage?.total_tokens,
        }
      : undefined,
    error: !result.ok ? (result as any).error : undefined,
    statusCode: (result as any).status,
    durationMs,
  });

  return result.ok
    ? {
        content: (result as any).content,
        reasoning: "",
        responseId: (result as any).responseId,
        parentId: null,
        usage: (result as any).usage,
      }
    : null;
}

// ============================================================
// 8. Fetch Chat History
// ============================================================
async function testFetchHistory(chatId: string): Promise<boolean> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(
      `${QWEN_BASE}/api/v2/chats/${encodeURIComponent(chatId)}`,
      {
        headers: buildHeaders(authCookies, { chatId }),
      },
    );
    const data = await response.json();
    return { ok: response.ok && data.success, data, status: response.status };
  });

  const messageCount = result.data?.data?.chat?.history?.messages
    ? Object.keys(result.data.data.chat.history.messages).length
    : 0;

  log("8. Fetch Chat History", {
    step: "history",
    success: result.ok && messageCount > 0,
    data: { messageCount, chatId: result.data?.data?.id },
    statusCode: result.status,
    durationMs,
  });

  return result.ok;
}

// ============================================================
// 9. Disable Native Tools
// ============================================================
async function testDisableTools(): Promise<boolean> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(
      `${QWEN_BASE}/api/v2/users/user/settings/update`,
      {
        method: "POST",
        headers: buildHeaders(authCookies),
        body: JSON.stringify({
          tools_enabled: {
            web_extractor: false,
            web_search_image: false,
            web_search: false,
            image_gen_tool: false,
            code_interpreter: false,
            history_retriever: false,
            image_edit_tool: false,
            bio: false,
            image_zoom_in_tool: false,
          },
        }),
      },
    );
    const data = await response.json();
    return { ok: response.ok, data, status: response.status };
  });

  log("9. Disable Native Tools", {
    step: "disable-tools",
    success: result.ok,
    data: result.data,
    statusCode: result.status,
    durationMs,
  });

  return result.ok;
}

// ============================================================
// 10. Delete Single Chat
// ============================================================
async function testDeleteChat(chatId: string): Promise<boolean> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(
      `${QWEN_BASE}/api/v2/chats/${encodeURIComponent(chatId)}`,
      {
        method: "DELETE",
        headers: buildHeaders(authCookies, {
          chatId,
          extra: { referer: `${QWEN_BASE}/settings/chats` },
        }),
      },
    );
    const data = await response.json();
    return { ok: response.ok, data, status: response.status };
  });

  log("10. Delete Single Chat", {
    step: "delete-chat",
    success: result.ok,
    data: { chatId, deleted: result.data?.data?.status },
    statusCode: result.status,
    durationMs,
  });

  return result.ok;
}

// ============================================================
// 11. Delete All Chats
// ============================================================
async function testDeleteAllChats(): Promise<boolean> {
  const { result, durationMs } = await timed(async () => {
    const response = await fetch(`${QWEN_BASE}/api/v2/chats/`, {
      method: "DELETE",
      headers: buildHeaders(authCookies, {
        extra: { referer: `${QWEN_BASE}/settings/chats` },
      }),
    });
    const data = await response.json();
    return { ok: response.ok, data, status: response.status };
  });

  log("11. Delete All Chats", {
    step: "delete-all",
    success: result.ok,
    data: result.data,
    statusCode: result.status,
    durationMs,
  });

  return result.ok;
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log("=".repeat(65));
  console.log("TESTE COMPLETO: Todos endpoints do QwenBridge via HTTP puro");
  console.log("=".repeat(65));
  console.log(`Email: ${EMAIL}`);
  console.log(`Hora: ${new Date().toISOString()}\n`);

  // 1. Login
  if (!(await testLogin())) {
    console.log("\n❌ Login falhou. Abortando.");
    return;
  }

  // 2. Status
  await testStatus();

  // 3. Models
  const models = await testFetchModels();
  const model = models[0] || "qwen3.7-plus";

  // 4. Create Chat para testes
  const chatId = await testCreateChat(model);
  if (!chatId) {
    console.log("\n❌ Criação de chat falhou. Abortando.");
    return;
  }

  // 5. Completion com thinking
  const firstCompletion = await testCompletion(
    chatId,
    "Diga apenas: primeiro turno OK",
    model,
  );

  // 6. Completion sem thinking (no-thinking)
  const noThinkingChatId = await testCreateChat(model);
  if (noThinkingChatId) {
    await testCompletionNoThinking(noThinkingChatId, model);
  }

  // 7. Multi-turn (usa response_id do step 5 como parent_id)
  if (firstCompletion?.responseId) {
    await testMultiTurn(chatId, model, firstCompletion.responseId);
  }

  // 8. Fetch History
  await testFetchHistory(chatId);

  // 9. Disable Tools
  await testDisableTools();

  // 10. Delete Single Chat
  if (noThinkingChatId) {
    await testDeleteChat(noThinkingChatId);
  }

  // 11. Delete All Chats (limpa o chat principal também)
  await testDeleteAllChats();

  // ============================================================
  // Resumo
  // ============================================================
  console.log("\n" + "=".repeat(65));
  console.log("RESUMO FINAL:");
  console.log("=".repeat(65));

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  for (const r of results) {
    const icon = r.success ? "✅" : "❌";
    const dur = r.durationMs ? ` (${r.durationMs}ms)` : "";
    console.log(`${icon} ${r.step}${dur}`);
  }

  console.log(`\n✅ Passou: ${passed}/${results.length}`);
  console.log(`❌ Falhou: ${failed}/${results.length}`);

  if (failed === 0) {
    console.log("\n🎉 TODOS OS ENDPOINTS FUNCIONAM VIA HTTP PURO!");
    console.log("Próximo passo: usar auth-http.ts no fluxo principal");
  } else {
    console.log("\n⚠️ Alguns endpoints falharam. Verificar:");
    for (const r of results.filter((r) => !r.success)) {
      console.log(`   - ${r.step}: ${r.error}`);
    }
  }
}

main().catch(console.error);
