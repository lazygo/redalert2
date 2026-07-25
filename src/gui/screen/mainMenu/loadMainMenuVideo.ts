import { Engine } from '@/engine/Engine';

/**
 * Load the main-menu background video as a blob: URL so callers can revoke it
 * and drop the underlying buffer when leaving the menu.
 */
export async function loadMainMenuVideoSrc(): Promise<string | undefined> {
    const videoFileName = Engine.rfsSettings.menuVideoFileName;
    try {
        if (Engine.rfs) {
            try {
                if (await Engine.rfs.containsEntry(videoFileName)) {
                    const file = await Engine.rfs.getRawFile(videoFileName);
                    if (file.size > 0) {
                        return URL.createObjectURL(file);
                    }
                }
            }
            catch (error) {
                console.warn('[loadMainMenuVideoSrc] RFS lookup failed', error);
            }
        }
        if (!Engine.vfs) {
            return undefined;
        }
        const candidates = [
            videoFileName,
            'ra2ts_l.mp4',
            'menu.webm',
            'menu.mp4',
            'ra2ts_l.avi',
        ];
        for (const name of candidates) {
            if (name.endsWith('.bik')) {
                continue;
            }
            if (!Engine.vfs.fileExists(name)) {
                continue;
            }
            const bytes = Engine.vfs.openFile(name).getBytes();
            if (bytes.byteLength === 0) {
                continue;
            }
            const type = name.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
            return URL.createObjectURL(new Blob([bytes], { type }));
        }
        console.warn('[loadMainMenuVideoSrc] No playable menu video found');
        return undefined;
    }
    catch (error) {
        console.error('[loadMainMenuVideoSrc] Failed', error);
        return undefined;
    }
}

export function releaseMainMenuVideoSrc(src: string | File | undefined): void {
    if (typeof src === 'string' && src.startsWith('blob:')) {
        try {
            URL.revokeObjectURL(src);
        }
        catch {
            // ignore
        }
    }
}
