/**
 * Simple byte-budget LRU for ArrayBuffer values keyed by string/number.
 */
export class ByteLruCache<K> {
    private readonly maxBytes: number;
    private usedBytes = 0;
    private readonly map = new Map<K, ArrayBuffer>();

    constructor(maxBytes: number) {
        this.maxBytes = Math.max(0, maxBytes);
    }

    get(key: K): ArrayBuffer | undefined {
        const value = this.map.get(key);
        if (value === undefined) {
            return undefined;
        }
        // Refresh insertion order (most-recent at end).
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    set(key: K, value: ArrayBuffer): void {
        const existing = this.map.get(key);
        if (existing) {
            this.usedBytes -= existing.byteLength;
            this.map.delete(key);
        }
        this.map.set(key, value);
        this.usedBytes += value.byteLength;
        this.evict();
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    clear(): void {
        this.map.clear();
        this.usedBytes = 0;
    }

    getByteLength(): number {
        return this.usedBytes;
    }

    get size(): number {
        return this.map.size;
    }

    private evict(): void {
        if (this.maxBytes <= 0) {
            this.clear();
            return;
        }
        while (this.usedBytes > this.maxBytes && this.map.size > 0) {
            const oldestKey = this.map.keys().next().value as K;
            const oldest = this.map.get(oldestKey);
            this.map.delete(oldestKey);
            if (oldest) {
                this.usedBytes -= oldest.byteLength;
            }
        }
    }
}
