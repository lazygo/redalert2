export type FullScreenChangeHandler = (isFullScreen: boolean) => void;

function getFullscreenElement(document: Document): Element | null {
    const d = document as Document & {
        webkitFullscreenElement?: Element | null;
        mozFullScreenElement?: Element | null;
        msFullscreenElement?: Element | null;
    };
    return (
        document.fullscreenElement ||
        d.webkitFullscreenElement ||
        d.mozFullScreenElement ||
        d.msFullscreenElement ||
        null
    );
}

function isFullscreenApiPresent(document: Document): boolean {
    const d = document as Document & {
        webkitFullscreenEnabled?: boolean;
        mozFullScreenEnabled?: boolean;
        msFullscreenEnabled?: boolean;
    };
    return !!(
        document.fullscreenEnabled ||
        d.webkitFullscreenEnabled ||
        d.mozFullScreenEnabled ||
        d.msFullscreenEnabled
    );
}

export function setupFullScreenChangeListener(document: Document, handler: FullScreenChangeHandler): (() => void) | undefined {
    if (!isFullscreenApiPresent(document)) {
        console.warn("Browser fullscreen API not available (immersive fallback may still work).");
        return undefined;
    }
    let canF11Request = true;
    const fullscreenChangeHandler = () => {
        const isFullScreen = !!getFullscreenElement(document);
        if (isFullScreen) {
            canF11Request = false;
        }
        else {
            setTimeout(() => (canF11Request = true), 100);
        }
        handler(isFullScreen);
    };
    const keyUpHandler = async (event: KeyboardEvent) => {
        if (event.keyCode === 122 && canF11Request && !getFullscreenElement(document)) {
            try {
                const el = document.documentElement as HTMLElement & {
                    webkitRequestFullscreen?: () => Promise<void> | void;
                };
                if (typeof el.requestFullscreen === 'function') {
                    await el.requestFullscreen();
                }
                else if (typeof el.webkitRequestFullscreen === 'function') {
                    await el.webkitRequestFullscreen();
                }
            }
            catch (error) {
                console.warn("Full screen permission denied by user.");
            }
        }
    };
    document.addEventListener("fullscreenchange", fullscreenChangeHandler);
    document.addEventListener("webkitfullscreenchange", fullscreenChangeHandler as EventListener);
    document.addEventListener("keyup", keyUpHandler);
    return () => {
        document.removeEventListener("fullscreenchange", fullscreenChangeHandler);
        document.removeEventListener("webkitfullscreenchange", fullscreenChangeHandler as EventListener);
        document.removeEventListener("keyup", keyUpHandler);
    };
}
