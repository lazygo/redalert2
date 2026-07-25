/**
 * Synchronous Blob/File slice read for main-thread MIX entry fetches.
 * Uses sync XHR against a blob: URL (status 0 is OK for blob URLs).
 * May be blocked in some browsers — callers must handle failure.
 */
export function syncReadBlobSlice(blob: Blob, start: number, end: number): ArrayBuffer {
    if (start < 0 || end < start || end > blob.size) {
        throw new RangeError(`syncReadBlobSlice: invalid range [${start}, ${end}) size=${blob.size}`);
    }
    const slice = start === 0 && end === blob.size ? blob : blob.slice(start, end);
    const url = URL.createObjectURL(slice);
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.responseType = 'arraybuffer';
        xhr.send(null);
        if (xhr.status !== 0 && xhr.status !== 200) {
            throw new Error(`syncReadBlobSlice failed with HTTP ${xhr.status}`);
        }
        const response = xhr.response as ArrayBuffer | null;
        if (!response) {
            throw new Error('syncReadBlobSlice returned empty response');
        }
        return response;
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
