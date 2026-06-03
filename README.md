# QwenProxy

Proxy local compatível com OpenAI para usar o **Qwen (`chat.qwen.ai`)** por meio de automação com Playwright. Esta branch inclui suporte a múltiplas contas, rotação com cooldown, variantes `-no-thinking`, uploads multimodais, detecção de mudança de tópico, sumarização de contexto, cache comprimido e observabilidade básica.

[![CI](https://github.com/pedrofariasx/qwenproxy/actions/workflows/ci.yml/badge.svg)](https://github.com/pedrofariasx/qwenproxy/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.12-green)](https://hono.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-blueviolet)](https://playwright.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

---

## Principais funcionalidades

- **Compatibilidade OpenAI** — Endpoints `/v1/chat/completions`, `/v1/models`, `/v1/chat/completions/stop` e `/v1/upload`.
- **Modelos Qwen atuais** — Funciona com a família `qwen3.x` e expõe variantes sintéticas `-no-thinking` para respostas sem reasoning.
- **Múltiplas contas** — Rotação round-robin, cooldown automático por rate limit e inicialização paralela das contas configuradas.
- **Persistência de sessão** — Perfis de navegador por conta em `qwen_profiles/`.
- **Login automático** — Pode usar `QWEN_EMAIL`/`QWEN_PASSWORD`, contas persistidas em SQLite ou sincronização via `QWEN_ACCOUNTS`.
- **Uploads multimodais** — Imagens, vídeo, áudio e documentos enviados ao OSS do Qwen e reutilizados no chat.
- **Tool calling robusto** — Parser tolerante a stream fragmentado, JSON malformado e também blocos XML/Hermes-style.
- **Validação de tools** — Linter para nomes, descrições e JSON Schema antes do registro.
- **Gerenciamento de contexto** — Truncamento, sumarização opcional, detecção opcional de mudança de tópico e preservação do encadeamento de sessão upstream.
- **Cache com compressão Brotli** — TTL em memória, métricas e serialização segura de primitivos.
- **Observabilidade** — `/health`, `/metrics`, watchdog e métricas Prometheus.
- **Deploy simples** — `npm`, Docker e graceful shutdown.

---

## Arquitetura

```mermaid
flowchart TD
    Client["Cliente OpenAI/SDK"] -->|HTTP| Proxy["QwenProxy - Hono"]
    Proxy --> Chat["/v1/chat/completions"]
    Proxy --> Models["/v1/models"]
    Proxy --> Upload["/v1/upload"]
    Chat --> Context["Context manager"]
    Context --> Topic["Topic detector"]
    Context --> Summary["Context summarizer"]
    Chat --> Accounts["Account manager"]
    Accounts --> DB[("SQLite")]
    Accounts --> PW["Playwright service"]
    PW --> Profiles["qwen_profiles/"]
    Chat --> Parser["Tool-call parser"]
    Chat --> Qwen["chat.qwen.ai"]
    Upload --> OSS["Qwen OSS upload"]
```

---

## Modelos e contexto

Hoje a branch está alinhada com os modelos reais mais recentes retornados por `/v1/models`:

- `qwen3.7-plus` → contexto interno configurado em `1_000_000`
- `qwen3.7-max` → contexto interno configurado em `1_000_000`
- `qwen3.6-plus` → contexto interno configurado em `1_000_000`
- `qwen3.5-flash` → contexto interno configurado em `1_000_000`
- **Fallback para modelos desconhecidos** → `262_144`

### Variantes `-no-thinking`

O proxy expõe automaticamente versões como:

- `qwen3.7-plus-no-thinking`
- `qwen3.7-max-no-thinking`
- `qwen3.6-plus-no-thinking`
- `qwen3.5-flash-no-thinking`

Essas variantes usam o mesmo modelo base, mas desativam o modo de thinking no payload enviado ao Qwen.

---

## Pré-requisitos

| Dependência | Versão mínima | Observação |
|---|---:|---|
| Node.js | 20+ | Recomendado usar LTS |
| npm | 9+ | Incluído com Node |
| Playwright | atual | Instale os browsers com `npx playwright install` |
| Docker | opcional | Para deploy em container |

---

## Instalação

### Via npm

```bash
git clone https://github.com/pedrofariasx/qwenproxy.git
cd qwenproxy
npm install
npx playwright install
```

### Via Docker

```bash
docker-compose up -d
```

---

## Início rápido

Crie um `.env` na raiz. O `.env.example` contém apenas as opções mais comuns; a lista completa está documentada abaixo.

### Exemplo mínimo — uma conta

```env
PORT=3000
HOST=127.0.0.1
API_KEY=troque-por-uma-chave-forte
HEADLESS=true

QWEN_EMAIL=seu-email@exemplo.com
QWEN_PASSWORD=sua-senha
```

### Exemplo mínimo — múltiplas contas via env

```env
PORT=3000
HOST=127.0.0.1
API_KEY=troque-por-uma-chave-forte
HEADLESS=true

QWEN_ACCOUNTS=user1@example.com:senha1,user2@example.com:senha2
```

### Iniciar

```bash
npm start
```

Existem scripts `start:chrome`, `start:firefox` e `start:edge` no `package.json`, mas o bootstrap atual do servidor ainda não consome `--browser` no `src/index.ts`. Hoje, a seleção explícita de browser funciona de forma confiável no **CLI de login** (`npm run login:*`).

---

## Todas as variáveis de ambiente

## Rede e segurança

| Variável | Default | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP do proxy. |
| `HOST` | `0.0.0.0` | Host de bind do servidor. Para uso local, prefira `127.0.0.1`. |
| `API_KEY` | vazio | Protege todas as rotas `/v1/*` com `Authorization: Bearer ...`. |

## Navegador e sessão

| Variável | Default | Descrição |
|---|---|---|
| `HEADLESS` | `true` | Liga o Playwright em modo headless quando não for `false`. |
| `LOG_CONSOLE` | `false` | Liga logs de console do browser quando suportado pelo fluxo atual. |
| `QWEN_EMAIL` | vazio | Credencial de login automático para o modo single-account/global. |
| `QWEN_PASSWORD` | vazio | Senha usada junto com `QWEN_EMAIL`. |
| `QWEN_ACCOUNTS` | vazio | Lista de múltiplas contas no formato `email1:senha1,email2:senha2`. Essas contas são sincronizadas para o SQLite. |
| `BROWSER` | vazio | Usado principalmente pelo `src/login.ts` para escolher o browser do CLI (`chromium`, `chrome`, `firefox`, `edge`, `webkit`). |
| `USER_DATA_DIR` | `./qwen_profiles` | Config avançada/reservada. A persistência real continua em `qwen_profiles/` por conta. |
| `USER_AGENT` | valor padrão de browser | Config avançada/reservada; o fluxo principal usa user agents próprios no Playwright. |

## Timeouts

| Variável | Default | Descrição |
|---|---|---|
| `NAVIGATION_TIMEOUT` | `30000` | Timeout de navegação do Playwright. |
| `PAGE_TIMEOUT` | `15000` | Timeout para operações de página/seletores. |
| `HTTP_TIMEOUT` | `10000` | Timeout HTTP genérico. |
| `CHAT_TIMEOUT` | `120000` | Timeout máximo de uma geração upstream do Qwen. |

## Cache e compressão

| Variável | Default | Descrição |
|---|---|---|
| `CACHE_TTL` | `3600` | TTL padrão do cache em memória, em segundos. |
| `RESPONSE_TTL` | `1800` | TTL para respostas cacheáveis, em segundos. |
| `CACHE_COMPRESSION_ENABLED` | `true` | Liga compressão Brotli no cache. |
| `CACHE_COMPRESSION_THRESHOLD` | `1024` | Tamanho mínimo, em bytes, para comprimir um valor. |
| `CACHE_COMPRESSION_LEVEL` | `6` | Nível Brotli (`1` a `11`). |

## Contexto e qualidade de conversa

| Variável | Default | Descrição |
|---|---|---|
| `TOPIC_DETECTION_ENABLED` | `true` | Liga a detecção de mudança de tópico. |
| `TOPIC_DETECTION_CONFIDENCE` | `0.7` | Limiar da confiança de mudança de tópico. Quanto maior, mais conservador. |
| `CONTEXT_SUMMARIZATION_ENABLED` | `true` | Liga a sumarização de mensagens antigas quando o contexto cresce. |
| `CONTEXT_SUMMARIZATION_MODEL` | `qwen3.5-flash` | Modelo usado na auto-sumarização. |
| `CONTEXT_SUMMARIZATION_TIMEOUT` | `15000` | Timeout da chamada interna de sumarização, em ms. |
| `CONTEXT_MIN_MESSAGES_TO_KEEP` | `4` | Quantidade mínima de mensagens recentes preservadas integralmente antes de resumir o histórico mais antigo. |

## Observabilidade e watchdog

| Variável | Default | Descrição |
|---|---|---|
| `METRICS_INTERVAL` | `10000` | Intervalo de coleta de métricas. |
| `WATCHDOG_INTERVAL` | `5000` | Intervalo de checagem do watchdog. |
| `WATCHDOG_FAILURES` | `3` | Número de falhas consecutivas antes de marcar degradação. |
| `RAM_WARNING` | `80` | Percentual de RAM para warning. |
| `RAM_CRITICAL` | `95` | Percentual de RAM para critical. |
| `WS_WARNING` | `50` | Limite de streams ativos para warning. |
| `WS_CRITICAL` | `100` | Limite de streams ativos para critical. |

## Avançadas / compatibilidade

| Variável | Default | Descrição |
|---|---|---|
| `QWEN_BASE_URL` | `https://chat.qwen.ai` | Valor reservado/compatibilidade para integrações futuras. |
| `QWEN_HTTP_ENDPOINT` | `https://api.qwen.ai/v1/chat` | Valor reservado/compatibilidade. |
| `QWEN_API_KEY` | vazio | Reservado para cenários alternativos; o fluxo principal da branch usa sessão autenticada do Qwen via browser. |

---

## Como o contexto funciona

### Janela de contexto

O proxy estima tokens com uma heurística simples (`aprox. caracteres / 3.5`).

> Isso é **aproximado, não um tokenizer oficial do Qwen**.

Essa estimativa é boa o suficiente para operar, mas pode divergir em casos com muito código, JSON grande, tool calls extensos ou conteúdo multimodal.

### Quando a sumarização entra em ação

Quando habilitada, a sumarização começa a ser considerada em torno de **90% da janela de contexto do modelo**.

Fluxo resumido:

1. o proxy estima o tamanho do prompt;
2. se passar de ~`90%` do contexto do modelo, ativa o truncamento inteligente;
3. se `CONTEXT_SUMMARIZATION_ENABLED=true`, ele resume o histórico mais antigo;
4. preserva as últimas `CONTEXT_MIN_MESSAGES_TO_KEEP` mensagens completas.

A sumarização é feita por uma chamada interna ao próprio endpoint `/v1/chat/completions` com o header `X-Internal-Summarization: true`.

### Topic detection

A detecção de mudança de tópico só é útil quando o cliente envia **`conversation_id`** ou **`session_id`**. Isso evita poluição entre conversas diferentes.

Quando a mudança é forte o bastante, a branch atual:

- marca a troca de tópico,
- zera a cadeia de `parent_id` upstream para aquela conversa,
- e começa um novo fio lógico no Qwen sem misturar contexto antigo.

Ela também entende frases explícitas como:

- `mudando de assunto`
- `outra coisa`
- `new topic`
- `never mind`

---

## Gerenciamento de contas

As contas ficam em SQLite, em `data/qwenproxy.db`.

### CLI interativo

```bash
npm run login
npm run login:chrome
npm run login:firefox
npm run login:edge
```

O menu permite:

- **[A]** adicionar conta com credenciais
- **[M]** adicionar conta por login manual no navegador
- **[R]** remover conta
- **[L]** inicializar/login em todas as contas

### Modos suportados

- **Single-account/global**: usa `QWEN_EMAIL` + `QWEN_PASSWORD`.
- **Multi-account persistido**: contas salvas no SQLite pelo CLI.
- **Multi-account via env**: `QWEN_ACCOUNTS` sincroniza contas para o SQLite periodicamente.

### Rotação e cooldown

Quando uma conta recebe rate limit ou erro crítico upstream, o gerenciador pode:

- colocar a conta em cooldown temporário;
- escolher a próxima conta disponível;
- manter a requisição viva com retry controlado quando fizer sentido.

---

## Endpoints

| Rota | Método | Descrição |
|---|---|---|
| `/v1/chat/completions` | `POST` | Compatível com OpenAI, streaming e non-streaming. |
| `/v1/chat/completions/stop` | `POST` | Aborta uma geração ativa. |
| `/v1/models` | `GET` | Lista os modelos disponíveis, incluindo variantes `-no-thinking`. |
| `/v1/models/:model` | `GET` | Retorna os metadados de um modelo específico. |
| `/v1/upload` | `POST` | Faz upload de arquivo para o OSS do Qwen e retorna `url`, `file_id`, `filename` e `type`. |
| `/health` | `GET` | Health check com estado geral e métricas básicas. |
| `/metrics` | `GET` | Métricas Prometheus. |

---

## Upload multimodal

A rota `/v1/upload` aceita `multipart/form-data` com um campo `file`.

### Tipos suportados

- **Imagem**: `png`, `jpg`, `jpeg`, `gif`, `webp`
- **Vídeo**: `mp4`, `mov`, `avi`, `webm`, `mkv`
- **Áudio**: `mp3`, `wav`, `ogg`, `flac`, `m4a`, `aac`
- **Documentos/arquivos**: `pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `txt`, `md`, `csv`, `json`, `xml`, `html`, `zip`

### Limites atuais

- imagem/documento: **20 MB**
- áudio: **50 MB**
- vídeo: **100 MB**

### Observação importante

Se a autenticação do Qwen ainda não estiver pronta, o upload pode responder:

- `503 Authentication not ready. Send a chat message first.`

Ou seja: na prática, é recomendado iniciar a sessão do browser primeiro com pelo menos uma requisição de chat.

---

## Exemplos de uso

### OpenAI SDK (Node.js)

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:3000/v1",
  apiKey: process.env.API_KEY || "dev-key",
});

const completion = await client.chat.completions.create({
  model: "qwen3.7-plus",
  conversation_id: "demo-conv-1",
  messages: [
    { role: "system", content: "Você é um assistente técnico." },
    { role: "user", content: "Explique como funciona o Playwright." },
  ],
});

console.log(completion.choices[0].message);
```

### Variante sem thinking

```ts
const completion = await client.chat.completions.create({
  model: "qwen3.7-plus-no-thinking",
  messages: [{ role: "user", content: "Resuma em 3 bullets." }],
});
```

### cURL

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave" \
  -d '{
    "model": "qwen3.7-plus",
    "conversation_id": "curl-demo-1",
    "stream": false,
    "messages": [
      {"role": "user", "content": "Explique Hono em poucas palavras."}
    ]
  }'
```

### Upload de arquivo

```bash
curl http://127.0.0.1:3000/v1/upload \
  -H "Authorization: Bearer sua-chave" \
  -F "file=@./exemplo.pdf"
```

Exemplo de resposta:

```json
{
  "url": "https://.../arquivo.pdf",
  "file_id": "abc123",
  "filename": "arquivo.pdf",
  "type": "file"
}
```

### Mensagem multimodal usando URL retornada do upload

```json
{
  "model": "qwen3.7-plus",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Analise este PDF" },
        {
          "type": "file_url",
          "file_url": { "url": "https://.../arquivo.pdf" }
        }
      ]
    }
  ]
}
```

---

## Tool calling

A branch suporta tool calling com parser de stream robusto para blocos `<tool_call>...</tool_call>`.

### O que ela faz bem

- tolera JSON incompleto ou levemente malformado;
- aceita blocos fragmentados por streaming;
- consegue interpretar formatos XML/Hermes-style;
- preserva texto fora dos blocos de tool call;
- valida definições de tools com linter antes do registro.

Isso é especialmente útil para clientes compatíveis com o estilo OpenAI tools/function calling.

---

## Observabilidade

### `/health`

Retorna estado geral do serviço, timestamp e métricas básicas do cache.

### `/metrics`

Exporta métricas Prometheus, incluindo contadores e histogramas de requisições.

### Watchdog

Monitora:

- falhas consecutivas;
- pressão de RAM;
- quantidade de streams ativos.

---

## Scripts úteis

```bash
npm start

npm run login
npm run login:chrome
npm run login:firefox
npm run login:edge

npm run typecheck
npm test
npm run benchmark:proxy
```

---

## Estrutura do projeto

```text
qwenproxy/
├── src/
│   ├── api/            # Servidor Hono e endpoints /models
│   ├── benchmarks/     # Benchmark de proxy
│   ├── cache/          # Cache em memória
│   ├── core/           # Config, contas, DB, métricas, watchdog
│   ├── routes/         # Chat e upload
│   ├── services/       # Playwright e integração Qwen
│   ├── tools/          # Parser, executor, linter e tipos de tools
│   ├── utils/          # Contexto, sumarização, JSON robusto, topic detector
│   ├── tests/          # Suite de testes
│   ├── index.ts        # Entry point do servidor
│   └── login.ts        # CLI de gerenciamento de contas
├── data/               # SQLite (gitignored)
├── qwen_profiles/      # Perfis persistidos do browser (gitignored)
├── docker-compose.yml
├── Dockerfile
├── package.json
└── README.md
```

---

## Troubleshooting

| Problema | Causa comum | Solução |
|---|---|---|
| `401 Missing or invalid Authorization header` | `API_KEY` configurada sem header Bearer | Envie `Authorization: Bearer ...` |
| `401 Invalid API key` | Chave errada | Verifique `API_KEY` no servidor e no cliente |
| Upload retorna `503 Authentication not ready` | Sessão do Qwen ainda não capturada | Envie uma requisição de chat primeiro |
| Sessão expirada | Cookies inválidos ou conta deslogada | Rode `npm run login` e reautentique |
| Todas as contas em cooldown | Rate limit ou erro upstream em cascata | Aguarde cooldown ou adicione mais contas |
| Navegador não abre | Playwright/browsers não instalados | Rode `npx playwright install` |
| Conversa misturando assuntos | `conversation_id`/`session_id` ausentes | Envie um identificador explícito se quiser topic detection confiável |
| Sumarização parece cedo/tarde demais | Estimativa heurística de tokens | Ajuste `CONTEXT_*` e lembre que não há tokenizer oficial no cálculo atual |

---

## Deploy com Docker

Exemplo de `docker-compose.yml`:

```yaml
services:
  qwenproxy:
    build: .
    container_name: qwenproxy
    ports:
      - "${PORT:-3000}:3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
      - ./qwen_profiles:/app/qwen_profiles
    restart: unless-stopped
```

Volumes persistentes:

| Volume | Conteúdo |
|---|---|
| `./data` | Banco SQLite com contas e metadados |
| `./qwen_profiles` | Cookies, sessões e perfis de navegador |

---

## Disclaimer

> Este projeto é fornecido estritamente para fins educacionais e de pesquisa.

Os autores não incentivam ou endossam:

- violação dos Termos de Serviço da plataforma Qwen;
- automação não autorizada em larga escala;
- uso para atividades maliciosas.

**Use por sua conta e risco.**
