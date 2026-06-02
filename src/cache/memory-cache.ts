import { promisify } from 'util'
import { brotliCompress, brotliDecompress, constants } from 'zlib'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'

const compressAsync = promisify(brotliCompress)
const decompressAsync = promisify(brotliDecompress)

export type CacheKey =
  | `auth:${string}`
  | `session:${string}`
  | `prompt:${string}`
  | `response:${string}`
  | `rate:${string}`
  | `topic:${string}`

interface CacheEntry<T> {
  value: T
  expiresAt: number
  compressed?: boolean
}

export class MemoryCache {
  private connected = false;
  private store: Map<string, CacheEntry<any>>
  private defaultTTL: number
  private prefix: string
  private cleanupInterval: NodeJS.Timeout | null
  private hits: number = 0
  private misses: number = 0
  private totalBytesSaved: number = 0
  private compressionCount: number = 0

  constructor(options?: { prefix?: string; defaultTTL?: number }) {
    this.prefix = options?.prefix || 'qwenproxy:'
    this.defaultTTL = options?.defaultTTL || config.cache.defaultTTL
    this.store = new Map()
    this.cleanupInterval = null

    this.startCleanup()
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.store.entries()) {
        if (entry.expiresAt <= now) {
          this.store.delete(key)
        }
      }
    }, 60000)
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async set<T>(key: CacheKey, value: T, ttl?: number): Promise<void> {
    const serialized = this.serialize(value)
    const originalSize = Buffer.byteLength(serialized)
    let storedValue: string | Buffer = serialized
    let compressed = false

    // Apply Brotli compression if enabled and value exceeds threshold
    if (config.cache.compression.enabled && originalSize >= config.cache.compression.threshold) {
      try {
        const compressedBuffer = await compressAsync(Buffer.from(serialized), {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: config.cache.compression.level,
          },
        })
        
        const compressedSize = compressedBuffer.length
        const saved = originalSize - compressedSize
        
        if (saved > 0) {
          storedValue = compressedBuffer
          compressed = true
          this.totalBytesSaved += saved
          this.compressionCount++
          
          metrics.increment('cache.compression.bytes.saved', saved)
          metrics.histogram('cache.compression.ratio', originalSize / compressedSize)
        }
      } catch (err) {
        // Compression failed, store uncompressed
      }
    }

    const effectiveTTL = ttl || this.defaultTTL
    const fullKey = this.prefix + key
    
    this.store.set(fullKey, {
      value: storedValue,
      expiresAt: Date.now() + (effectiveTTL * 1000),
      compressed,
    })
    
    metrics.increment('cache.set')
    metrics.histogram('cache.value.size', originalSize)
  }

  async get<T>(key: CacheKey): Promise<T | null> {
    const start = Date.now()
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)
    
    metrics.histogram('cache.get.latency', Date.now() - start)

    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.store.delete(fullKey)
      this.misses++
      metrics.increment('cache.miss')
      this.updateHitRatio()
      return null
    }

    this.hits++
    metrics.increment('cache.hit')
    this.updateHitRatio()

    // Decompress if needed
    if (entry.compressed && Buffer.isBuffer(entry.value)) {
      try {
        const decompressed = await decompressAsync(entry.value)
        return this.deserialize<T>(decompressed.toString())
      } catch (err) {
        // Decompression failed, return null
        this.store.delete(fullKey)
        return null
      }
    }

    return this.deserialize<T>(entry.value as string)
  }

  async delete(key: CacheKey): Promise<void> {
    const fullKey = this.prefix + key
    this.store.delete(fullKey)
    metrics.increment('cache.deleted')
  }

  async exists(key: CacheKey): Promise<boolean> {
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.store.delete(fullKey)
      return false
    }
    return true
  }

  async setWithNX<T>(key: CacheKey, value: T, ttl?: number): Promise<boolean> {
    const fullKey = this.prefix + key
    if (this.store.has(fullKey)) {
      const entry = this.store.get(fullKey)
      if (entry && entry.expiresAt > Date.now()) {
        return false
      }
    }
    await this.set(key, value, ttl)
    return true
  }

  async increment(key: CacheKey, by: number = 1, ttl?: number): Promise<number> {
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)
    let current = 0
    
    if (entry && entry.expiresAt > Date.now()) {
      current = typeof entry.value === 'number' ? entry.value : 0
    }
    
    const newValue = current + by
    const effectiveTTL = ttl || this.defaultTTL
    
    this.store.set(fullKey, {
      value: newValue,
      expiresAt: Date.now() + (effectiveTTL * 1000)
    })
    
    return newValue
  }

  async getMulti<T>(keys: CacheKey[]): Promise<(T | null)[]> {
    return Promise.all(keys.map(key => this.get<T>(key)))
  }

  async scan(pattern: string, _count: number = 100): Promise<string[]> {
    const regex = new RegExp(this.prefix + pattern.replace(/\*/g, '.*'))
    const now = Date.now()
    const keys: string[] = []
    
    for (const [key, entry] of this.store.entries()) {
      if (regex.test(key) && entry.expiresAt > now) {
        keys.push(key)
      }
    }
    return keys
  }

  async flush(pattern?: string): Promise<void> {
    if (pattern) {
      const keys = await this.scan(pattern)
      for (const key of keys) {
        this.store.delete(key)
      }
    } else {
      this.store.clear()
    }
    metrics.increment('cache.flushed')
  }

  async getStats(): Promise<{
    connected: boolean;
    keysCount: number;
    memoryUsage: string;
    hitRatio: number
    compressionRatio: number
    bytesSaved: number
  }> {
    const now = Date.now()
    let validKeys = 0
    let totalBytes = 0
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt > now) {
        validKeys++
        const valueSize = Buffer.isBuffer(entry.value)
          ? entry.value.length
          : Buffer.byteLength(String(entry.value))
        totalBytes += valueSize + Buffer.byteLength(key)
      }
    }
    
    const totalRequests = this.hits + this.misses
    const hitRatio = totalRequests > 0 ? this.hits / totalRequests : 0
    const avgCompressionRatio = this.compressionCount > 0
      ? (this.totalBytesSaved / this.compressionCount) + 1
      : 1
    
    // Update gauge metrics
    metrics.gauge('cache.hit.ratio', hitRatio)
    metrics.gauge('cache.memory.usage.bytes', totalBytes)
    metrics.gauge('cache.entries.count', validKeys)
    
    return {
      connected: this.connected,
      keysCount: validKeys,
      memoryUsage: `${(totalBytes / 1024).toFixed(2)}KB`,
      hitRatio,
      compressionRatio: avgCompressionRatio,
      bytesSaved: this.totalBytesSaved,
    };
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  // Optimized serialization for primitives
  private serialize<T>(value: T): string {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    
    const type = typeof value
    if (type === 'string' || type === 'number' || type === 'boolean') {
      return String(value)
    }
    
    return JSON.stringify(value)
  }

  // Optimized deserialization for primitives
  private deserialize<T>(serialized: string): T {
    if (serialized === 'null') return null as T
    if (serialized === 'undefined') return undefined as T
    
    // Try to parse as number
    if (/^-?\d+(\.\d+)?$/.test(serialized)) {
      return Number(serialized) as T
    }
    
    // Try to parse as boolean
    if (serialized === 'true') return true as T
    if (serialized === 'false') return false as T
    
    // Try JSON parse for objects/arrays
    try {
      return JSON.parse(serialized) as T
    } catch {
      // Return as string if not valid JSON
      return serialized as T
    }
  }

  private updateHitRatio(): void {
    const total = this.hits + this.misses
    if (total > 0) {
      metrics.gauge('cache.hit.ratio', this.hits / total)
    }
  }

  // Invalidate entries by pattern (topic-based)
  async invalidateByPattern(pattern: string): Promise<number> {
    const keys = await this.scan(pattern)
    let count = 0
    for (const key of keys) {
      this.store.delete(key)
      count++
    }
    if (count > 0) {
      metrics.increment('cache.topic.invalidation', count)
    }
    return count
  }

  // Invalidate all entries for a session
  async invalidateBySession(sessionId: string): Promise<number> {
    const pattern = `*session:*${sessionId}*`
    return this.invalidateByPattern(pattern)
  }

}
