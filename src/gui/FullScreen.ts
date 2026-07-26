import { CompositeDisposable } from '../util/disposable/CompositeDisposable';
import { setupFullScreenChangeListener } from '../util/fullScreen';
import { EventDispatcher } from '../util/event';

export interface HotKey {
    altKey: boolean;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    keyCode: number;
}

const IMMERSIVE_CLASS = 'ra2-immersive';

function getFullscreenElement(doc: Document): Element | null {
    const d = doc as Document & {
        webkitFullscreenElement?: Element | null;
        mozFullScreenElement?: Element | null;
        msFullscreenElement?: Element | null;
    };
    return (
        doc.fullscreenElement ||
        d.webkitFullscreenElement ||
        d.mozFullScreenElement ||
        d.msFullscreenElement ||
        null
    );
}

function isNativeFullscreenEnabled(doc: Document): boolean {
    const d = doc as Document & {
        webkitFullscreenEnabled?: boolean;
        mozFullScreenEnabled?: boolean;
        msFullscreenEnabled?: boolean;
    };
    return !!(
        doc.fullscreenEnabled ||
        d.webkitFullscreenEnabled ||
        d.mozFullScreenEnabled ||
        d.msFullscreenEnabled
    );
}

async function requestNativeFullscreen(el: HTMLElement): Promise<void> {
    const node = el as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
        webkitRequestFullScreen?: () => Promise<void> | void;
        mozRequestFullScreen?: () => Promise<void> | void;
        msRequestFullscreen?: () => Promise<void> | void;
    };
    if (typeof node.requestFullscreen === 'function') {
        await node.requestFullscreen();
        return;
    }
    if (typeof node.webkitRequestFullscreen === 'function') {
        await node.webkitRequestFullscreen();
        return;
    }
    if (typeof node.webkitRequestFullScreen === 'function') {
        await node.webkitRequestFullScreen();
        return;
    }
    if (typeof node.mozRequestFullScreen === 'function') {
        await node.mozRequestFullScreen();
        return;
    }
    if (typeof node.msRequestFullscreen === 'function') {
        await node.msRequestFullscreen();
        return;
    }
    throw new Error('Fullscreen API not supported');
}

async function exitNativeFullscreen(doc: Document): Promise<void> {
    const d = doc as Document & {
        webkitExitFullscreen?: () => Promise<void> | void;
        webkitCancelFullScreen?: () => Promise<void> | void;
        mozCancelFullScreen?: () => Promise<void> | void;
        msExitFullscreen?: () => Promise<void> | void;
    };
    if (typeof doc.exitFullscreen === 'function' && getFullscreenElement(doc)) {
        await doc.exitFullscreen();
        return;
    }
    if (typeof d.webkitExitFullscreen === 'function') {
        await d.webkitExitFullscreen();
        return;
    }
    if (typeof d.webkitCancelFullScreen === 'function') {
        await d.webkitCancelFullScreen();
        return;
    }
    if (typeof d.mozCancelFullScreen === 'function') {
        await d.mozCancelFullScreen();
        return;
    }
    if (typeof d.msExitFullscreen === 'function') {
        await d.msExitFullscreen();
        return;
    }
}

/** iPhone/iPod (and iPad-as-iPhone UA) — no reliable document Fullscreen API. */
function isAppleTouchDevice(): boolean {
    if (typeof navigator === 'undefined') {
        return false;
    }
    const ua = navigator.userAgent || '';
    if (/iPhone|iPod/.test(ua)) {
        return true;
    }
    // iPadOS 13+ may report as MacIntel with touch
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
        return true;
    }
    return /iPad/.test(ua);
}

function isCoarsePointer(): boolean {
    try {
        return !!window.matchMedia?.('(pointer: coarse)').matches;
    }
    catch {
        return false;
    }
}

export class FullScreen {
    public static readonly hotKey: HotKey = {
        altKey: true,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        keyCode: "F".charCodeAt(0),
    };
    private readonly document: Document;
    private readonly disposables: CompositeDisposable;
    private readonly _onChange: EventDispatcher<FullScreen, boolean>;
    /** CSS immersive mode used when native Fullscreen API is unavailable (iOS Safari). */
    private immersiveMode = false;

    public get onChange() {
        return this._onChange.asEvent();
    }
    constructor(document: Document) {
        this.document = document;
        this.disposables = new CompositeDisposable();
        this._onChange = new EventDispatcher<FullScreen, boolean>();
    }
    public static isFullScreenHotKey(event: KeyboardEvent): boolean {
        return (event.keyCode === this.hotKey.keyCode &&
            event.altKey === this.hotKey.altKey &&
            event.shiftKey === this.hotKey.shiftKey &&
            event.ctrlKey === this.hotKey.ctrlKey &&
            event.metaKey === this.hotKey.metaKey);
    }
    public init(): void {
        const keyDownHandler = (event: KeyboardEvent) => {
            if (FullScreen.isFullScreenHotKey(event)) {
                event.preventDefault();
                event.stopPropagation();
                this.toggle();
            }
        };
        this.document.addEventListener("keydown", keyDownHandler);
        this.disposables.add(() => this.document.removeEventListener("keydown", keyDownHandler));
        const cleanup = setupFullScreenChangeListener(this.document, (isFs) => {
            // Native FS won — drop immersive flag if any.
            if (isFs) {
                this.setImmersiveClass(false);
                this.immersiveMode = false;
            }
            this.handleFullScreenChange(this.isFullScreen());
        });
        if (cleanup) {
            this.disposables.add(cleanup);
        }
        this.disposables.add(() => {
            this.setImmersiveClass(false);
            this.immersiveMode = false;
        });
    }
    private handleFullScreenChange = (isFullScreen: boolean): void => {
        this._onChange.dispatch(this, isFullScreen);
    };
    public toggle(): void {
        this.toggleAsync().catch((error) => console.error(error));
    }
    public isFullScreen(): boolean {
        return !!getFullscreenElement(this.document) || this.immersiveMode;
    }
    /** True when either native FS or iOS/mobile immersive fallback can be used. */
    public isAvailable(): boolean {
        return this.canUseNativeApi() || this.canUseImmersiveFallback();
    }
    private canUseNativeApi(): boolean {
        return isNativeFullscreenEnabled(this.document);
    }
    /**
     * iPhone Safari reports fullscreenEnabled=false. Offer a CSS "immersive"
     * layout so the menu button is not permanently greyed out.
     */
    private canUseImmersiveFallback(): boolean {
        if (this.canUseNativeApi()) {
            return false;
        }
        return isAppleTouchDevice() || isCoarsePointer();
    }
    public async toggleAsync(): Promise<void> {
        if (this.isFullScreen()) {
            await this.exitAsync();
            return;
        }
        await this.enterAsync();
    }
    private async enterAsync(): Promise<void> {
        if (this.canUseNativeApi()) {
            try {
                await requestNativeFullscreen(this.document.documentElement);
                try {
                    await (screen?.orientation as any)?.lock?.("landscape");
                }
                catch (error) {
                    console.warn("Orientation lock failed", error);
                }
                // Some WebKits resolve without actually entering; fall back if needed.
                if (!getFullscreenElement(this.document)) {
                    this.enterImmersive();
                }
                return;
            }
            catch (error) {
                console.warn("Native fullscreen failed, using immersive fallback", error);
            }
        }
        if (this.canUseImmersiveFallback()) {
            this.enterImmersive();
            return;
        }
        throw new Error('Fullscreen is not available in this browser');
    }
    private async exitAsync(): Promise<void> {
        if (getFullscreenElement(this.document)) {
            try {
                screen?.orientation?.unlock?.();
            }
            catch (_error) {
            }
            await exitNativeFullscreen(this.document);
        }
        if (this.immersiveMode) {
            this.exitImmersive();
        }
    }
    private enterImmersive(): void {
        this.immersiveMode = true;
        this.setImmersiveClass(true);
        // Nudge Safari to collapse the URL bar when possible.
        try {
            window.scrollTo(0, 1);
            requestAnimationFrame(() => window.scrollTo(0, 0));
        }
        catch (_error) {
        }
        this.handleFullScreenChange(true);
    }
    private exitImmersive(): void {
        this.immersiveMode = false;
        this.setImmersiveClass(false);
        this.handleFullScreenChange(false);
    }
    private setImmersiveClass(on: boolean): void {
        this.document.documentElement.classList.toggle(IMMERSIVE_CLASS, on);
        this.document.body?.classList.toggle(IMMERSIVE_CLASS, on);
    }
    public dispose(): void {
        this.disposables.dispose();
    }
}
