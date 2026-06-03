import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryCache } from '../cache/memory-cache.js'
import { deriveSessionId, detectTopicChange } from '../utils/topic-detector.js'
import type { Message } from '../utils/types.js'
import type { CacheKey } from '../cache/memory-cache.js'

function msg(role: string, content: string | any[]): Message {
    return { role, content: content as any }
}

// ── deriveSessionId ──────────────────────────────────────────────

test('deriveSessionId: deterministic output for same inputs', () => {
    const messages: Message[] = [msg('user', 'Olá, como vai?')]
    const id1 = deriveSessionId(messages, 'system prompt')
    const id2 = deriveSessionId(messages, 'system prompt')
    assert.equal(id1, id2)
})

test('deriveSessionId: different messages produce different IDs', () => {
    const id1 = deriveSessionId([msg('user', 'Olá')], '')
    const id2 = deriveSessionId([msg('user', 'Tchau')], '')
    assert.notEqual(id1, id2)
})

test('deriveSessionId: format is sess_ followed by 16 hex chars', () => {
    const id = deriveSessionId([msg('user', 'test')], '')
    assert.match(id, /^sess_[a-f0-9]{16}$/)
})

test('deriveSessionId: anchors on first user message only', () => {
    const base: Message[] = [
        msg('system', 'You are a helpful assistant'),
        msg('user', 'First message'),
        msg('assistant', 'Response'),
        msg('user', 'Second message'),
    ]
    const id1 = deriveSessionId(base)

    const variant: Message[] = [
        msg('system', 'You are a helpful assistant'),
        msg('user', 'First message'),
        msg('assistant', 'Different response'),
        msg('user', 'Completely different later message'),
    ]
    const id2 = deriveSessionId(variant)
    assert.equal(id1, id2)
})

test('deriveSessionId: systemPrompt variation changes the ID', () => {
    const messages: Message[] = [msg('user', 'Hello')]
    const id1 = deriveSessionId(messages, 'prompt A')
    const id2 = deriveSessionId(messages, 'prompt B')
    assert.notEqual(id1, id2)
})

test('deriveSessionId: empty messages array produces valid hash', () => {
    const id = deriveSessionId([], '')
    assert.match(id, /^sess_[a-f0-9]{16}$/)
})

// ── detectTopicChange — edge cases ──────────────────────────────

test('detectTopicChange: returns no-change for empty messages', async () => {
    const cache = new MemoryCache({ prefix: 'td-empty' })
    const result = await detectTopicChange([], 'sess_123', cache)
    assert.equal(result.hasChanged, false)
    assert.equal(result.confidence, 0)
    await cache.close()
})

test('detectTopicChange: returns no-change when no user message exists', async () => {
    const cache = new MemoryCache({ prefix: 'td-nouser' })
    const messages: Message[] = [
        msg('system', 'You are helpful'),
        msg('assistant', 'Hello there'),
    ]
    const result = await detectTopicChange(messages, 'sess_456', cache)
    assert.equal(result.hasChanged, false)
    assert.equal(result.confidence, 0)
    await cache.close()
})

test('detectTopicChange: returns no-change for whitespace-only user content', async () => {
    const cache = new MemoryCache({ prefix: 'td-wsonly' })
    const messages: Message[] = [msg('user', '   ')]
    const result = await detectTopicChange(messages, 'sess_789', cache)
    assert.equal(result.hasChanged, false)
    assert.equal(result.confidence, 0)
    await cache.close()
})

// ── detectTopicChange — first interaction ───────────────────────

test('detectTopicChange: first interaction stores topic and returns no-change', async () => {
    const cache = new MemoryCache({ prefix: 'td-first' })
    const sessionId = `sess_${Date.now()}`
    const messages: Message[] = [msg('user', 'Como funciona programação funcional?')]

    const result = await detectTopicChange(messages, sessionId, cache)
    assert.equal(result.hasChanged, false)
    assert.equal(result.confidence, 0)
    assert.ok(result.currentTopic)
    assert.ok(result.currentTopic!.includes('programação funcional'))

    // Verify topic state was persisted
    const cached = await cache.get<any>(`topic:${sessionId}` as CacheKey)
    assert.ok(cached)
    assert.ok(Array.isArray(cached.keywords))
    assert.ok(cached.keywords.includes('programação'))

    await cache.close()
})

// ── detectTopicChange — same topic (high similarity) ────────────

test('detectTopicChange: overlapping keywords do not trigger change', async () => {
    const cache = new MemoryCache({ prefix: 'td-similar' })
    const sessionId = `sess_${Date.now()}`

    // Seed the initial topic
    await detectTopicChange(
        [msg('user', 'Como funciona programação funcional em JavaScript?')],
        sessionId, cache,
    )

    // Follow-up with heavy keyword overlap
    const result = await detectTopicChange(
        [msg('user', 'Quero aprender mais sobre programação funcional em JavaScript')],
        sessionId, cache,
    )

    assert.equal(result.hasChanged, false)
    assert.ok(result.confidence < 0.7, `Expected confidence < 0.7, got ${result.confidence}`)

    await cache.close()
})

// ── detectTopicChange — topic shift (low similarity) ────────────

test('detectTopicChange: disjoint keywords trigger topic change', async () => {
    const cache = new MemoryCache({ prefix: 'td-disjoint' })
    const sessionId = `sess_${Date.now()}`

    await detectTopicChange(
        [msg('user', 'Como funciona programação funcional em Haskell?')],
        sessionId, cache,
    )

    const result = await detectTopicChange(
        [msg('user', 'Qual receita melhor bolo chocolate cenoura?')],
        sessionId, cache,
    )

    assert.equal(result.hasChanged, true)
    assert.ok(result.confidence >= 0.7, `Expected confidence >= 0.7, got ${result.confidence}`)
    assert.ok(result.previousTopic)
    assert.ok(result.currentTopic)

    await cache.close()
})

// ── detectTopicChange — explicit transition phrases ─────────────

test('detectTopicChange: PT-BR transition phrase triggers change at 0.95 confidence', async () => {
    const cache = new MemoryCache({ prefix: 'td-pt-trans' })
    const sessionId = `sess_${Date.now()}`

    await detectTopicChange(
        [msg('user', 'Vamos falar sobre machine learning')],
        sessionId, cache,
    )

    const result = await detectTopicChange(
        [msg('user', 'Mudando de assunto, qual a previsão do tempo?')],
        sessionId, cache,
    )

    assert.equal(result.hasChanged, true)
    assert.equal(result.confidence, 0.95)

    await cache.close()
})

test('detectTopicChange: EN transition phrase triggers change at 0.95 confidence', async () => {
    const cache = new MemoryCache({ prefix: 'td-en-trans' })
    const sessionId = `sess_${Date.now()}`

    await detectTopicChange(
        [msg('user', 'Let us discuss quantum physics')],
        sessionId, cache,
    )

    const result = await detectTopicChange(
        [msg('user', 'On another note, what is the best pizza recipe?')],
        sessionId, cache,
    )

    assert.equal(result.hasChanged, true)
    assert.equal(result.confidence, 0.95)

    await cache.close()
})

// ── detectTopicChange — multimodal content ──────────────────────

test('detectTopicChange: extracts text from multimodal content array', async () => {
    const cache = new MemoryCache({ prefix: 'td-multimodal' })
    const sessionId = `sess_${Date.now()}`

    const messages: Message[] = [{
        role: 'user',
        content: [
            { type: 'text', text: 'Análise programação funcional' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ] as any,
    }]

    const result = await detectTopicChange(messages, sessionId, cache)
    assert.equal(result.hasChanged, false)
    assert.ok(result.currentTopic)
    assert.ok(result.currentTopic!.includes('programação funcional'))

    await cache.close()
})

// ── detectTopicChange — last user message selection ─────────────

test('detectTopicChange: uses the last user message in multi-turn conversation', async () => {
    const cache = new MemoryCache({ prefix: 'td-lastmsg' })
    const sessionId = `sess_${Date.now()}`

    await detectTopicChange(
        [msg('user', 'Vamos falar sobre astronomia e estrelas')],
        sessionId, cache,
    )

    // Multi-turn: only the last user message matters for comparison
    const messages: Message[] = [
        msg('user', 'Vamos falar sobre astronomia e estrelas'),
        msg('assistant', 'Claro, astronomia é fascinante!'),
        msg('user', 'Me conte sobre astronomia e estrelas no universo'),
    ]

    const result = await detectTopicChange(messages, sessionId, cache)
    assert.equal(result.hasChanged, false)

    await cache.close()
})

// ── detectTopicChange — keyword merging on continuation ─────────

test('detectTopicChange: keywords are merged across turns when topic continues', async () => {
    const cache = new MemoryCache({ prefix: 'td-merge' })
    const sessionId = `sess_${Date.now()}`

    await detectTopicChange(
        [msg('user', 'Programação funcional em Haskell')],
        sessionId, cache,
    )

    // Same topic but adds new keywords
    await detectTopicChange(
        [msg('user', 'Programação funcional em Haskell com mônadas e lambdas')],
        sessionId, cache,
    )

    // Verify merged keywords were persisted
    const cached = await cache.get<any>(`topic:${sessionId}` as CacheKey)
    assert.ok(cached)
    assert.ok(cached.keywords.includes('mônadas') || cached.keywords.includes('lambdas'))

    await cache.close()
})
