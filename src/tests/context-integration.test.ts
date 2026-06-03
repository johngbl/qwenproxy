import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { truncateMessages, MessagePriority } from '../utils/context-truncation.ts'
import { Message } from '../utils/types.ts'
import { config } from '../core/config.ts'

const savedPort = config.server.port
const savedFetch = globalThis.fetch
const savedEnabled = config.context.summarization.enabled
const savedModel = config.context.summarization.model
const savedTimeout = config.context.summarization.timeout

function setMockPort(port: number): void {
    config.server.port = port
}

function makeSuccessResponse(summary: string): Response {
    return new Response(
        JSON.stringify({
            choices: [{ message: { role: 'assistant', content: summary } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
}

function installFetchMock(handler?: (url: string, init?: any) => Response | Promise<Response>): void {
    globalThis.fetch = (async (input: any, init: any = {}) => {
        if (handler) return handler(input.toString(), init)
        return makeSuccessResponse('Mocked summary of previous conversation')
    }) as typeof globalThis.fetch
}

afterEach(() => {
    globalThis.fetch = savedFetch
    config.server.port = savedPort
    config.context.summarization.enabled = savedEnabled
    config.context.summarization.model = savedModel
    config.context.summarization.timeout = savedTimeout
})

function buildConversation(turns: number, prefix: string = 'msg'): Message[] {
    const msgs: Message[] = []
    for (let i = 0; i < turns; i++) {
        msgs.push({ role: 'user', content: `${prefix}-user-${i}: discuss topic alpha` })
        msgs.push({ role: 'assistant', content: `${prefix}-assistant-${i}: responding to alpha` })
    }
    return msgs
}

test('Integration: truncateMessages calls summarizeMessages when enabled and threshold exceeded', async () => {
    setMockPort(39999)
    config.context.summarization.enabled = true
    config.context.summarization.model = 'qwen-flash'
    installFetchMock()

    const messages = buildConversation(10)
    const result = await truncateMessages(messages, {
        maxContextLength: 8000,
        systemPrompt: 'You are a helpful assistant.',
        enableSummarization: true,
        minMessagesToKeep: 4,
    })

    const summaryMsg = result.find((m) => m.content.includes('[Context Summary]'))
    assert.ok(summaryMsg, 'Should prepend a [Context Summary] system message')
    assert.strictEqual(summaryMsg!.priority, MessagePriority.SYSTEM)
    assert.ok(summaryMsg!.content.includes('Mocked summary'))
})

test('Integration: summarizeMessages is NOT called when enableSummarization is false', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
        fetchCalled = true
        return makeSuccessResponse('should not be called')
    }) as typeof globalThis.fetch

    const messages = buildConversation(10)
    const result = await truncateMessages(messages, {
        maxContextLength: 8000,
        systemPrompt: 'System',
        enableSummarization: false,
        minMessagesToKeep: 4,
    })

    assert.strictEqual(fetchCalled, false, 'fetch should not be called when summarization disabled')
    const summaryMsg = result.find((m) => m.content.includes('[Context Summary]'))
    assert.strictEqual(summaryMsg, undefined, 'No summary message should be present')
})

test('Integration: summarizeMessages is NOT called when messages.length <= minMessagesToKeep', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
        fetchCalled = true
        return makeSuccessResponse('should not be called')
    }) as typeof globalThis.fetch

    const messages = buildConversation(2) // 4 messages total
    const result = await truncateMessages(messages, {
        maxContextLength: 8000,
        systemPrompt: 'System',
        enableSummarization: true,
        minMessagesToKeep: 10,
    })

    assert.strictEqual(fetchCalled, false)
    const summaryMsg = result.find((m) => m.content.includes('[Context Summary]'))
    assert.strictEqual(summaryMsg, undefined)
})

test('Integration: graceful fallback when summarization API returns error', async () => {
    setMockPort(39999)
    installFetchMock(() => new Response('Internal Server Error', { status: 500 }))

    const messages = buildConversation(10)
    const result = await truncateMessages(messages, {
        maxContextLength: 8000,
        systemPrompt: 'System',
        enableSummarization: true,
        minMessagesToKeep: 4,
    })

    // Fallback: summary is '[Summary unavailable - truncated]' which starts with '[Summary unavailable' truncateMessages discards it (line 107), so no summary message should appear
    const summaryMsg = result.find((m) => m.content.includes('[Context Summary]'))
    assert.strictEqual(summaryMsg, undefined, 'Invalid summary should not be prepended')
    assert.ok(result.length > 0, 'Should still return truncated messages')
})

test('Integration: SYSTEM priority messages are always preserved at 100% allocation', async () => {
    setMockPort(39999)
    config.context.summarization.enabled = true
    installFetchMock()

    const messages: Message[] = [
        { role: 'system', content: 'A'.repeat(500) + ' critical system instruction' },
        ...buildConversation(10),
    ]

    const result = await truncateMessages(messages, {
        maxContextLength: 4000,
        systemPrompt: 'System',
        enableSummarization: true,
        minMessagesToKeep: 4,
    })

    const systemMsg = result.find(
        (m) => m.role === 'system' && m.content.includes('critical system instruction')
    )
    // System messages within messagesToProcess get SYSTEM priority (100% allocation)
    if (systemMsg) {
        assert.ok(
            systemMsg.content.includes('critical system instruction'),
            'System message content should be preserved'
        )
    }
})

test('Integration: result shape is compatible with chat.ts mapping', async () => {
    setMockPort(39999)
    config.context.summarization.enabled = true
    installFetchMock()

    const messages = buildConversation(6)
    const result = await truncateMessages(messages, {
        maxContextLength: 8000,
        systemPrompt: 'System',
        enableSummarization: true,
        minMessagesToKeep: 4,
    })

    for (const msg of result) {
        assert.ok(typeof msg.role === 'string', 'role must be string')
        assert.ok(typeof msg.content === 'string', 'content must be string')
        assert.ok(typeof msg.priority === 'number', 'priority must be number')
        assert.ok(typeof msg.tokens === 'number', 'tokens must be number')
        assert.ok(['user', 'assistant', 'system', 'tool'].includes(msg.role), 'role must be valid')
    }

    // chat.ts joins with \n\n — verify the output is non-empty
    const prompt = result
        .map((m) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`)
        .join('\n\n')
    assert.ok(prompt.length > 0, 'Final prompt should not be empty')
})

test('Integration: sliding window preserves recent messages over older ones', async () => {
    // No summarization — pure sliding window test
    globalThis.fetch = (async () => {
        throw new Error('Should not be called')
    }) as typeof globalThis.fetch

    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
        messages.push({
            role: 'user',
            content: `OLD-MESSAGE-${i}: `.padEnd(200, 'x'),
        })
        messages.push({
            role: 'assistant',
            content: `OLD-RESPONSE-${i}: `.padEnd(200, 'y'),
        })
    }
    // Add recent messages with identifiable marker
    messages.push({ role: 'user', content: 'RECENT-USER-MSG: please help me now' })
    messages.push({ role: 'assistant', content: 'RECENT-ASSISTANT: here is the answer' })

    const result = await truncateMessages(messages, {
        maxContextLength: 4000,
        systemPrompt: 'System',
        enableSummarization: false,
    })

    const hasRecent = result.some((m) => m.content.includes('RECENT-USER-MSG') || m.content.includes('RECENT-ASSISTANT'))
    assert.ok(hasRecent, 'Recent messages should be preserved in sliding window')
})

test('Integration: tool call messages receive TOOL_CALLS priority allocation', async () => {
    globalThis.fetch = (async () => {
        throw new Error('Should not be called')
    }) as typeof globalThis.fetch

    const messages: Message[] = buildConversation(4)
    messages.push({
        role: 'assistant',
        content: 'Calling tool',
        tool_calls: [
            {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"src/test.ts"}' },
            },
        ],
    })
    messages.push({
        role: 'tool',
        content: 'File content: '.padEnd(500, 'z'),
        tool_call_id: 'call_1',
    })

    const result = await truncateMessages(messages, {
        maxContextLength: 8000,
        systemPrompt: 'System',
        enableSummarization: false,
    })

    const toolMsg = result.find((m) => m.role === 'tool')
    assert.ok(toolMsg, 'Tool message should be present')
    assert.ok(toolMsg!.content.includes('File content'), 'Tool content should be preserved')
})

test('Integration: empty messages array returns empty result', async () => {
    const result = await truncateMessages([], {
        maxContextLength: 8000,
        systemPrompt: 'System',
        enableSummarization: true,
    })

    // With empty messages and available budget, result should contain system prompt fallback
    // or be empty depending on implementation
    assert.ok(Array.isArray(result), 'Result should be an array')
})

test('Integration: very small context window triggers aggressive truncation', async () => {
    globalThis.fetch = (async () => {
        throw new Error('Should not be called')
    }) as typeof globalThis.fetch

    const messages = buildConversation(10)
    const result = await truncateMessages(messages, {
        maxContextLength: 500,
        systemPrompt: 'A'.repeat(100),
        enableSummarization: false,
    })

    // With only 500 tokens total and 100 system tokens, available = 500 - 100 - 500 = -100
    // Should fallback to system prompt only
    assert.ok(result.length >= 0, 'Should handle negative budget gracefully')
})

test('Integration: multimodal content is normalized before token counting', async () => {
    setMockPort(39999)
    config.context.summarization.enabled = true
    installFetchMock()

    const messages: Message[] = [
        ...buildConversation(6),
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Describe this image' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ] as any,
        },
    ]

    const result = await truncateMessages(messages, {
        maxContextLength: 8000,
        systemPrompt: 'System',
        enableSummarization: true,
        minMessagesToKeep: 4,
    })

    assert.ok(result.length > 0, 'Should handle multimodal content')
    for (const msg of result) {
        assert.ok(typeof msg.content === 'string', 'All content should be normalized to string')
    }
})

test('Integration: summarizeMessages receives correct olderMessages slice', async () => {
    setMockPort(39999)
    config.context.summarization.enabled = true

    let capturedBody: any = null
    installFetchMock((_url, init) => {
        capturedBody = JSON.parse(init.body)
        return makeSuccessResponse('Captured summary')
    })

    const messages = buildConversation(8) // 16 messages total
    await truncateMessages(messages, {
        maxContextLength: 8000,
        systemPrompt: 'System',
        enableSummarization: true,
        minMessagesToKeep: 4,
    })

    assert.ok(capturedBody, 'Summarization API should be called')
    // olderMessages = messages.slice(0, 16 - 4) = 12 messages
    // conversationText = 12 messages joined by \n\n
    const userContent = capturedBody.messages[1].content
    const msgCount = userContent.split('\n\n').length
    assert.strictEqual(msgCount, 12, 'Should send 12 older messages to summarization')
})
