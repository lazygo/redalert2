import { DataStream } from './DataStream';
import { MixEntry } from './MixEntry';
import { MixFile } from './MixFile';
import { VirtualFile } from './vfs/VirtualFile';
import { ByteLruCache } from '../util/ByteLruCache';
import { syncReadBlobSlice } from '../util/syncBlobRead';

const DEFAULT_ENTRY_CACHE_BYTES = 48 * 1024 * 1024;
/** Header parse window — RA encrypted indexes fit well under this for stock mixes. */
const HEADER_PARSE_BYTES = 2 * 1024 * 1024;

export type LazyMixFileStats = {
    name: string;
    fileSize: number;
    indexEntries: number;
    dataStart: number;
    fullBufferBytes: number;
    entryCacheBytes: number;
    entryCacheCount: number;
};

/**
 * Theater-mix pilot: keep the File + directory index resident, materialize entry
 * bytes into an LRU, and optionally drop the full ArrayBuffer after initial load.
 *
 * Sync openFile stays compatible with LazyResourceCollection by reading missing
 * entries via sync blob XHR (or from the full buffer when still held).
 */
export class LazyMixFile {
    private readonly file: File;
    private readonly name: string;
    private readonly index: Map<number, MixEntry>;
    private readonly dataStart: number;
    private readonly entryCache: ByteLruCache<number>;
    private fullBuffer?: ArrayBuffer;
    private syncSliceWorks = true;

    private constructor(
        file: File,
        name: string,
        index: Map<number, MixEntry>,
        dataStart: number,
        entryCacheBytes: number,
    ) {
        this.file = file;
        this.name = name;
        this.index = index;
        this.dataStart = dataStart;
        this.entryCache = new ByteLruCache(entryCacheBytes);
    }

    static async fromFile(
        file: File,
        name: string = file.name,
        entryCacheBytes: number = DEFAULT_ENTRY_CACHE_BYTES,
    ): Promise<LazyMixFile> {
        const headerLen = Math.min(file.size, HEADER_PARSE_BYTES);
        const headerBuf = await file.slice(0, headerLen).arrayBuffer();
        const parsed = new MixFile(new DataStream(headerBuf));
        const index = new Map(parsed.getIndexEntries());
        const dataStart = parsed.getDataStart();
        // Sanity: largest extent should fit in the real file.
        let maxEnd = dataStart;
        for (const entry of index.values()) {
            maxEnd = Math.max(maxEnd, dataStart + entry.offset + entry.length);
        }
        if (maxEnd > file.size) {
            throw new Error(
                `LazyMixFile "${name}": index extent ${maxEnd} exceeds file size ${file.size}`,
            );
        }
        console.info(
            `[LazyMixFile] indexed "${name}" entries=${index.size} dataStart=${dataStart} ` +
            `file=${(file.size / (1024 * 1024)).toFixed(1)}MiB headerParse=${(headerLen / 1024).toFixed(0)}KiB`,
        );
        return new LazyMixFile(file, name, index, dataStart, entryCacheBytes);
    }

    /** Load the entire mix into RAM (same peak as classic MixFile). */
    async hydrate(): Promise<void> {
        if (this.fullBuffer) {
            return;
        }
        this.fullBuffer = await this.file.arrayBuffer();
        console.info(
            `[LazyMixFile] hydrated "${this.name}" (${(this.fullBuffer.byteLength / (1024 * 1024)).toFixed(1)}MiB)`,
        );
    }

    /**
     * Drop the full ArrayBuffer. Opened entries stay in the LRU; further misses
     * re-fetch slices from the File (sync XHR) or re-hydrate if that fails.
     */
    releaseFullBuffer(): void {
        if (!this.fullBuffer) {
            return;
        }
        const freed = this.fullBuffer.byteLength;
        this.fullBuffer = undefined;
        console.info(
            `[LazyMixFile] released full buffer for "${this.name}" ` +
            `(freed≈${(freed / (1024 * 1024)).toFixed(1)}MiB, entryCache≈${(this.entryCache.getByteLength() / (1024 * 1024)).toFixed(1)}MiB)`,
        );
    }

    containsFile(filename: string): boolean {
        return this.index.has(MixEntry.hashFilename(filename));
    }

    openFile(filename: string): VirtualFile {
        const hash = MixEntry.hashFilename(filename);
        const entry = this.index.get(hash);
        if (!entry) {
            throw new Error(`File "${filename}" not found in LazyMixFile "${this.name}"`);
        }
        let bytes = this.entryCache.get(hash);
        if (!bytes) {
            bytes = this.readEntryBytes(entry);
            this.entryCache.set(hash, bytes);
        }
        return VirtualFile.fromBytes(bytes, filename);
    }

    getStats(): LazyMixFileStats {
        return {
            name: this.name,
            fileSize: this.file.size,
            indexEntries: this.index.size,
            dataStart: this.dataStart,
            fullBufferBytes: this.fullBuffer?.byteLength ?? 0,
            entryCacheBytes: this.entryCache.getByteLength(),
            entryCacheCount: this.entryCache.size,
        };
    }

    private readEntryBytes(entry: MixEntry): ArrayBuffer {
        const start = this.dataStart + entry.offset;
        const end = start + entry.length;
        if (this.fullBuffer) {
            return this.fullBuffer.slice(start, end);
        }
        if (this.syncSliceWorks) {
            try {
                return syncReadBlobSlice(this.file, start, end);
            }
            catch (error) {
                console.warn(
                    `[LazyMixFile] sync slice failed for "${this.name}", falling back to full hydrate`,
                    error,
                );
                this.syncSliceWorks = false;
            }
        }
        // Last resort: pull the whole file via sync XHR once and keep it.
        try {
            this.fullBuffer = syncReadBlobSlice(this.file, 0, this.file.size);
            return this.fullBuffer.slice(start, end);
        }
        catch (error) {
            throw new Error(
                `LazyMixFile "${this.name}": cannot read entry (sync blob read unavailable). ` +
                `Original error: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
