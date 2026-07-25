export interface LoadingScreenApi {
    start(...args: any[]): Promise<void>;
    onLoadProgress(percent: number): void;
    dispose(): void;
    updateViewport(): void;
    /** Optional: keep alive after initial load for mid-match network wait UI. */
    endLoading?(): void;
    beginNetworkWait?(): void;
    hideNetworkWait?(): void;
}
