import {
    getOriginPrivateDirectory,
    polyfillDataTransferItem,
    showDirectoryPicker,
    showOpenFilePicker,
    showSaveFilePicker,
    support,
} from 'file-system-access';
import cache from 'file-system-access/lib/adapters/cache.js';
import indexeddb from 'file-system-access/lib/adapters/indexeddb.js';
import type { FileSystemAccessLib } from './FileSystemAccessLib';

/**
 * file-system-access's `support.adapter` only reports native/cache/sandbox.
 * IndexedDB is always available as a bundled polyfill and is required on plain HTTP
 * (non-localhost) where OPFS `navigator.storage.getDirectory` is unavailable.
 */
export const browserFileSystemAccess: FileSystemAccessLib = {
    support: {
        adapter: {
            ...support.adapter,
            indexeddb: typeof indexedDB !== 'undefined',
        },
    },
    adapters: {
        indexeddb,
        cache,
    },
    getOriginPrivateDirectory,
    async polyfillDataTransferItem() {
        await polyfillDataTransferItem();
    },
    showDirectoryPicker,
    showOpenFilePicker,
    showSaveFilePicker,
};
