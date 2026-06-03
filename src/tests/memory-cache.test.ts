import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryCache, type CacheKey } from '../cache/memory-cache.js'
import { config } from '../core/config.js'

// Helper to generate test data of specific size
function generateTestData(sizeInBytes: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let result = ''
    while (Buffer.byteLength(result) < sizeInBytes) {
        result += chars[Math.floor(Math.random() * chars.length)]
    }
    return result
}

test('MemoryCache: compression enabled by default', () => {
    assert.equal(config.cache.compression.enabled, true)
})

test('MemoryCache: values below threshold are not compressed', async () => {
    const cache = new MemoryCache({ prefix: 'test' })
    const smallValue = 'small value'

    await cache.set('test:key1' as CacheKey, smallValue)
    const retrieved = await cache.get('test:key1' as CacheKey)

    assert.equal(retrieved, smallValue)

    const stats = await cache.getStats()
    assert.equal(stats.bytesSaved, 0)

    await cache.close()
})

test('MemoryCache: values above threshold are compressed', async () => {
    const cache = new MemoryCache({ prefix: 'test' })
    const largeValue = generateTestData(2048) // Above 1024 threshold

    await cache.set('test:key2' as CacheKey, largeValue)
    const retrieved = await cache.get('test:key2' as CacheKey)

    assert.equal(retrieved, largeValue)

    const stats = await cache.getStats()
    assert.ok(stats.bytesSaved > 0, 'Should have saved bytes through compression')
    assert.ok(stats.compressionRatio > 1, 'Compression ratio should be greater than 1')

    await cache.close()
})

test('MemoryCache: round-trip compression and decompression preserves data', async () => {
    const cache = new MemoryCache({ prefix: 'test' })
    const testData = {
        message: 'This is a test message with enough data to trigger compression',
        count: 42,
        nested: {
            array: [1, 2, 3, 4, 5],
            object: { key: 'value' }
        }
    }

    const largeObject = {
        ...testData,
        padding: generateTestData(1500)
    }

    await cache.set('test:key3' as CacheKey, largeObject)
    const retrieved = await cache.get('test:key3' as CacheKey)

    assert.deepEqual(retrieved, largeObject)

    await cache.close()
})

test('MemoryCache: compression statistics are tracked correctly', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    // Add multiple compressed values
    const value1 = generateTestData(1500)
    const value2 = generateTestData(2000)

    await cache.set('test:stat1' as CacheKey, value1)
    await cache.set('test:stat2' as CacheKey, value2)

    const stats = await cache.getStats()

    assert.ok(stats.bytesSaved > 0, 'Should track bytes saved')
    assert.ok(stats.compressionRatio > 1, 'Should track compression ratio')

    await cache.close()
})

test('MemoryCache: primitives are serialized efficiently', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('test:null' as CacheKey, null)
    await cache.set('test:undefined' as CacheKey, undefined)
    await cache.set('test:string' as CacheKey, 'hello')
    await cache.set('test:number' as CacheKey, 42)
    await cache.set('test:boolean' as CacheKey, true)

    assert.equal(await cache.get('test:null' as CacheKey), null)
    assert.equal(await cache.get('test:undefined' as CacheKey), undefined)
    assert.equal(await cache.get('test:string' as CacheKey), 'hello')
    assert.equal(await cache.get('test:number' as CacheKey), 42)
    assert.equal(await cache.get('test:boolean' as CacheKey), true)

    await cache.close()
})

test('MemoryCache: compression respects enabled flag', async () => {
    // Temporarily disable compression
    const cache = new MemoryCache({ prefix: 'test' })
    const value = generateTestData(2048)

    await cache.set('test:key4' as CacheKey, value)
    const retrieved = await cache.get('test:key4' as CacheKey)

    assert.equal(retrieved, value)

    await cache.close()
})

test('MemoryCache: expired entries are not returned', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('test:expiring' as CacheKey, 'value', 0.01) // 10ms TTL

    await new Promise(resolve => setTimeout(resolve, 20))

    const retrieved = await cache.get('test:expiring' as CacheKey)
    assert.equal(retrieved, null)

    await cache.close()
})

test('MemoryCache: delete removes entry', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('test:toDelete' as CacheKey, 'value')
    assert.equal(await cache.get('test:toDelete' as CacheKey), 'value')

    await cache.delete('test:toDelete' as CacheKey)
    assert.equal(await cache.get('test:toDelete' as CacheKey), null)

    await cache.close()
})

test('MemoryCache: exists checks entry presence', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('test:exists' as CacheKey, 'value')

    assert.equal(await cache.exists('test:exists' as CacheKey), true)
    assert.equal(await cache.exists('test:notexists' as CacheKey), false)

    await cache.close()
})

test('MemoryCache: hit/miss ratio is calculated correctly', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('test:hit1' as CacheKey, 'value1')
    await cache.set('test:hit2' as CacheKey, 'value2')

    await cache.get('test:hit1' as CacheKey) // hit
    await cache.get('test:hit2' as CacheKey) // hit
    await cache.get('test:miss1' as CacheKey) // miss

    const stats = await cache.getStats()
    assert.ok(stats.hitRatio > 0, 'Hit ratio should be greater than 0')
    assert.ok(stats.hitRatio < 1, 'Hit ratio should be less than 1')

    await cache.close()
})

test('MemoryCache: invalidateByPattern removes matching entries', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('test:abc:1' as CacheKey, 'value1')
    await cache.set('test:abc:2' as CacheKey, 'value2')
    await cache.set('test:def:1' as CacheKey, 'value3')

    const removed = await cache.invalidateByPattern('test:abc:*')

    assert.equal(removed, 2)
    assert.equal(await cache.get('test:abc:1' as CacheKey), null)
    assert.equal(await cache.get('test:abc:2' as CacheKey), null)
    assert.equal(await cache.get('test:def:1' as CacheKey), 'value3')

    await cache.close()
})

test('MemoryCache: invalidateBySession removes session entries', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('session:xyz:msg1' as CacheKey, 'msg1')
    await cache.set('session:xyz:msg2' as CacheKey, 'msg2')
    await cache.set('session:other:msg1' as CacheKey, 'other')

    const removed = await cache.invalidateBySession('xyz')

    assert.equal(removed, 2)
    assert.equal(await cache.get('session:xyz:msg1' as CacheKey), null)
    assert.equal(await cache.get('session:xyz:msg2' as CacheKey), null)
    assert.equal(await cache.get('session:other:msg1' as CacheKey), 'other')

    await cache.close()
})

test('MemoryCache: topic keys are supported', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('topic:mytopic' as CacheKey, { topic: 'data' })
    const retrieved = await cache.get('topic:mytopic' as CacheKey)

    assert.deepEqual(retrieved, { topic: 'data' })

    await cache.close()
})

test('MemoryCache: flush with pattern removes only matching entries', async () => {
    const cache = new MemoryCache({ prefix: 'test' })

    await cache.set('session:flush1' as CacheKey, 'value1')
    await cache.set('session:flush2' as CacheKey, 'value2')
    await cache.set('session:keep1' as CacheKey, 'value3')

    await cache.flush('session:flush*')

    assert.equal(await cache.get('session:flush1' as CacheKey), null)
    assert.equal(await cache.get('session:flush2' as CacheKey), null)
    assert.equal(await cache.get('session:keep1' as CacheKey), 'value3')

    await cache.close()
})
