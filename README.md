# QwenBridge

API compatível com OpenAI que conecta clientes ao **Qwen (`chat.qwen.ai`)** com suporte a múltiplas contas, tool calling robusto, uploads multimodais e sessões persistentes. Inclui modo Playwright com stealth para evasão de anti-bot, rotação com cooldown, variantes `-no-thinking`, sumarização de contexto, cache comprimido e observabilidade.

[![CI](https://github.com/johngbl/QwenBridge/actions/workflows/ci.yml/badge.svg)](https://github.com/johngbl/QwenBridge/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.12-green)](https://hono.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

---

## Principais funcionalidades

- **Compatibilidade OpenAI** — Endpoints `/v1/chat/completions`, `/v1/models`, `/v1/chat/completions/stop` e `/v1/upload`.
- **Compatibilidade Anthropic** — Endpoint `/v1/messages` para SDKs Anthropic.
- **Playwright com stealth** — Captura de headers reais (`bx-ua`, `bx-umidtoken`) por conta com `playwright-extra` e `puppeteer-extra-plugin-stealth`.
- **Anti-bot retry** — Detecção automática de `FAIL_SYS_USER_VALIDATE`/`RGV587_ERROR` com retry e rotação de conta.
- **Dynamic timeouts** — Timeout baseado no tamanho do payload (`120s + 30s/MB`).
- **Payload size limit** — Validação de tamanho (10MB) antes de enviar ao Qwen.
- **Modelos Qwen atuais** — Funciona com a família `qwen3.x` e expõe variantes sintéticas `-no-thinking`.
- **Múltiplas contas** — Rotação round-robin, cooldown automático e inicialização paralela.
- **Persistência de sessão** — Cookies/JWT do Qwen persistidos por conta no SQLite.
- **Uploads multimodais** — Imagens, vídeo, áudio e documentos enviados ao OSS do Qwen.
- **Tool calling robusto** — Parser tolerante a stream fragmentado, JSON malformado e blocos XML/Hermes-style.
- **Gerenciamento de contexto** — Truncamento, sumarização, detecção de tópico e preservação de sessão.
- **Cache com compressão Brotli** — TTL em memória, métricas e serialização segura.
- **Observabilidade** — `/health`, `/metrics`, watchdog e métricas Prometheus.
- **Deploy simples** — `npm`, Docker e graceful shutdown.

---

## Arquitetura

```mermaid
flowchart TD
    Client["Cliente OpenAI/SDK"] -->|HTTP| Proxy["QwenBridge - Hono"]
    Proxy --> Chat["/v1/chat/completions"]
    Proxy --> Models["/v1/models"]
    Proxy --> Upload["/v1/upload"]
    Proxy --> Anthropic["/v1/messages"]
    Chat --> Context["Context manager"]
    Context --> Topic["Topic detector"]
    Context --> Summary["Context summarizer"]
    Chat --> Accounts["Account manager"]
    Accounts --> DB[("SQLite")]
    Accounts --> Auth["Auth service"]
    Auth --> Playwright["Playwright + Stealth"]
    Auth --> HTTP["HTTP auth"]
    Playwright --> Qwen
    HTTP --> Qwen
    Chat --> Parser["Tool-call parser"]
    Chat --> Qwen["chat.qwen.ai"]
    Upload --> OSS["Qwen OSS upload"]
```

---

## Modos de autenticação

### Playwright (padrão)

Captura headers reais do browser (`bx-ua`, `bx-umidtoken`) por conta. Usa `playwright-extra` com `puppeteer-extra-plugin-stealth` para evasão de anti-bot.

```env
PLAYWRIGHT_ENABLED=true   # padrão
PLAYWRIGHT_HEADLESS=true
PLAYWRIGHT_BROWSER=chromium
```

**Requisitos:**
```bash
npx playwright install chromium
```

### HTTP (legado)

Login direto via API do Qwen. Mais rápido mas sem headers de fingerprint.

```env
PLAYWRIGHT_ENABLED=false
```

---

## Modelos e contexto

- `qwen3.7-plus` → contexto interno configurado em `1_000_000`
- `qwen3.7-max` → contexto interno configurado em `1_000_000`
- `qwen3.6-plus` → contexto interno configurado em `1_000_000`
- `qwen3.5-flash` → contexto interno configurado em `1_000_000`
- **Fallback para modelos desconhecidos** → `262_144`

### Variantes `-no-thinking`

- `qwen3.7-plus-no-thinking`
- `qwen3.7-max-no-thinking`
- `qwen3.6-plus-no-thinking`
- `qwen3.5-flash-no-thinking`

---

## Pré-requisitos

| Dependência | Versão mínima | Observação |
|---|---:|---|
| Node.js | 20+ | Recomendado usar LTS |
| npm | 9+ | Incluído com Node |
| Playwright | - | Para modo Playwright (`npx playwright install chromium`) |
| Docker | opcional | Para deploy em container |

---

## Instalação

### Via npm

```bash
git clone https://github.com/johngbl/QwenBridge.git
cd QwenBridge
npm install
npx playwright install chromium  # Se usar Playwright
```

### Via Docker

```bash
docker-compose up -d
```

---

## Início rápido

Crie um `.env` na raiz. O `.env.example` contém apenas as opções mais comuns.

### Exemplo mínimo

```env
QWEN_ACCOUNTS=user1@example.com:senha1,user2@example.com:senha2
```

### Iniciar

```bash
npm start
```

---

## Testes

```bash
npm test           # Todos
npm run test:mock  # Só mocks
npm run test:live  # Só reais/live
```

---

## Variáveis de ambiente

### Rede e segurança

| Variável | Default | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP do proxy. |
| `HOST` | `0.0.0.0` | Host de bind. Para uso local, `127.0.0.1`. |
| `API_KEY` | vazio | Protege rotas `/v1/*` com `Authorization: Bearer ...`. |

### Autenticação e sessão

| Variável | Default | Descrição |
|---|---|---|
| `QWEN_ACCOUNTS` | vazio | Contas no formato `email1:senha1,email2:senha2`. |
| `DELETE_ALL_CHATS_ON_SHUTDOWN` | `false` | Limpa chats no shutdown. |

### Playwright

| Variável | Default | Descrição |
|---|---|---|
| `PLAYWRIGHT_ENABLED` | `true` | Usa Playwright para capturar headers reais. |
| `PLAYWRIGHT_HEADLESS` | `true` | Browser headless (sem janela). |
| `PLAYWRIGHT_BROWSER` | `chromium` | Navegador: `chromium`, `chrome`, `edge`. |

### Headers anti-bot

| Variável | Default | Descrição |
|---|---|---|
| `USER_AGENT` | Chrome 145 macOS | User-Agent das chamadas HTTP. |
| `QWEN_BX_UA` | Token real | Header `bx-ua` de fingerprint. |
| `QWEN_BX_UMIDTOKEN` | Token real | Header `bx-umidtoken` de fingerprint. |
| `QWEN_BX_V` | `2.5.36` | Versão `bx-v`. |

### Delays e retry

| Variável | Default | Descrição |
|---|---|---|
| `RETRY_BASE_DELAY_MS` | `1000` | Delay base para retries (exponential backoff). |
| `RETRY_MAX_DELAY_MS` | `10000` | Cap do exponential backoff. |
| `ANTI_BOT_BASE_DELAY_MS` | `5000` | Delay base para erros anti-bot. |
| `ANTI_BOT_MAX_DELAY_MS` | `30000` | Cap do exponential backoff anti-bot. |
| `ACCOUNT_COOLDOWN_MS` | `60000` | Cooldown padrão (Qwen sobrescreve quando informa tempo). |

### Timeouts

| Variável | Default | Descrição |
|---|---|---|
| `HTTP_TIMEOUT` | `10000` | Timeout HTTP genérico. |
| `TOTAL_REQUEST_TIMEOUT` | `300000` | Timeout máximo de geração. |
| `REASONING_MODEL_TIMEOUT` | `600000` | Timeout para modelos com reasoning. |

**Nota:** Timeouts são dinâmicos: `120s + 30s por MB de payload`.

### Cache

| Variável | Default | Descrição |
|---|---|---|
| `CACHE_TTL` | `3600` | TTL do cache em segundos. |
| `CACHE_COMPRESSION_ENABLED` | `true` | Compressão Brotli. |

### Contexto

| Variável | Default | Descrição |
|---|---|---|
| `CONTEXT_MODE` | `thread-native` | `thread-native` ou `full-history`. |
| `CONTEXT_SUMMARIZATION_ENABLED` | `true` | Sumarização de mensagens antigas. |
| `CONTEXT_SUMMARIZATION_MODEL` | `qwen3.5-flash` | Modelo para sumarização. |

### Observabilidade

| Variável | Default | Descrição |
|---|---|---|
| `METRICS_INTERVAL` | `10000` | Intervalo de métricas. |
| `WATCHDOG_INTERVAL` | `5000` | Intervalo do watchdog. |
| `RAM_WARNING` | `80` | % RAM para warning. |
| `RAM_CRITICAL` | `95` | % RAM para critical. |

---

## Anti-bot

O QwenBridge detecta automaticamente erros de anti-bot:

- `FAIL_SYS_USER_VALIDATE`
- `RGV587_ERROR`

**Fluxo:**
1. Erro detectado → retry com delay exponencial + jitter
2. Retry falha → rotação para próxima conta
3. Todas falham → erro retornado ao cliente

**Com Playwright:** Cada conta tem seu próprio fingerprint (`bx-ua`, `bx-umidtoken`) capturado do browser real.

---

## Endpoints

### OpenAI Compatible

| Rota | Método | Descrição |
|---|---|---|
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |
| `/v1/chat/completions/stop` | POST | Abortar geração ativa |
| `/v1/models` | GET | Listar modelos |
| `/v1/models/:id` | GET | Modelo específico |

### Anthropic Compatible

| Rota | Método | Descrição |
|---|---|---|
| `/v1/messages` | POST | Mensagens (formato Anthropic) |
| `/v1/messages/count_tokens` | POST | Contar tokens |

### Utilidades

| Rota | Método | Descrição |
|---|---|---|
| `/health` | GET | Health check |
| `/metrics` | GET | Métricas Prometheus |
| `/v1/upload` | POST | Upload de arquivos |

---

## Exemplos de uso

### OpenAI SDK (Node.js)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "sua-api-key",
});

const completion = await client.chat.completions.create({
  model: "qwen3.7-plus",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(completion.choices[0].message.content);
```

### Anthropic SDK

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3000",
  apiKey: "sua-api-key",
});

const message = await client.messages.create({
  model: "qwen3.7-plus",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(message.content[0].text);
```

### cURL

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-api-key" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

## Tool calling

O parser suporta:
- Tags `<tool_call>` XML
- Formato Hermes-style
- JSON malformado (strings sem aspas, quotes escapadas)
- Stream fragmentado

---

## Anthropic Model Mapping

| Claude Model | Qwen Model |
|---|---|
| `claude-opus-4-*` | `qwen3.7-max` |
| `claude-sonnet-4-*` | `qwen3.7-plus` |
| `claude-haiku-4-*` | `qwen3.5-flash` |
| `claude-3-5-sonnet` | `qwen3.7-plus` |
| `claude-3-opus` | `qwen3.7-max` |
| `claude-3-sonnet` | `qwen3.6-plus` |
| `claude-3-haiku` | `qwen3.5-flash` |

---

## Deploy com Docker

```yaml
services:
  qwenbridge:
    build: .
    container_name: qwenbridge
    ports:
      - "${PORT:-3000}:3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
      - ./qwen_profiles:/app/qwen_profiles
    restart: unless-stopped
```

---

## Estrutura do projeto

```
QwenBridge/
├── src/
│   ├── api/              # Server, models, error helpers
│   ├── cache/            # Memory cache com Brotli
│   ├── core/             # Config, accounts, database, metrics
│   ├── routes/
│   │   ├── anthropic/    # Anthropic API compatible
│   │   └── chat/         # Chat completions, streaming
│   ├── services/
│   │   ├── auth-http.ts  # HTTP auth
│   │   ├── playwright.ts # Playwright + stealth
│   │   └── qwen.ts       # Qwen API integration
│   ├── tools/            # Tool parser, linter, registry
│   └── utils/            # JSON parser, context truncation
├── data/                 # SQLite, profiles (gitignored)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Scripts úteis

| Comando | Descrição |
|---|---|
| `npm start` | Iniciar servidor |
| `npm run login` | Gerenciar contas |
| `npm test` | Rodar todos os testes |
| `npm run test:mock` | Testes com mock |
| `npm run test:live` | Testes reais |
| `npm run typecheck` | Verificar tipos |
| `npm run test:direct` | Testar API diretamente |

---

## Troubleshooting

| Problema | Solução |
|---|---|
| Anti-bot bloqueando | Ative Playwright (`PLAYWRIGHT_ENABLED=true`) |
| Quota exceeded | Adicione mais contas ou espere cooldown |
| Timeout em requests grandes | Aumente `TOTAL_REQUEST_TIMEOUT` |
| Playwright não inicia | Execute `npx playwright install chromium` |
| Porta em uso | Altere `PORT` no `.env` |
| Sessão expirada | Execute `npm run login` para renovar |

---

## Disclaimer

Este projeto é fornecido para fins educacionais e de pesquisa. Use por sua conta e risco.
