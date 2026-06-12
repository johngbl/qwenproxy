# Análise confirmada das rotas do QwenBridge

Data da análise: 2026-06-11
Última atualização: 2026-06-12

Este documento registra apenas pontos **confirmados e seguros** sobre as rotas do QwenBridge, com base na leitura do código local e nas documentações públicas indicadas. Ele evita afirmar compatibilidade total quando o comportamento não está implementado ou não foi comprovado.

## Fontes verificadas

### Código local

- `src/api/server.ts`
- `src/api/models.ts`
- `src/routes/chat/index.ts`
- `src/routes/chat/validation.ts`
- `src/routes/chat/streaming.ts`
- `src/routes/responses/index.ts`
- `src/routes/responses/adapter.ts`
- `src/routes/responses/validation.ts` (inclui `UnknownTypedInputSchema` para tipos desconhecidos)
- `src/routes/responses/streaming.ts`
- `src/routes/responses/state.ts`
- `src/routes/responses/types.ts`
- `src/routes/anthropic/index.ts`
- `src/routes/anthropic/translate.ts`
- `src/routes/anthropic/validation.ts`
- `src/routes/anthropic/types.ts`
- `src/utils/types.ts`

### Referências públicas consultadas

- OpenAI Text generation / Responses API: <https://developers.openai.com/api/docs/guides/text>
- OpenAI Chat Completions overview: <https://developers.openai.com/api/reference/chat-completions/overview>
- Anthropic Messages guide: <https://platform.claude.com/docs/en/build-with-claude/working-with-messages>
- OpenRouter com OpenAI SDK: <https://openrouter.ai/docs/guides/community/openai-sdk>
- `cc-switch` público: <https://github.com/farion1231/cc-switch>

Observação: as URLs diretas tentadas para arquivos TypeScript internos do `cc-switch` retornaram `404`. Portanto, este documento **não afirma equivalência interna de implementação** com o `cc-switch`; usa o repositório apenas como referência externa geral de ferramenta/proxy.

## Rotas registradas no servidor

Em `src/api/server.ts`, as rotas são montadas nesta ordem:

1. `modelsApp`
2. `POST /v1/chat/completions`
3. `POST /v1/chat/completions/stop`
4. `POST /v1/upload`
5. `anthropicApp`
6. `responsesApp`
7. `GET /health`
8. `GET /metrics`

Rotas confirmadas:

| Rota | Método | Módulo | Status confirmado |
|---|---:|---|---|
| `/v1/models` | `GET` | `src/api/models.ts` e também `src/routes/anthropic/index.ts` | Existe conflito/duplicidade de definição |
| `/v1/models/:model` | `GET` | `src/api/models.ts` | Implementada em formato OpenAI-like |
| `/v1/models/:model_id` | `GET` | `src/routes/anthropic/index.ts` | Implementada no app Anthropic, mas pode ser sombreada pela rota OpenAI anterior |
| `/v1/chat/completions` | `POST` | `src/routes/chat/index.ts` | Implementada |
| `/v1/chat/completions/stop` | `POST` | `src/routes/chat.ts` / `src/routes/chat/stop.ts` | Implementada |
| `/v1/upload` | `POST` | `src/routes/upload.ts` | Implementada |
| `/v1/messages` | `POST` | `src/routes/anthropic/index.ts` | Implementada |
| `/v1/messages/count_tokens` | `POST` | `src/routes/anthropic/index.ts` | Implementada com estimativa simples |
| `/v1/responses` | `POST` | `src/routes/responses/index.ts` | Implementada |
| `/v1/responses/:response_id` | `GET` | `src/routes/responses/index.ts` | Implementada |
| `/v1/responses/:response_id` | `DELETE` | `src/routes/responses/index.ts` | Implementada |
| `/v1/completions` | `POST` | nenhum módulo encontrado | Não implementada |

## Autenticação confirmada

### Middleware OpenAI-like global

`src/api/server.ts` aplica autenticação em `/v1/*` usando `Authorization: Bearer <API_KEY>` quando `API_KEY`/`config.apiKey` existe.

Isso afeta todas as rotas sob `/v1/*`, incluindo `/v1/messages`, antes da lógica própria Anthropic.

### Autenticação adicional Anthropic

`src/routes/anthropic/index.ts` também valida `x-api-key` em `POST /v1/messages` quando há chave configurada.

Impacto confirmado:

- Um cliente Anthropic puro normalmente envia `x-api-key` e `anthropic-version`.
- Este servidor, por causa do middleware global em `/v1/*`, também pode exigir `Authorization: Bearer ...` antes de chegar à rota Anthropic.
- Portanto, com `API_KEY` configurado, `/v1/messages` pode exigir **duas formas de autenticação**: `Authorization` global e `x-api-key` Anthropic.

Esse comportamento é confirmado pelo código atual e deve ser tratado como ponto de correção ou decisão explícita.

## `/v1/models`: conflito confirmado

Há duas definições para `/v1/models`:

- `src/api/models.ts`
- `src/routes/anthropic/index.ts`

Como `modelsApp` é registrado antes de `anthropicApp` em `src/api/server.ts`, existe risco real de a rota OpenAI-like responder primeiro e impedir a resposta Anthropic específica.

### Impacto

O código Anthropic tenta decidir formato pelo header `anthropic-version`:

- com `anthropic-version`: retorna formato Anthropic;
- sem `anthropic-version`: retorna formato OpenAI-like.

Mas, como a rota OpenAI-like é registrada antes, essa lógica pode não ser alcançada para `GET /v1/models`.

### Correção recomendada segura

Unificar a rota de modelos em um único handler que detecte headers e responda:

- formato Anthropic quando houver `anthropic-version` ou `x-api-key` Anthropic;
- formato OpenAI-like nos demais casos.

Alternativa: registrar uma rota específica Anthropic antes da OpenAI-like, mas a unificação reduz ambiguidade.

## `/v1/chat/completions`

### O que está confirmado como suportado

A rota é implementada em `src/routes/chat/index.ts` e delega para módulos especializados.

Suportes confirmados pelo código:

- `model`
- `messages`
- `stream`
- `tools`
- `tool_choice`
- `stream_options.include_usage`
- `session_id`
- `conversation_id`
- `user`
- mensagens com papéis `system`, `user`, `assistant`, `tool` e `function`
- histórico com `assistant.tool_calls`
- histórico com `tool_call_id`
- conteúdo textual
- conteúdo multimodal OpenAI-like em array para tipos tratados por upload:
  - `image_url`
  - `video_url`
  - `audio_url`
  - `file_url`
- streaming SSE com chunks `chat.completion.chunk`
- resposta final não-streaming `chat.completion`
- emissão de `[DONE]` no streaming
- parsing de tool calls via instruções de prompt e parser interno
- sanitização de tags de reasoning/`<think>`
- `reasoning_content` quando o upstream expõe raciocínio separado ou quando o sanitizador captura conteúdo de raciocínio
- estimativa/acúmulo de uso (`prompt_tokens`, `completion_tokens`, `total_tokens`)
- estado de thread Qwen por `session_id`/`conversation_id`, com cache em memória e persistência SQLite de `logical_thread_states`
- failover/rotação entre contas Qwen quando há quota, rate limit, anti-bot ou sessão inválida
- stop específico em `POST /v1/chat/completions/stop`, dependente de `chat_id` e `response_id` upstream

### Pontos confirmados de compatibilidade parcial

#### Tool calling não é nativo de backend OpenAI

O suporte a tool calls é implementado via:

- injeção de instruções de ferramenta no prompt;
- serialização de tool calls no histórico como blocos `<tool_call>`;
- parser de texto/stream para reconstruir `tool_calls`.

Isso torna a interface compatível com clientes OpenAI em muitos casos, mas não é equivalente a um backend OpenAI nativo que decide tool calls pelo protocolo interno do modelo.

#### Parâmetros OpenAI não modelados no tipo interno

`src/utils/types.ts` define `OpenAIRequest` com um conjunto reduzido:

- `model`
- `messages`
- `stream`
- `tools`
- `tool_choice`
- `user`
- `session_id`
- `conversation_id`
- `stream_options.include_usage`

Campos comuns do Chat Completions oficial, como `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `response_format`, `stop`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `seed`, `n`, `logprobs` e outros, não aparecem no tipo principal lido. Alguns podem existir dinamicamente no objeto em runtime, mas **não há confirmação segura** de suporte completo pela rota Chat.

#### Multimodal tem suporte específico, não geral

A rota Chat processa arrays de conteúdo e tenta upload para partes com URLs em tipos como `image_url`, `video_url`, `audio_url` e `file_url`. O pipeline de upload suporta imagens, vídeos, áudio e documentos por MIME/extensão, com limites confirmados de 100 MB para vídeo, 50 MB para áudio e 20 MB para imagens/documentos.

Porém, quando não há partes reconhecidas para upload, ela extrai apenas partes `text`.

Portanto:

- `image_url.url`, `video_url.url`, `audio_url.url` e `file_url.url` são tratados no fluxo Chat;
- outros formatos ou estruturas podem ser ignorados ou reduzidos para texto;
- o upload pode usar headers da primeira conta antes da seleção/failover final da conta de geração;
- em setups multi-conta, o arquivo pode ser enviado com uma conta e a geração acontecer em outra;
- não há confirmação de paridade total com OpenAI multimodal.

#### Threading, failover e persistência não são semântica OpenAI nativa

O Chat usa estado Qwen próprio:

- `logical_thread_states` em memória + SQLite, TTL de 24h;
- `session_id` e `conversation_id` viram chave lógica derivada;
- em failover, uma thread pode migrar para outra conta/chat Qwen e reconstruir contexto por prompt completo;
- em threads longas, o sistema pode acionar resumo/rollover interno antes de chamar Qwen.

Isso é útil operacionalmente, mas não deve ser documentado como conversa/state oficial OpenAI.

#### Stop/cancelamento é específico do QwenBridge

`POST /v1/chat/completions/stop` existe, mas não é endpoint OpenAI padrão. Ele exige `chat_id` e `response_id` upstream e procura stream ativo em `stream-registry` antes de chamar o endpoint de stop do Qwen.

### Melhorias/correções confirmadas para Chat

1. Documentar oficialmente os campos suportados e ignorados.
2. Validar e/ou rejeitar campos não suportados quando isso for mais seguro para clientes SDK.
3. Confirmar por testes os campos atualmente aceitos de fato:
   - `temperature`
   - `top_p`
   - `max_tokens`
   - `max_completion_tokens`
   - `response_format`
   - `stop`
4. Adicionar testes específicos para:
   - tool calls não-streaming;
   - tool calls streaming incremental;
   - `stream_options.include_usage`;
   - multimodal com `image_url`;
   - mensagens `tool` e `function` no histórico.

## `/v1/responses`

### O que está confirmado como suportado

A rota está implementada em `src/routes/responses/index.ts` e converte internamente para `/v1/chat/completions`.

Campos aceitos pela validação (`src/routes/responses/validation.ts`):

- `model`
- `input` como string
- `input` como array de itens
- `instructions`
- `stream`
- `previous_response_id`
- `tools`
- `tool_choice`
- `temperature`
- `top_p`
- `max_output_tokens`
- `store`
- `user`
- `metadata`
- `parallel_tool_calls`
- `reasoning.effort`
- `reasoning.summary`
- `text.verbosity`
- `truncation`
- `service_tier`

Tipos de input aceitos:

- mensagem comum com `role`: `user`, `assistant`, `system`, `developer`
- `function_call`
- `function_call_output`
- tipos desconhecidos com campo `type` (ex: `reasoning` items do Codex) são aceitos via fallback schema `UnknownTypedInputSchema` e ignorados na conversão para Chat

Tipos de conteúdo aceitos pelo schema:

- `input_text`
- `output_text`
- `text`
- `input_image`
- `input_file`

Endpoints relacionados confirmados:

- `POST /v1/responses`
- `GET /v1/responses/:response_id`
- `DELETE /v1/responses/:response_id`

### Conversões confirmadas

Em `src/routes/responses/adapter.ts`:

- `instructions` vira mensagem `system` prepended.
- `input` string vira mensagem `user`.
- mensagens `system` e `developer` viram `system` no Chat Completions interno.
- `function_call_output` vira mensagem `tool`.
- `function_call` vira mensagem `assistant` com `tool_calls`.
- ferramentas do tipo `function` viram ferramentas Chat Completions.
- `tool_choice` é convertido para formato Chat Completions quando possível.
- `max_output_tokens` vira `max_completion_tokens`.
- `parallel_tool_calls` é repassado para o Chat Request interno.

### Streaming confirmado

O streaming em `src/routes/responses/index.ts`:

- responde `Content-Type: text/event-stream`;
- emite linhas `data: {...}\n\n`;
- não emite linha `event: ...`;
- inclui o tipo do evento no campo JSON `type`;
- emite eventos como:
  - `response.created`
  - `response.in_progress`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.output_item.done`
  - `response.function_call_arguments.delta`
  - `response.function_call_arguments.done`
  - `response.reasoning_summary_text.delta`
  - `response.completed`
  - `response.failed`

Esse formato é compatível com consumidores que leem SSE pelo `data:` e usam `type` dentro do JSON.

### Estado e `previous_response_id`

`src/routes/responses/state.ts` confirma:

- armazenamento em memória por `responseId`;
- limite máximo de `10000` entradas;
- TTL de `24h`;
- `previous_response_id` reconstrói histórico a partir das mensagens Chat armazenadas;
- `store: false` evita armazenamento;
- `GET /v1/responses/:id` retorna apenas respostas ainda presentes/validas na memória;
- `DELETE /v1/responses/:id` remove do armazenamento em memória.

Esse estado é separado da persistência de threads Qwen usada por `/v1/chat/completions`. O `previous_response_id` da rota Responses não usa SQLite e não sobrevive restart.

### Pontos confirmados de compatibilidade parcial

#### Built-in tools são aceitos, mas não executados

A validação aceita ferramentas built-in com `type` arbitrário por schema `.passthrough()`.

Mas `responsesToChatCompletions` filtra e envia somente tools de tipo `function`. O próprio comentário do código confirma que built-ins como `web_search`, `shell` etc. são descartadas silenciosamente.

Impacto:

- `web_search` aceito no JSON não faz busca;
- `file_search` aceito no JSON não faz retrieval;
- `code_interpreter` aceito no JSON não executa código;
- `shell`/`local_shell` aceitos no JSON não executam shell;
- `mcp`/connectors não são executados;
- `tool_search` não é executado.

Correção segura: ou implementar esses tools, ou rejeitar explicitamente com erro claro, ou documentar como `accepted_but_ignored`.

#### `reasoning`, `text.verbosity`, `truncation` e `service_tier`

`reasoning` é agora parcialmente implementado:

- `reasoning_content` do Chat Completions interno é capturado e emitido como output item `type: "reasoning"` com `summary`.
- No streaming, o evento `response.reasoning_summary_text.delta` emite o raciocínio incremental.
- No non-streaming, `reasoning_content` do `choice.message` é extraído e incluído no output.
- Os campos `reasoning.effort` e `reasoning.summary` do request são aceitos na validação mas ainda não alteram o comportamento do backend Qwen.

Os demais campos continuam aceitos mas sem comportamento real:

- `text.verbosity`
- `truncation`
- `service_tier`

Além disso, `chatCompletionsToResponses` preserva alguns metadados, mas não preserva todos:

- preserva no response: `metadata`, `user`, `temperature`, `top_p`, `max_output_tokens`, `parallel_tool_calls`, `tool_choice`, `tools`, `previous_response_id`;
- não inclui no response final, pelo código atual, `text`, `truncation`, `service_tier`.

Impacto: clientes podem enviar esses campos sem erro, mas não devem esperar comportamento oficial completo.

#### `input_image` e `input_file` são aceitos no schema, mas texto é o único conteúdo extraído

A função `extractText` só usa partes:

- `input_text`
- `output_text`
- `text`

Partes `input_image` e `input_file` passam pela validação, mas não são convertidas para upload/backend ou conteúdo multimodal.

Impacto: conteúdo visual/arquivo enviado via Responses pode ser ignorado na conversão.

#### `instructions` com `previous_response_id`

A documentação OpenAI carregada confirma que `instructions` se aplica à geração atual; instruções anteriores não são automaticamente reaplicadas via `previous_response_id`.

No código atual, `instructions` é adicionado como `system` no início das mensagens do request atual. Como o histórico armazenado inclui as mensagens Chat anteriores, pode haver acúmulo de mensagens `system` se requests anteriores foram armazenados com instruções. Isso deve ser revisado se o objetivo for espelhar exatamente a semântica da OpenAI.

#### Cancelamento Responses é tratado parcialmente via disconnect

A rota Responses faz `fetch` interno para `/v1/chat/completions`, mas não há endpoint Responses de cancelamento. Porém, a desconexão do cliente é tratada:

- `enqueue` captura `ERR_INVALID_STATE` (controller fechado) e marca `streamClosed = true`.
- O bloco `finally` verifica `streamClosed` antes de emitir eventos finais, evitando stack trace.
- Erros de cancelamento/abort no catch externo são detectados e silenciados.

Portanto, cancelamento por desconexão funciona sem poluir logs, mas não há endpoint próprio como `POST /v1/responses/:id/cancel`.

### Melhorias/correções confirmadas para Responses

Prioridade alta:

1. Decidir comportamento de built-in tools:
   - implementar;
   - rejeitar;
   - ou documentar explicitamente como ignorados.
2. Adicionar suporte real ou rejeição clara para `input_image` e `input_file`.
3. Ajustar preservação/retorno dos campos aceitos mas não refletidos:
   - `text`
   - `truncation`
   - `service_tier`
4. ~~Preservar `reasoning` no response~~ (implementado em 2026-06-12: `reasoning_content` capturado e emitido como output item `type: "reasoning"`).
5. Criar testes para `previous_response_id` com tool calls.
6. Criar testes para streaming completo, validando ordem e presença de eventos finais.
7. Criar testes para reasoning output (streaming e non-streaming).

Prioridade média:

1. Validar `metadata` conforme limites oficiais se necessário.
2. Adicionar endpoint de cancelamento se o cliente alvo exigir.
3. Avaliar persistência em SQLite se `previous_response_id` precisar sobreviver restart.
4. Evitar drop silencioso de dados multimodais.

## `/v1/messages` Anthropic

### O que está confirmado como suportado

A rota está implementada em `src/routes/anthropic/index.ts`.

Validação confirmada em `src/routes/anthropic/validation.ts`:

- `model` obrigatório;
- `max_tokens` obrigatório;
- `messages` obrigatório e não vazio;
- `messages[].role` aceita `user`, `assistant` e também `system`;
- `content` pode ser string ou array;
- `tools` deve ser array quando presente;
- `tool_choice.type` aceita `auto`, `any`, `tool`, `none`;
- `stream` deve ser boolean quando presente;
- `temperature`, se presente, deve estar entre `0` e `1`.

Tradução confirmada em `src/routes/anthropic/translate.ts`:

- top-level `system` string vira mensagem `system` OpenAI;
- top-level `system` array usa blocos `text` e concatena por newline;
- `user` com texto vira mensagem `user`;
- `assistant` com texto vira mensagem `assistant`;
- `tool_use` Anthropic vira `assistant.tool_calls` OpenAI;
- `tool_result` Anthropic vira mensagem `tool` OpenAI;
- `tools[].input_schema` vira `function.parameters`;
- `tool_choice.auto` vira `auto`;
- `tool_choice.any` vira `required`;
- `tool_choice.tool` vira escolha de função específica;
- `tool_choice.none` vira `none`;
- resposta OpenAI com `message.content` vira bloco Anthropic `text`;
- resposta OpenAI com `tool_calls` vira blocos Anthropic `tool_use`;
- `finish_reason` é mapeado para `stop_reason` Anthropic.

Streaming confirmado:

- envia `event: message_start`;
- envia `content_block_start`;
- envia `content_block_delta`;
- envia `content_block_stop`;
- envia `message_delta`;
- envia `message_stop`;
- inclui headers `anthropic-version` e `request-id`.

Endpoint adicional confirmado:

- `POST /v1/messages/count_tokens` retorna `{ input_tokens }` com estimativa simples por tamanho do JSON (`Math.ceil(JSON.stringify(messages).length / 4)`). Não é tokenização Anthropic real.

### Pontos confirmados de compatibilidade parcial

#### `system` em `messages[]` é validado, mas não traduzido

A validação aceita `messages[].role === "system"`.

Porém, `translateAnthropicToOpenAI` só trata explicitamente:

- `msg.role === "user"`
- `msg.role === "assistant"`

Logo, uma mensagem `system` dentro de `messages[]` é aceita pela validação, mas ignorada na tradução.

A documentação Anthropic carregada indica que sistemas mid-conversation existem sob regras específicas em modelos recentes, e que o `system` top-level é usado para instruções iniciais. Portanto, o comportamento atual é inconsistente: aceita mas descarta.

Correção segura: ou traduzir `messages[].role === "system"` para `system`, ou rejeitar com erro claro quando não suportado.

#### Imagem é parcial

Em mensagens `user` com conteúdo array:

- blocos `text` são concatenados;
- blocos `tool_result` são convertidos;
- blocos `image` são reduzidos para `"[Image content]"` apenas quando não há texto.

Não há conversão real de imagem Anthropic para upload/processamento multimodal nesse fluxo.

#### Documentos não são tratados

`AnthropicContentBlock` inclui `document`, mas a tradução não processa blocos `document`.

#### `top_k` e `metadata` não são repassados

`AnthropicRequest` define:

- `top_k`
- `metadata`

Mas `translateAnthropicToOpenAI` repassa apenas:

- `model`
- `messages`
- `max_tokens`
- `tools`
- `tool_choice`
- `stream`
- `temperature`
- `top_p`

Logo, `top_k` e `metadata` são aceitos nos tipos, mas não geram comportamento confirmado.

#### Thinking/raciocínio, caching e server tools Anthropic não estão implementados

Pela documentação Anthropic carregada, a plataforma suporta recursos como:

- extended/adaptive thinking;
- prompt caching;
- server tools;
- web search/fetch;
- code execution;
- bash/computer/text editor tools;
- Files API/PDF/imagens.

No código analisado da rota Anthropic, não há implementação confirmada para esses recursos como comportamento Anthropic nativo.

#### Cancelamento Anthropic não está implementado como endpoint próprio

O streaming Anthropic usa wrapper próprio e faz `fetch` interno para `/v1/chat/completions`. Há `AbortController` interno e timeout de 5 minutos, mas não há listener confirmado de desconexão do cliente chamando `abort()` nem endpoint Anthropic de cancelamento. Portanto, cancelamento Anthropic deve ser tratado como ausente/não confirmado.

### Melhorias/correções confirmadas para Anthropic

Prioridade alta:

1. Corrigir inconsistência de `messages[].role === "system"`:
   - traduzir corretamente;
   - ou rejeitar quando não suportado.
2. Resolver autenticação dupla em `/v1/messages` quando `API_KEY` está configurado.
3. Resolver conflito de `/v1/models`.
4. Implementar ou rejeitar explicitamente `document`.
5. Implementar ou documentar limitação de imagens.

Prioridade média:

1. Repassar ou rejeitar `top_k`.
2. Preservar/usar `metadata` quando fizer sentido.
3. Adicionar testes para:
   - `tool_use`;
   - `tool_result`;
   - streaming de tool use;
   - system top-level;
   - system em `messages[]`;
   - imagem/documento.

## `/v1/completions` legacy

Não foi encontrada implementação para `POST /v1/completions`.

Impacto:

- clientes antigos OpenAI Completion API não são compatíveis;
- alguns SDKs ou integrações antigas podem falhar se ainda chamarem esse endpoint.

A documentação OpenAI atual favorece Responses e Chat Completions para novos usos, então a ausência pode ser aceitável se for documentada.

Correção segura, se necessário:

- adicionar rota legacy simples convertendo `prompt` para Chat/Responses;
- ou documentar explicitamente como não suportada.

## Matriz de compatibilidade confirmada

Legenda:

- ✅ Suportado confirmado
- ⚠️ Parcial / aceito com limitações
- ❌ Não implementado confirmado
- ❓ Não confirmado pelo código lido

| Área | Status | Evidência/observação |
|---|---:|---|
| OpenAI Chat `/v1/chat/completions` básico | ✅ | rota implementada e responde Chat Completion |
| Chat streaming SSE | ✅ | `processStreamingResponse` emite `data:` chunks e `[DONE]` |
| Chat `stream_options.include_usage` | ✅ | tipo interno inclui e streaming trata usage |
| Chat function tools | ⚠️ | interface existe, execução/tool call é prompt-parser, não nativa |
| Chat multimodal por URLs | ⚠️ | processa `image_url`, `video_url`, `audio_url`, `file_url`; não é paridade completa OpenAI e tem limitação multi-conta |
| Chat thread state Qwen | ⚠️ | memória + SQLite, TTL 24h; não é semântica OpenAI nativa |
| Chat stop específico | ⚠️ | `/v1/chat/completions/stop` existe, mas requer IDs upstream Qwen |
| Chat `response_format` | ❓ | não confirmado no tipo principal analisado |
| Chat penalties/logprobs/seed/n | ❓ | não confirmado no tipo principal analisado |
| Responses `/v1/responses` básico | ✅ | rota implementada e converte para Chat |
| Responses input string | ✅ | convertido para `user` |
| Responses input array | ✅ | schema e conversão implementados |
| Responses `instructions` | ✅ | convertido para `system` atual |
| Responses streaming | ✅ | eventos Responses por SSE `data:` |
| Responses `previous_response_id` | ✅ | store em memória com TTL |
| Responses function call output/history | ✅ | conversão implementada |
| Responses function tools | ⚠️ | convertidos para Chat tools; backend ainda é prompt-parser |
| Responses built-in tools | ❌/⚠️ | aceitos no schema, descartados na conversão |
| Responses image/file input | ❌/⚠️ | aceitos no schema, ignorados por `extractText` |
| Responses reasoning real | ✅ | `reasoning_content` capturado e emitido como output item `type: "reasoning"` com `summary` (streaming e non-streaming) |
| Responses text verbosity real | ⚠️ | aceito, mas sem comportamento confirmado |
| Responses service tier real | ⚠️ | aceito, mas sem comportamento confirmado |
| Responses persistence após restart | ❌ | store apenas em memória |
| Responses cancelamento | ⚠️ | sem endpoint próprio, mas disconnect do cliente é tratado sem erros no log |
| Anthropic `/v1/messages` básico | ✅ | rota implementada e traduz para Chat |
| Anthropic top-level `system` | ✅ | traduzido para `system` OpenAI |
| Anthropic `messages[].system` | ⚠️ | validado, mas ignorado na tradução |
| Anthropic tools `tool_use`/`tool_result` | ✅ | tradução implementada |
| Anthropic streaming básico | ✅ | eventos SSE Anthropic emitidos |
| Anthropic images | ⚠️ | substituição textual parcial, sem multimodal real confirmado |
| Anthropic documents | ❌/⚠️ | tipo aceita, tradução não processa |
| Anthropic `top_k` | ⚠️ | tipo aceita, não repassa |
| Anthropic `metadata` | ⚠️ | tipo aceita, não repassa |
| Anthropic prompt caching | ❌ | não implementado no código analisado |
| Anthropic server tools | ❌ | não implementado no código analisado |
| Anthropic `/v1/messages/count_tokens` | ⚠️ | implementado com estimativa simples, não tokenização real |
| Anthropic cancelamento | ❌ | sem endpoint próprio e sem propagação confirmada de disconnect |
| `/v1/models` OpenAI-like | ✅ | implementado em `src/api/models.ts` |
| `/v1/models` Anthropic format | ⚠️ | implementado, mas conflito por ordem de registro |
| `/v1/completions` legacy | ❌ | rota não encontrada |

## Lista priorizada de correções seguras

### P0 — correções de comportamento que podem quebrar clientes

1. **Resolver autenticação dupla em `/v1/messages`**
   - Problema: middleware global exige `Authorization`, rota Anthropic exige `x-api-key`.
   - Impacto: SDK Anthropic padrão pode falhar mesmo com `x-api-key` correto.
   - Solução segura: middleware global reconhecer `/v1/messages` e aceitar fluxo Anthropic, ou remover validação duplicada e centralizar autenticação.

2. **Resolver conflito de `/v1/models`**
   - Problema: duas rotas iguais registradas em apps diferentes.
   - Impacto: formato Anthropic pode nunca ser entregue.
   - Solução segura: handler único com negociação por header.

3. **Corrigir `messages[].role === "system"` em Anthropic**
   - Problema: validação aceita, tradução ignora.
   - Impacto: perda silenciosa de instrução.
   - Solução segura: traduzir para `system` ou rejeitar explicitamente.

4. **Parar de descartar built-in tools silenciosamente em Responses**
   - Problema: request parece aceito, mas ferramenta não executa.
   - Impacto: clientes acham que têm `web_search`, `file_search`, `code_interpreter`, `shell`, etc.
   - Solução segura: erro claro `unsupported_tool` ou documentação explícita + warning.

5. **Parar de aceitar imagem/arquivo em Responses sem uso real**
   - Problema: `input_image`/`input_file` passam no schema, mas são ignorados.
   - Impacto: perda silenciosa de dados.
   - Solução segura: converter para multimodal/upload real ou rejeitar.

### P1 — compatibilidade e previsibilidade

1. Criar matriz oficial no README para cada rota.
2. Atualizar `docs/openapi.yaml`, que hoje documenta apenas parte das rotas e não cobre Responses/Anthropic.
3. Documentar explicitamente diferenças entre:
   - estado Qwen Chat (`session_id`/`conversation_id`, memória + SQLite);
   - estado Responses (`previous_response_id`, memória apenas);
   - histórico Anthropic enviado pelo cliente.
4. Documentar cancelamento real disponível apenas como stop específico de Chat.
5. Adicionar validações explícitas para campos aceitos parcialmente.
6. Preservar no response Responses os campos aceitos quando semanticamente apropriado:
   - `text`
   - `truncation`
   - `service_tier`
7. Adicionar testes automáticos para Responses.
8. Adicionar testes automáticos para Anthropic Messages.
9. Adicionar testes para `/v1/models` com e sem `anthropic-version`.
10. Adicionar testes para `/v1/messages/count_tokens` deixando claro que é estimado.

### P2 — melhorias de completude

1. Implementar `/v1/completions` legacy apenas se houver cliente real exigindo.
2. Persistir Responses state em SQLite se `previous_response_id` precisar sobreviver restart.
3. Implementar suporte real a documentos/arquivos.
4. Implementar ou integrar server tools/built-in tools.
5. Melhorar precisão de contagem de tokens.
6. Implementar cancelamento/abort próprio para Responses e Anthropic se clientes alvo dependerem disso.
7. Alinhar upload multimodal à conta selecionada para geração em setups multi-conta.

## Testes recomendados

### Responses

Casos mínimos:

1. `input` string não-streaming.
2. `input` array com `developer`, `user`, `assistant`.
3. `instructions` + `input`.
4. `function_call` em histórico.
5. `function_call_output` em input.
6. `tools` função + `tool_choice: auto`.
7. `tool_choice` função específica.
8. `stream: true` com texto.
9. `stream: true` com tool call.
10. `store: false` e `GET /v1/responses/:id` deve não encontrar.
11. `previous_response_id` válido.
12. `previous_response_id` inválido.
13. `input_image` deve ser convertido ou rejeitado, não ignorado.
14. built-in tool deve ser executada ou rejeitada, não ignorada.
15. `reasoning_content` deve aparecer como output item `type: "reasoning"` em streaming e non-streaming.
16. tipos desconhecidos de input (ex: `reasoning` items) devem ser aceitos sem erro e ignorados na conversão.

### Chat Completions

Casos mínimos:

1. não-streaming básico.
2. streaming básico.
3. streaming com `stream_options.include_usage`.
4. tools não-streaming.
5. tools streaming incremental.
6. histórico com `assistant.tool_calls` e mensagem `tool`.
7. imagem `image_url`.
8. campos não suportados geram comportamento documentado.
9. `/v1/chat/completions/stop` com stream ativo, `chat_id` e `response_id`.
10. multimodal em setup multi-conta, garantindo que upload e geração usem conta compatível.

### Anthropic Messages

Casos mínimos:

1. request básico com `anthropic-version`.
2. ausência de `anthropic-version` retorna erro.
3. autenticação com `x-api-key` sem `Authorization`, se esse for o comportamento desejado.
4. top-level `system`.
5. `messages[].role === "system"`.
6. `tool_use` em histórico.
7. `tool_result` em user content.
8. streaming texto.
9. streaming tool use.
10. imagem.
11. documento.
12. `/v1/models` com `anthropic-version`.
13. `/v1/messages/count_tokens`.
14. desconexão de cliente em streaming para confirmar comportamento de abort/cancelamento.

## Conclusão confirmada

O QwenBridge está funcional como ponte prática para:

- OpenAI-like Chat Completions;
- OpenAI-like Responses API;
- Anthropic-like Messages API;
- listagem de modelos.

Mas ele **não é 100% compatível** com as APIs oficiais em todos os recursos. O estado mais seguro é classificar como:

- `/v1/chat/completions`: funcional e útil, compatibilidade parcial com OpenAI.
- `/v1/responses`: funcional e atualmente a rota mais alinhada para clientes modernos. Reasoning suportado (captura e emissão de `reasoning_content`). Lacunas em built-in tools, multimodal/file input e campos avançados (`text.verbosity`, `truncation`, `service_tier`).
- `/v1/messages`: funcional para texto e tools básicos, mas precisa correções importantes de autenticação, `system` em mensagens, multimodal/documentos e `/v1/models`.
- `/v1/completions`: não suportado.

As correções mais seguras antes de declarar maior compatibilidade são:

1. resolver autenticação Anthropic;
2. resolver conflito `/v1/models`;
3. corrigir system message Anthropic;
4. rejeitar ou implementar built-in tools Responses;
5. rejeitar ou implementar imagem/arquivo Responses;
6. cobrir os fluxos acima com testes automatizados.
