/**
 * Blocks accidental tab close / refresh / history back while an online match is active.
 *
 * Important for mobile: never call window.confirm() or history.back() inside popstate.
 * Those patterns race on iOS/Android WebViews and can bounce the player back to the home screen.
 */
export class NavigationGuard {
    private active = false;
    private message = '';
    private ignorePopStateUntil = 0;
    private readonly historyMarker = { __ra2NavGuard: true as const };

    private readonly handleBeforeUnload = (event: BeforeUnloadEvent): void => {
        if (!this.active) {
            return;
        }
        event.preventDefault();
        event.returnValue = this.message;
    };

    private readonly handlePopState = (): void => {
        if (!this.active) {
            return;
        }
        // Ignore spurious popstate right after we arm the guard (common on mobile WebViews).
        if (performance.now() < this.ignorePopStateUntil) {
            this.rearmHistory();
            return;
        }
        // Trap back/swipe-back: stay on this page. Player must quit via in-game menu.
        this.rearmHistory();
    };

    private rearmHistory(): void {
        try {
            history.pushState(this.historyMarker, '', location.href);
        }
        catch {
            // Ignore SecurityError in restricted contexts.
        }
    }

    enable(message: string): void {
        this.message = message;
        if (this.active) {
            return;
        }
        this.active = true;
        this.ignorePopStateUntil = performance.now() + 1500;
        window.addEventListener('beforeunload', this.handleBeforeUnload);
        window.addEventListener('popstate', this.handlePopState);
        this.rearmHistory();
    }

    disable(): void {
        if (!this.active) {
            return;
        }
        this.active = false;
        this.ignorePopStateUntil = 0;
        window.removeEventListener('beforeunload', this.handleBeforeUnload);
        window.removeEventListener('popstate', this.handlePopState);
    }

    isActive(): boolean {
        return this.active;
    }
}
