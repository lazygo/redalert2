export function isIpad(): boolean {
    return (/iPad/i.test(navigator.userAgent) ||
        (/MacIntel/i.test(navigator.platform) && !!navigator.maxTouchPoints));
}
export function isMac(): boolean {
    return navigator.platform.includes("Mac");
}
export function isMacFirefox(): boolean {
    return isMac() && navigator.userAgent.toLowerCase().includes("firefox");
}
/** Phones / tablets / coarse-pointer devices where GPU memory is tight. */
export function isMobileDevice(): boolean {
    if (typeof navigator === "undefined") {
        return false;
    }
    if (/iPhone|Android|CrOS|Windows Phone|webOS/i.test(navigator.userAgent) || isIpad()) {
        return true;
    }
    try {
        return !!window.matchMedia?.("(pointer: coarse)")?.matches;
    }
    catch {
        return false;
    }
}
