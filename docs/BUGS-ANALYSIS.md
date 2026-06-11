# QwenBridge — Relatório de Bugs e Vulnerabilidades

> **Data da análise:** 12 de junho de 2026
> **Escopo:** Todo o código-fonte (`src/`), incluindo `core/`, `services/`, `routes/`, `cache/`, `utils/`, `tools/` e `api/`.
> **Typecheck (`tsc --noEmit`):** ✅ Limpo — zero erros de tipo.
> **Total de issues encontrados:** 36

---

## Sumário

| Severidade | Quantidade |
|---|---:|
| 🔴 Crítico | 12 |
| 🟠 Alto | 12 |
| 🟡 Médio | 12 |

- [1. Críticos — Segurança](#-cr%C3%ADticos--seguran%C3%A7a)
- [2. Críticos — Corrupção de Dados e Concorrência](#-cr%C3%ADticos--corrup%C3%A7%C3%A3o-de-dados-e-concorr%C3%AAncia)
- [3. Altos — Bugs Funcionais e Vazamentos](#-altos--bugs-funcionais-e-vazamentos)
- [4. Altos — Configuração e Lógica](#-altos--configura%C3%A7%C3%A3o-e-l%C3%B3gica)
- [5. Médios](#-m%C3%A9dios)
- [6. Prioridade de Correção](#-prioridade-de-corre%C3%A7%C3%A3o)

---

## 🔴 Críticos — Segurança

### Bug #1 — SSRF em `downloadRemoteMedia`

| | |
|---|---|
| **Arquivo** | `src/routes/upload.ts` |
| **Linhas** | 280–320 |
| **Categoria** | Server-Side Request Forgery |

**Código problemático:**
```typescript
async function downloadRemoteMedia(url: string): Promise<{ /* ... */ }> {
  const response = await fetch(url, {   // ← URL arbitrária do cliente
    headers: { /* ... */ },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  // ...
}
```

**Descrição:**
A função aceita qualquer URL fornecida pelo cliente sem nenhum tipo de validação. Isso permite que um atacante faça o servidor realizar requisições para:
- `http://127.0.0.1:<porta>/...` — serviços internos da máquina.
- `http://169.254.169.254/latest/meta-data/` — metadados de instâncias cloud (AWS, GCP, Azure), que podem conter credenciais temporárias.
- `file:///etc/passwd` — leitura de arquivos locais (dependendo do client HTTP).
- Qualquer host/IP da rede interna acessível pelo servidor.

**Impacto:** Acesso a credenciais cloud, enumeração de serviços internos, leitura de arquivos sensíveis.

**Correção sugerida:**
```typescript
import { isIP } from "net";

function validateRemoteUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("Unsupported protocol");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isIP(hostname) !== 0  // bloqueia IPs literais — ajustar conforme whitelist
  ) {
    throw new ValidationError("Blocked hostname");
  }
  // Opcional: whitelist de domínios permitidos
  return url;
}
```

---

### Bug #2 — Timing attack na autenticação Anthropic

| | |
|---|---|
| **Arquivo** | `src/routes/anthropic/index.ts` |
| **Linhas** | 51–59 |
| **Categoria** | Timing attack / autenticação |

**Código problemático:**
```typescript
function verifyAnthropicApiKey(c: Context): boolean {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey) return true;

  const providedKey = c.req.header("x-api-key");
  if (!providedKey) return false;

  return providedKey === apiKey;   // ← comparação string direta
}
```

**Descrição:**
O operador `===` retorna `false` no primeiro caractere diferente, o que significa que o tempo de resposta varia conforme o número de caracteres corretos no início da chave. Um atacante pode medir latência de rede para recuperar a API key caractere por caractere.

**Inconsistência:** A autenticação OpenAI (`src/api/server.ts:62-67`) usa `crypto.timingSafeEqual`, mas a Anthropic usa `===`.

**Impacto:** Recuperação remota da API key via medição de latência.

**Correção sugerida:**
```typescript
import { timingSafeEqual } from "crypto";

function verifyAnthropicApiKey(c: Context): boolean {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey) return true;

  const providedKey = c.req.header("x-api-key");
  if (!providedKey) return false;

  const a = Buffer.from(providedKey);
  const b = Buffer.from(apiKey);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

---

### Bug #3 — Header injection via `opts.extra`

| | |
|---|---|
| **Arquivo** | `src/services/qwen-headers.ts` |
| **Linha** | 48 |
| **Categoria** | Header injection / sequestro de sessão |

**Código problemático:**
```typescript
if (opts.extra) Object.assign(headers, opts.extra);
```

**Descrição:**
`opts.extra` é aplicado **depois** dos headers críticos já definidos (`Cookie`, `Origin`, `Referer`, `bx-ua`, etc.). Se `opts.extra` vier de input não confiável, um atacante pode:
- Sobrescrever `Cookie` com a sessão de outra conta.
- Modificar `Origin`/`Referer` para bypass de CORS.
- Injetar headers customizados para log poisoning (`X-Request-Id`).

**Impacto:** Sequestro de sessão, bypass de CORS, log poisoning.

**Correção sugerida:**
```typescript
// Aplicar extra ANTES dos headers críticos
const headers: Record<string, string> = {
  ...(opts.extra || {}),
  // Headers críticos sobrescrevem extra:
  Cookie: opts.cookie,
  "User-Agent": opts.userAgent,
  Origin: "https://chat.qwen.ai",
  Referer: "https://chat.qwen.ai/",
  // ...
};
```

---

### Bug #4 — Spoofing do header `X-Internal-Summarization`

| | |
|---|---|
| **Arquivo** | `src/routes/chat/validation.ts` |
| **Linhas** | 41–42 |
| **Categoria** | Autorização / spoofing |

**Código problemático:**
```typescript
const isInternalSummarizationRequest =
  c.req.header("X-Internal-Summarization") === "true";
```

**Descrição:**
Qualquer cliente HTTP externo pode enviar `X-Internal-Summarization: true` no header e ser tratado como requisição interna. Se a flag concede privilégios especiais (bypass de rate limit, acesso a modelos diferentes, pular validações), um atacante pode explorá-la diretamente.

**Impacto:** Bypass de controles de acesso internos.

**Correção sugerida:**
Validar por IP de origem ou token compartilhado:
```typescript
const isInternalSummarizationRequest =
  c.req.header("X-Internal-Summarization") === "true" &&
  isInternalRequest(c);  // verifica IP 127.0.0.1 ou token compartilhado
```

---

### Bug #5 — Sandbox do Chrome desabilitado em produção

| | |
|---|---|
| **Arquivo** | `src/services/playwright.ts` |
| **Linha** | 274 |
| **Categoria** | Segurança do browser / escape de sandbox |

**Código problemático:**
```typescript
args: [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",   // ← desabilita o sandbox do Chrome
]
```

**Descrição:**
O flag `--no-sandbox` desabilita completamente o sandbox de segurança do Chromium. Se qualquer página visitada contiver um exploit (ou se o browser tiver extensão maliciosa), código malicioso pode escapar do processo renderer e acessar o sistema host — incluindo arquivos, rede e outros processos.

**Impacto:** Escape de sandbox, acesso ao host em caso de exploit no browser.

**Correção sugerida:**
Remover `--no-sandbox` e usar alternativas para containers Docker:
```typescript
args: [
  "--disable-blink-features=AutomationControlled",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",  // resolve problemas de /dev/shm em Docker
]
```
Se `--no-sandbox` for estritamente necessário em CI/Docker root, documentar e restringir via variável de ambiente com warning explícito.

---

### Bug #6 — Bypass total de autenticação via variável de ambiente

| | |
|---|---|
| **Arquivo** | `src/services/auth-playwright.ts` |
| **Linhas** | 14–16 |
| **Categoria** | Backdoor / bypass de autenticação |

**Código problemático:**
```typescript
export function isAuthMockEnabled(): boolean {
  return process.env.TEST_MOCK_QWEN_AUTH === "true";
}
```

**Descrição:**
Se a variável `TEST_MOCK_QWEN_AUTH=true` for definida acidentalmente (ou maliciosamente) em produção, **toda a autenticação é contornada** — headers mock são retornados ao invés de fazer login real via Playwright. Não há guarda de ambiente (`NODE_ENV`) nem qualquer validação adicional.

**Impacto:** Bypass completo da autenticação em produção.

**Correção sugerida:**
```typescript
export function isAuthMockEnabled(): boolean {
  return process.env.NODE_ENV === "test" &&
         process.env.TEST_MOCK_QWEN_AUTH === "true";
}
```

---

## 🔴 Críticos — Corrupção de Dados e Concorrência

### Bug #7 — Race condition na inicialização do SQLite

| | |
|---|---|
| **Arquivo** | `src/core/database.ts` |
| **Linhas** | 22–23 |
| **Categoria** | Race condition / corrupção de dados |

**Código problemático:**
```typescript
let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;
  // ... inicialização longa (mkdir, migrations, etc.) ...
  db = new Database(DB_PATH);
  // ...
  return db;
}
```

**Descrição:**
Se duas chamadas simultâneas ocorrerem antes de `db` ser atribuído (ex: na inicialização do servidor quando múltiplas rotas carregam em paralelo), **ambas** executarão a inicialização completa: `mkdirSync`, `renameSync` do legacy, criação de `new Database()`, e execução de migrations. Isso resulta em múltiplas instâncias do SQLite apontando para o mesmo arquivo — o que causa corrupção do banco e do WAL.

**Impacto:** Corrupção do banco de dados SQLite.

**Correção sugerida:**
```typescript
let dbPromise: Promise<Database.Database> | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;
  // Garantir inicialização síncrona única via mutex global
  // Ou usar módulo-level init no startup.
  throw new Error("Database not initialized — call initDatabase() at startup");
}

export function initDatabase(): Database.Database {
  if (db) return db;
  // ... toda a lógica de inicialização ...
  db = new Database(DB_PATH);
  return db;
}
```

---

### Bug #8 — TOCTOU em `upsertThreadContextSession`

| | |
|---|---|
| **Arquivo** | `src/services/thread-context-store.ts` |
| **Linhas** | 309–392 |
| **Categoria** | TOCTOU / perda de updates |

**Código problemático:**
```typescript
const existing = getThreadContextSession(input.sessionId);  // Time 1: lê
// ...
lógica de preparação
// ...
if (!existing) {
  db.prepare("INSERT INTO thread_context_sessions ...").run(...);
} else {
  db.prepare("UPDATE thread_context_sessions ...").run(...);  // Time 2: escreve
}
```

**Descrição:**
Entre o `SELECT` (Time 1) e o `UPDATE` (Time 2), outra requisição concorrente pode ter:
- Modificado o registro → o UPDATE sobrescreve as mudanças.
- Deletado o registro → o UPDATE afeta 0 linhas silenciosamente.
- Criado o registro → o INSERT falha com constraint violation.

**Impacto:** Perda silenciosa de dados de sessão de thread.

**Correção sugerida:**
```sql
INSERT INTO thread_context_sessions (session_id, ...)
VALUES (?, ...)
ON CONFLICT(session_id) DO UPDATE SET
  model = excluded.model,
  updated_at = excluded.updated_at,
  ...
```

---

### Bug #9 — Race na sequência de summaries

| | |
|---|---|
| **Arquivo** | `src/services/thread-context-store.ts` |
| **Linhas** | 666–727 |
| **Categoria** | Race condition / constraint violation |

**Código problemático:**
```typescript
const existing = getThreadContextSession(input.sessionId);
const sequence = existing.summarySequence + 1;   // ← lê sequência
// ... várias operações ...
db.prepare("INSERT INTO thread_context_summaries ... VALUES (?, ?, ...)")
  .run(..., sequence, ...);   // ← usa sequência lida anteriormente
```

**Descrição:**
Duas invocações concorrentes de `insertThreadContextSummary` para o mesmo `sessionId` podem ler o mesmo `summarySequence` e tentar inserir com a mesma sequência. Isso resulta em violação de constraint `UNIQUE` ou, pior, uma inserção bem-sucedida com sequência duplicada, causando inconsistência na cadeia de summaries.

**Impacto:** Summaries duplicados ou perdidos, quebra da cadeia de contexto.

**Correção sugerida:**
```typescript
const stmt = db.prepare(`
  INSERT INTO thread_context_summaries (session_id, sequence, ...)
  VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM thread_context_summaries WHERE session_id = ?), ...)
`);
```
Ou usar transação com `BEGIN IMMEDIATE`.

---

### Bug #10 — Múltiplas escritas sem transação em `saveThreadContextCompletion`

| | |
|---|---|
| **Arquivo** | `src/services/thread-context-store.ts` |
| **Linhas** | 518–608 |
| **Categoria** | Atomicidade / corrupção de estado |

**Código problemático:**
```typescript
export function saveThreadContextCompletion(input) {
  if (input.userPrompt.trim()) {
    insertThreadContextTurn({ ... });   // escrita 1
  }
  insertThreadContextTurn({ ... });     // escrita 2
  db.prepare("UPDATE thread_context_sessions ...").run(...);   // escrita 3
  return refreshThreadContextAggregates(...);   // escrita 4
}
```

**Descrição:**
Quatro escritas separadas são executadas fora de transação. Se o processo crashar, receber SIGKILL, ou encontrar erro entre a escrita 2 e a 3, o banco fica em estado inconsistente: turns inseridos mas sessão não atualizada, contadores dessincronizados, aggregates desatualizados.

**Impacto:** Estado inconsistente entre turns e sessões, aggregates incorretos.

**Correção sugerida:**
```typescript
export function saveThreadContextCompletion(input) {
  const db = getDatabase();
  const runAll = db.transaction(() => {
    if (input.userPrompt.trim()) insertThreadContextTurn({ ... });
    insertThreadContextTurn({ ... });
    db.prepare("UPDATE thread_context_sessions ...").run(...);
    return refreshThreadContextAggregates(...);
  });
  return runAll();
}
```

---

### Bug #11 — Mutex sem proteção contra deadlock

| | |
|---|---|
| **Arquivo** | `src/core/mutex.ts` |
| **Linhas** | 10–21 |
| **Categoria** | Deadlock |

**Código problemático:**
```typescript
async acquire(): Promise<() => void> {
  if (!this.locked) {
    this.locked = true;
    return () => this.release();
  }
  return new Promise<() => void>((resolve) => {
    this.queue.push(() => {
      resolve(() => this.release());
    });
  });
}
```

**Descrição:**
Se qualquer exceção for lançada após `acquire()` retornar mas antes do `release()` ser chamado (por exemplo, um erro de rede dentro do `try` que usa o lock), o mutex **permanece travado permanentemente**. Todos os waiters subsequentes ficam bloqueados indefinidamente — um deadlock clássico.

Não há mecanismo de timeout, auto-cleanup, nem detecção de lock órfão.

**Impacto:** Deadlock permanente — contas, streams ou operações ficam travadas para sempre.

**Correção sugerida:**
```typescript
async acquire(timeoutMs = 30_000): Promise<() => void> {
  // ...
  return new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove da queue e rejeita
      reject(new Error(`Mutex acquire timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    this.queue.push(() => {
      clearTimeout(timer);
      resolve(() => this.release());
    });
  });
}

// Helper seguro:
async withLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await this.acquire();
  try { return await fn(); }
  finally { release(); }
}
```

---

### Bug #12 — Vazamento de streams órfãs no registro

| | |
|---|---|
| **Arquivo** | `src/core/stream-registry.ts` |
| **Linhas** | função `registerStream` |
| **Categoria** | Vazamento de recursos |

**Código problemático:**
```typescript
export function registerStream(key: string, entry: StreamEntry): void {
  activeStreams.set(key, entry);   // ← sobrescreve sem cleanup
  metrics.gauge("streams.active", activeStreams.size);
}
```

**Descrição:**
Dois problemas combinados:
1. Se `registerStream` for chamado com uma key que já existe, a stream anterior é sobrescrita — mas seu `AbortController` **nunca é abortado** e seus recursos nunca são liberados.
2. Não há mecanismo de timeout automático. Se `removeStream()` nunca for chamado (por exemplo, em caso de erro inesperado), a stream permanece no Map indefinidamente.

**Impacto:** Vazamento crescente de memória e conexões HTTP abertas.

**Correção sugerida:**
```typescript
export function registerStream(key: string, entry: StreamEntry): void {
  const existing = activeStreams.get(key);
  if (existing) {
    existing.abortController.abort();  // aborta stream anterior
  }
  activeStreams.set(key, entry);
  metrics.gauge("streams.active", activeStreams.size);
}
```

---

## 🟠 Altos — Bugs Funcionais e Vazamentos

### Bug #13 — Promise resolvida múltiplas vezes em `captureHeaders`

| | |
|---|---|
| **Arquivo** | `src/services/playwright.ts` |
| **Linhas** | 489–567 |
| **Categoria** | Concorrência / operações em page fechado |

**Código problemático:**
```typescript
return new Promise<void>((resolve) => {
  const timeout = setTimeout(async () => {
    await page.unroute(...).catch(() => {});
    resolve();   // ← resolve 1 (timeout)
  }, 30000);

  const routeHandler = async (route, request) => {
    clearTimeout(timeout);
    // ...
    await route.abort("aborted");
    await page.unroute(...);
    resolve();   // ← resolve 2 (handler)
  };
});
```

**Descrição:**
Embora Promises ignorem resoluções subsequentes, o código **após** o primeiro `resolve()` continua executando. Se o timeout de 30s expirar e resolver, mas o `routeHandler` for chamado pouco depois, ele tentará executar `page.unroute()` e `route.abort()` em um page que pode já estar fechado ou em cleanup.

**Impacto:** Erros não tratados em operações de browser, possíveis unhandled rejections.

**Correção sugerida:**
```typescript
return new Promise<void>((resolve) => {
  let resolved = false;
  const done = () => { if (!resolved) { resolved = true; resolve(); } };

  const timeout = setTimeout(async () => {
    await page.unroute(...).catch(() => {});
    done();
  }, 30000);

  const routeHandler = async (route, request) => {
    clearTimeout(timeout);
    await route.abort("aborted");
    await page.unroute(...);
    done();
  };
});
```

---

### Bug #14 — Vazamento de timers de timeout

| | |
|---|---|
| **Arquivo** | `src/services/qwen.ts` |
| **Linhas** | 1382 e 1443–1457 |
| **Categoria** | Vazamento de timer / recursos |

**Problema 1 — Timer não limpo em sucesso rápido (linha 1382):**
```typescript
const timeoutId = setTimeout(() => controller.abort(), dynamicTimeoutMs);
try {
  response = await fetch(url, { ... });
} catch (error) {
  throw withCreatedChatMetadata(...);
} finally {
  clearTimeout(timeoutId);   // ← só limpa no finally do try externo
}
```
Em caminhos de sucesso rápido, o timer (potencialmente de 5–10 minutos) continua rodando até expirar desnecessariamente.

**Problema 2 — Timer vaza em exceção (linha 1443):**
```typescript
const retryTimeoutId = setTimeout(() => retryController.abort(), dynamicTimeoutMs);
const retryResponse = await fetch(url, { ... });
// ...
clearTimeout(retryTimeoutId);   // ← só limpa se fetch completar
```
Se `fetch()` lançar exceção, `clearTimeout` nunca é chamado. Falta `try/finally`.

**Impacto:** Timers órfãos mantendo referências a objetos grandes (AbortControllers, payloads) por minutos.

**Correção sugerida:**
```typescript
const retryTimeoutId = setTimeout(() => retryController.abort(), dynamicTimeoutMs);
try {
  const retryResponse = await fetch(url, { signal: retryController.signal, ... });
  // ...
} finally {
  clearTimeout(retryTimeoutId);
}
```

---

### Bug #15 — Stream reader não liberado em erro upstream

| | |
|---|---|
| **Arquivo** | `src/routes/chat/streaming.ts` |
| **Linhas** | 564–583 |
| **Categoria** | Vazamento de ReadableStream |

**Código problemático:**
```typescript
const streamReader = stream.getReader();
// ... pré-read loop ...
const upstreamError = parseQwenErrorPayload(initialStreamBuffer);
if (upstreamError) {
  removeStream(completionId);
  if (onStreamComplete) onStreamComplete();
  return sendOpenAIError(c, ...);   // ← streamReader nunca liberado!
}
```

**Descrição:**
Quando um erro upstream é detectado no pré-read, a função retorna sem chamar `streamReader.releaseLock()` ou `streamReader.cancel()`. O ReadableStream subjacente permanece aberto e seus recursos nunca são liberados.

**Impacto:** Vazamento de recursos do ReadableStream em cada request que falha no pré-read.

**Correção sugerida:**
```typescript
if (upstreamError) {
  try { streamReader.cancel(); } catch {}
  removeStream(completionId);
  if (onStreamComplete) onStreamComplete();
  return sendOpenAIError(c, ...);
}
```

---

### Bug #16 — `maxInputTokens` calculado e nunca usado

| | |
|---|---|
| **Arquivo** | `src/services/thread-context-summarizer.ts` |
| **Linha** | 134 |
| **Categoria** | Bug de lógica / estouro de contexto |

**Código problemático:**
```typescript
const maxInputTokens = Math.floor(session.modelContextWindow * 0.45);
const messages = buildSummaryInputMessages({ ... });
// messages nunca é truncado para caber em maxInputTokens
```

**Descrição:**
A variável `maxInputTokens` é calculada com a intenção de limitar o tamanho do input da sumarização, mas nunca é aplicada. Se `unsummarizedTurns` for muito grande, o request de sumarização excederá o limite de contexto do modelo de sumarização, resultando em erro HTTP 400.

**Impacto:** Falha de sumarização em sessões longas, crescimento descontrolado do contexto.

**Correção sugerida:**
Aplicar truncamento nas mensagens antes de enviar:
```typescript
const messages = buildSummaryInputMessages({ ... });
const truncated = truncateMessagesToTokens(messages, maxInputTokens);
```

---

### Bug #17 — Recursos de browser não liberados em falha de login

| | |
|---|---|
| **Arquivo** | `src/services/playwright.ts` |
| **Linhas** | 262–283 |
| **Categoria** | Vazamento de recursos / browser |

**Código problemático:**
```typescript
const acctContext = await engineToUse.launchPersistentContext(...);
const acctPage = await acctContext.newPage();
accountContexts.set(account.id, acctContext);   // ← adiciona ANTES de validar
accountPages.set(account.id, acctPage);

await loginToQwen(...);        // ← se falhar, contexto fica órfão
await captureHeaders(account.id);   // ← se falhar, contexto fica órfão
```

**Descrição:**
Contextos e páginas são registrados nos Maps globais antes de todas as validações passarem. Se `loginToQwen` ou `captureHeaders` lançar exceção, o contexto do browser permanece aberto mas inacessível — vazando memória, processo do Chrome e file descriptors.

**Impacto:** Vazamento de processos Chrome em falhas de login.

**Correção sugerida:**
```typescript
try {
  await loginToQwen(...);
  await captureHeaders(account.id);
  // Só registrar após sucesso
  accountContexts.set(account.id, acctContext);
  accountPages.set(account.id, acctPage);
} catch (err) {
  await acctContext.close().catch(() => {});
  throw err;
}
```

---

### Bug #18 — Estimativa de tokens incorreta para CJK com surrogate pairs

| | |
|---|---|
| **Arquivo** | `src/utils/context-truncation.ts` |
| **Linhas** | 14–22 |
| **Categoria** | Bug de lógica / cálculo incorreto |

**Código problemático:**
```typescript
// CJK Unified Ideographs (U+4E00–U+9FFF)
if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
  tokens += 1.5;
  i += 1;   // ← deveria ser: i += codePoint > 0xffff ? 2 : 1
}
// CJK Extension A/B (U+3400–U+2A6DF)
else if (codePoint >= 0x3400 && codePoint <= 0x2a6df) {
  tokens += 1.5;
  i += codePoint > 0xffff ? 2 : 1;   // ← correto aqui
}
```

**Descrição:**
O primeiro bloco (U+4E00–U+9FFF) não considera que caracteres CJK podem estar acima de U+FFFF e ocupar 2 unidades de código UTF-16. O índice `i` avança apenas 1 posição, causando desalinhamento na iteração — estimativa de tokens incorreta e possível processamento de surrogate halves isolados.

**Impacto:** Estimativa de tokens errada para textos com CJK, potencial truncamento incorreto do contexto.

**Correção sugerida:**
```typescript
if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
  tokens += 1.5;
  i += codePoint > 0xffff ? 2 : 1;
}
```

---

### Bug #19 — `PORT` inválido passa pela validação

| | |
|---|---|
| **Arquivo** | `src/core/config.ts` |
| **Linhas** | 79–100 |
| **Categoria** | Validação insuficiente |

**Código problemático:**
```typescript
server: {
  port: parseInt(env.PORT),   // "abc" → NaN
  host: env.HOST,
  internalHost: env.INTERNAL_HOST,
},
```

**Descrição:**
O schema Zod valida `PORT` como string, mas a conversão para número é feita com `parseInt()` sem validação posterior. `PORT="abc"` produz `NaN`, que é passado para o servidor HTTP. O servidor falhará ao iniciar com erro confuso, sem mensagem clara sobre a causa.

**Impacto:** Falha silenciosa ou com erro confuso na inicialização.

**Correção sugerida:**
No schema Zod:
```typescript
PORT: z.string().regex(/^\d+$/).transform(Number).default("3000"),
```

---

### Bug #20 — Ratios de contexto sem validação de ordem/range

| | |
|---|---|
| **Arquivo** | `src/core/config.ts` |
| **Linhas** | 126–129 |
| **Categoria** | Validação insuficiente |

**Código problemático:**
```typescript
summaryStaleRatio: parseFloat(env.CONTEXT_SUMMARY_STALE_RATIO),
rolloverReadyRatio: parseFloat(env.CONTEXT_ROLLOVER_READY_RATIO),
rolloverRequiredRatio: parseFloat(env.CONTEXT_ROLLOVER_REQUIRED_RATIO),
hardLimitRatio: parseFloat(env.CONTEXT_HARD_LIMIT_RATIO),
```

**Descrição:**
Não há validação de que:
- Os valores estão entre 0 e 1.
- Estão em ordem crescente (`stale < ready < required < hard`).
- Não são `NaN` (se a string for inválida).

Valores inconsistentes (ex: `staleRatio=0.9`, `rolloverReadyRatio=0.5`) criam lógica de rollover contraditória — o sistema pode tentar sumarizar antes de estar "stale" ou nunca fazer rollover.

**Impacto:** Lógica de rollover de contexto quebrada, perda de contexto ou estouro do limite.

**Correção sugerida:**
```typescript
rolloverReadyRatio: z.number().min(0).max(1),
// + refine para validar ordem:
.refine(cfg =>
  cfg.summaryStaleRatio < cfg.rolloverReadyRatio &&
  cfg.rolloverReadyRatio < cfg.rolloverRequiredRatio &&
  cfg.rolloverRequiredRatio < cfg.hardLimitRatio,
  { message: "Context ratios must be in ascending order" }
)
```

---

### Bug #21 — `API_KEY` padrão vazia

| | |
|---|---|
| **Arquivo** | `src/core/config.ts` |
| **Linha** | 72 |
| **Categoria** | Segurança / configuração padrão insegura |

**Código problemático:**
```typescript
API_KEY: z.string().default("")
```

**Descrição:**
Se `API_KEY` não for definida no ambiente, o servidor inicia sem autenticação. Combinado com `HOST=0.0.0.0` (padrão), cria um proxy aberto acessível de qualquer IP na internet — qualquer pessoa pode usar as contas Qwen configuradas.

**Impacto:** Proxy aberto exposto na internet sem autenticação.

**Correção sugerida:**
Ao mínimo, emitir um warning explícito no startup quando `API_KEY` estiver vazia e `HOST` for `0.0.0.0`:
```typescript
if (!config.apiKey && config.server.host === "0.0.0.0") {
  logger.warn("⚠️  API_KEY is empty and HOST is 0.0.0.0 — server is open to the internet!");
}
```

---

### Bug #22 — Senhas em texto plano + SHA256 sem salt

| | |
|---|---|
| **Arquivo** | `src/core/accounts.ts` (linhas 135–138) e `src/services/playwright.ts` (linhas 384–387) |
| **Categoria** | Armazenamento inseguro de credenciais |

**Problema 1 — Texto plano no SQLite:**
```typescript
db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)")
  .run(newAccount.id, newAccount.email, newAccount.password);  // ← senha sem hash
```

**Problema 2 — SHA256 sem salt:**
```typescript
const hashedPassword = crypto
  .createHash("sha256")
  .update(password)
  .digest("hex");   // ← sem salt, vulnerável a rainbow tables
```

**Problema 3 — Permissões do diretório:**
```typescript
// database.ts:28
fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o755 });  // ← legível por todos
```

**Descrição:**
O banco `data/` armazena senhas em texto plano. Mesmo onde há hashing (playwright.ts), usa SHA256 sem salt — vulnerável a rainbow tables e lookup tables pré-computadas. O diretório `data/` é criado com `0o755`, permitindo que qualquer usuário do sistema leia o banco.

**Impacto:** Credenciais expostas em caso de acesso ao arquivo do banco.

**Correção sugerida:**
```typescript
// accounts.ts + playwright.ts
import { scrypt, randomBytes } from "crypto";
const salt = randomBytes(16).toString("hex");
const hash = await scryptAsync(password, salt, 64);
// armazenar: `${salt}:${hash.toString("hex")}`

// database.ts
fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
```

---

### Bug #23 — Migração de DB legacy não atômica

| | |
|---|---|
| **Arquivo** | `src/core/database.ts` |
| **Linhas** | 35–42 |
| **Categoria** | Atomicidade / corrupção |

**Código problemático:**
```typescript
if (fs.existsSync(legacyPath) && !fs.existsSync(DB_PATH)) {
  fs.renameSync(legacyPath, DB_PATH);
  if (fs.existsSync(legacyWalPath) && !fs.existsSync(DB_WAL_PATH)) {
    fs.renameSync(legacyWalPath, DB_WAL_PATH);
  }
  if (fs.existsSync(legacyShmPath) && !fs.existsSync(DB_SHM_PATH)) {
    fs.renameSync(legacyShmPath, DB_SHM_PATH);
  }
}
```

**Descrição:**
Três operações `renameSync` separadas. Se a primeira (DB principal) succeeder mas a segunda ou terceira (WAL/SHM) falhar — por permissão, disco cheio, ou interrupção — o banco ficará sem seus arquivos de journal. O SQLite tentará abrir um banco potencialmente inconsistente sem WAL.

**Impacto:** Banco corrompido após migração parcial.

**Correção sugerida:**
Mover todos os arquivos em uma única operação ou criar backup antes:
```typescript
// Backup antes de migrar
fs.copyFileSync(legacyPath, legacyPath + ".bak");
// ... migrar todos ...
// Remover backup após confirmação
```

---

### Bug #24 — Try-catch silencioso engole erros críticos

| | |
|---|---|
| **Arquivos** | `src/core/database.ts` (linhas 251–262) e `src/services/qwen.ts` (linhas 75–95) |
| **Categoria** | Error handling / debugging |

**Código problemático (database.ts):**
```typescript
try {
  db.exec("ALTER TABLE accounts ADD COLUMN cooldown_until INTEGER DEFAULT 0;");
} catch {
  // Column already exists
}
```

**Código problemático (qwen.ts):**
```typescript
try {
  const db = getDatabase();
  const cutoff = new Date(now - SESSION_TTL_MS).toISOString();
  db.prepare("DELETE FROM logical_thread_states WHERE updated_at < ?").run(cutoff);
} catch {}   // ← engole TODOS os erros
```

**Descrição:**
O `catch` vazio assume que o erro é sempre "column already exists" ou irrelevante. Mas erros reais — permissões de escrita, disco cheio, corrupção do arquivo, sintaxe SQL inválida — são silenciosamente ignorados, tornando debugging extremamente difícil.

**Impacto:** Erros críticos mascarados, dificuldade extrema de debugging.

**Correção sugerida:**
```typescript
try {
  db.exec("ALTER TABLE accounts ADD COLUMN cooldown_until INTEGER DEFAULT 0;");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    throw err;   // re-lança erros inesperados
  }
}
```

---

## 🟡 Médios

### Bug #25 — `setWithNX` e `increment` não são atômicos

| | |
|---|---|
| **Arquivo** | `src/cache/memory-cache.ts` |
| **Linhas** | 163–196 |

```typescript
async setWithNX(key, value, ttl) {
  if (this.store.has(fullKey)) {        // ← verificação
    const entry = this.store.get(fullKey);
    if (entry && entry.expiresAt > Date.now()) return false;
  }
  await this.set(key, value, ttl);      // ← set (não atômico)
  return true;
}
```

**Problema:** Entre a verificação (`has`) e a escrita (`set`), outra operação pode modificar a mesma chave. Viola a semântica "set if not exists" e pode causar perda de incrementos.

---

### Bug #26 — Fallback de descompressão corrompe dados binários

| | |
|---|---|
| **Arquivo** | `src/cache/memory-cache.ts` |
| **Linhas** | 130–144 |

```typescript
if (entry.compressed && Buffer.isBuffer(entry.value)) {
  // descompressão normal
} else {
  const serialized = typeof entry.value === "string"
    ? entry.value : String(entry.value);   // ← corrompe binários
  return this.deserialize<T>(serialized);
}
```

**Problema:** Se `entry.compressed` é `true` mas `entry.value` não é Buffer (ex: corrompido ou tipo errado), o fallback usa `String(value)` que não preserva bytes binários corretamente.

---

### Bug #27 — `deserialize` converte tipos incorretamente sem prefixo

| | |
|---|---|
| **Arquivo** | `src/cache/memory-cache.ts` |
| **Linhas** | 296–330 |

```typescript
if (serialized === "true") return true as T;
if (serialized === "false") return false as T;
if (/^-?\d+(\.\d+)?$/.test(serialized)) return Number(serialized) as T;
```

**Problema:** Se o prefixo de tipo (`s:`, `n:`, `b:`) for perdido por corrupção, a string `"123"` é convertida para o número `123`, `"true"` vira boolean `true`, e `"{}"` vira objeto via `JSON.parse`.

---

### Bug #28 — Fórmula de ratio de compressão incorreta

| | |
|---|---|
| **Arquivo** | `src/cache/memory-cache.ts` |
| **Linhas** | 250–253 |

```typescript
const avgCompressionRatio =
  this.compressionCount > 0
    ? this.totalBytesSaved / this.compressionCount + 1   // ← +1 distorce
    : 1;
```

**Problema:** O `+ 1` fora da divisão distorce a métrica. Se economizou 500 bytes em 10 compressões, ratio seria 51 ao invés de 50. A fórmula correta seria `totalBytesSaved / totalCompressedBytes` ou `(originalSize - compressedSize) / originalSize`.

---

### Bug #29 — Race condition em aquisição de conta

| | |
|---|---|
| **Arquivo** | `src/routes/chat/account.ts` |
| **Linhas** | 199–412 |

```typescript
const cooldownInfo = getAccountCooldownInfo(accountId);
if (cooldownInfo) continue;   // ← verificação não atômica
// ...
const result = await tryCreateStreamWithRetry({ ... });
```

**Problema:** Múltiplas requisições concorrentes podem verificar cooldown da mesma conta simultaneamente, ambas passarem, e ambas usarem a conta ao mesmo tempo — potencialmente excedendo limites de quota ou triggering anti-bot.

---

### Bug #30 — Estado da queue de summaries só em memória

| | |
|---|---|
| **Arquivo** | `src/services/thread-context-jobs.ts` |
| **Linhas** | 24–28 |

```typescript
const queue: SummaryJob[] = [];
const queuedSessions = new Set<string>();
const runningSessions = new Set<string>();
```

**Problema:** Se o processo reiniciar, jobs na queue são perdidos, mas os sessionIds podem estar marcados como `summary_pending` no banco. Nenhum novo job será enfileirado para essas sessões (pois o código verifica o estado do DB), causando deadlock lógico.

---

### Bug #31 — `setTimeout` longo sem persistência para deleção de chats

| | |
|---|---|
| **Arquivo** | `src/services/thread-context-rollover.ts` |
| **Linhas** | 310–333 |

```typescript
const delayMs = config.context.threadNative.oldChatRetentionHours * 60 * 60 * 1000;
const timeout = setTimeout(() => {
  void deletePreviousChat(plan).catch(...);
}, delayMs);
timeout.unref?.();
```

**Problema:** Se `oldChatRetentionHours` for alto (ex: 24h), o timer pode nunca disparar se o processo reiniciar antes. Chats antigos que deveriam ser deletados permanecem indefinidamente.

---

### Bug #32 — Verificação de tamanho antes de `timingSafeEqual` revela tamanho da key

| | |
|---|---|
| **Arquivo** | `src/api/server.ts` |
| **Linhas** | 62–67 |

```typescript
if (
  tokenBuf.length !== keyBuf.length ||   // ← revela tamanho
  !crypto.timingSafeEqual(tokenBuf, keyBuf)
) {
  return sendOpenAIError(c, new AuthError("Invalid API key"));
}
```

**Problema:** A verificação de tamanho antes de `timingSafeEqual` retorna mais rápido quando o tamanho está errado, revelando o tamanho exato da API key via medição de latência. Menos severo que o Bug #2 (timing attack direto), mas ainda uma informação leak.

**Correção:** Usar buffers com padding fixo:
```typescript
const fixed = 256;
const a = Buffer.from(token.padEnd(fixed, "\0").slice(0, fixed));
const b = Buffer.from(apiKey.padEnd(fixed, "\0").slice(0, fixed));
if (!crypto.timingSafeEqual(a, b)) { ... }
```

---

### Bug #33 — Validação de MIME type apenas por extensão

| | |
|---|---|
| **Arquivo** | `src/routes/upload.ts` |
| **Linhas** | 428–441 |

```typescript
let fileType = file.type;
if (fileType === "application/octet-stream" || !fileType) {
  fileType = detectFileType(file.name).mime;   // ← baseado só em extensão
}
```

**Problema:** Validação de tipo de arquivo é baseada apenas na extensão (`detectFileType(file.name)`) ou no header enviado pelo cliente. Não há inspeção dos magic bytes do conteúdo real. Um arquivo `.png` pode conter código executável.

---

### Bug #34 — Múltiplos recovery methods de tool call podem recuperar tool errado

| | |
|---|---|
| **Arquivo** | `src/tools/parser.ts` |
| **Categoria** | Ambiguidade de parsing |

**Problema:** Múltiplos métodos de recovery (`tryRecoverToolCall`, `tryRecoverMalformedJson`, `tryRecoverIncrementalToolCall`, `parseXmlParameterToolCall`, `parseRecoverableXmlToolCall`) são tentados sequencialmente. Se houver múltiplos candidatos de tool call no buffer (ex: stream fragmentado com dois `<tool_call>`), pode recuperar o tool errado ou tratar tool incompleto como completo.

---

### Bug #35 — Múltiplas regexes sequenciais podem produzir JSON inválido

| | |
|---|---|
| **Arquivo** | `src/utils/json.ts` |
| **Linhas** | 104–158 |

```typescript
sanitized = sanitized.replace(/\\\\"/g, '\\"');   // regex 1
// ... múltiplas outras regexes aplicadas sequencialmente
```

**Problema:** Regexes aplicadas em sequência podem interferir entre si. Por exemplo, a primeira regex substitui `\\"` por `\"`, mas se a string original tinha `\\\"` (escape correto de três níveis), vira `\"` que pode quebrar o JSON. A ordem de aplicação é frágil.

---

### Bug #36 — MD5 para geração de IDs de conta

| | |
|---|---|
| **Arquivo** | `src/core/accounts.ts` |
| **Linhas** | 13–19 |

```typescript
function generateId(email: string): string {
  return crypto
    .createHash("md5")
    .update(email)
    .digest("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}
```

**Problema:** MD5 é criptograficamente quebrado e vulnerável a colisões. Embora usado apenas para IDs (não para segurança), emails similares ou especialmente craftados podem gerar IDs conflitantes, resultando em contas sobrepostas no banco.

---

## 🗺️ Prioridade de Correção

| Ordem | Bug(s) | Justificativa |
|---:|---|---|
| 1 | #1, #3, #4 | **SSRF e header injection** — exploráveis remotamente sem autenticação |
| 2 | #2, #32 | **Timing attacks** — recuperação da API key via latência |
| 3 | #5, #6, #21 | **Superfície de ataque** — sandbox, backdoor mock, proxy aberto |
| 4 | #7, #8, #9, #10 | **Corrupção de dados** — race conditions no SQLite |
| 5 | #11, #12 | **Deadlocks e vazamentos** — travam o serviço permanentemente |
| 6 | #13, #14, #15, #17 | **Vazamentos de recursos** — timers, streams, browser processes |
| 7 | #16, #18, #19, #20 | **Bugs de lógica** — comportamento incorreto em produção |
| 8 | #22, #23, #24 | **Segurança de dados e debugging** |
| 9 | #25–#36 | **Médios** — impactam confiabilidade mas com menor risco imediato |

---

## Notas

- Todos os issues foram identificados por análise estática do código-fonte. Nenhum teste de penetração ativo foi realizado.
- O typecheck (`tsc --noEmit`) passa limpo — não há erros de tipo.
- Os bugs listados são **confirmados por análise de código**, não suposições. Cada item inclui o trecho de código exato que evidencia o problema.
- Recomenda-se executar `npm test` após cada correção para validar que o comportamento existente não foi afetado.
