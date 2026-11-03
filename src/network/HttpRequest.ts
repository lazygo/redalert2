import { OperationCanceledError, CancellationToken } from "@puzzl/core/lib/async/cancellation";
export class DownloadError extends Error {
    public statusCode?: number;
    constructor(message: string, options?: ErrorOptions, statusCode?: number) {
        super(message, options);
        this.name = "DownloadError";
        this.statusCode = statusCode;
    }
}
/**
 * Thrown when the server responds with an HTML page for a non-HTML request.
 * In practice this means the URL fell through to the SPA index.html fallback,
 * i.e. the requested file does not exist on the server (missing deployment
 * asset), rather than an actual network failure.
 */
export class ResourceNotFoundError extends DownloadError {
    public url: string;
    constructor(url: string, contentType: string, status: number) {
        super(`资源不存在：${url}（服务器返回了 "${contentType}" 页面而非文件内容，通常是该文件未部署或路径错误）`, undefined, status);
        this.name = "ResourceNotFoundError";
        this.url = url;
    }
}
interface FetchOptions {
    body?: BodyInit | null;
    method?: string;
    headers?: HeadersInit;
    onProgress?: (loadedDelta: number, totalLength?: number) => void;
    allowHtmlMimeType?: boolean;
}
interface FetchAndParseOptions {
    url: string;
    type: 'text' | 'binary' | 'json';
}
export class HttpRequest {
    async fetchText(url: string, cancellationToken?: CancellationToken, options?: FetchOptions): Promise<string> {
        return await this.fetchAndParse({ url, type: "text" }, cancellationToken, options) as string;
    }
    async fetchBinary(url: string, cancellationToken?: CancellationToken, options?: FetchOptions): Promise<ArrayBuffer> {
        const result = await this.fetchAndParse({ url, type: "binary" }, cancellationToken, options);
        return result as ArrayBuffer;
    }
    async fetchJson(url: string, cancellationToken?: CancellationToken, options?: FetchOptions): Promise<any> {
        return await this.fetchAndParse({ url, type: "json" }, cancellationToken, options);
    }
    async fetchHtml(url: string, cancellationToken?: CancellationToken, options?: FetchOptions): Promise<string> {
        return await this.fetchAndParse({ url, type: "text" }, cancellationToken, {
            ...options,
            allowHtmlMimeType: true,
        }) as string;
    }
    private async fetchAndParse(request: FetchAndParseOptions, cancellationToken?: CancellationToken, options?: FetchOptions): Promise<ArrayBuffer | string | any> {
        const rawData = await this.fetchRaw(request.url, cancellationToken, options);
        return this.parseResult(request.type, rawData);
    }
    async fetchRaw(url: string, cancellationToken?: CancellationToken, options?: FetchOptions): Promise<ArrayBuffer> {
        const abortController = new AbortController();
        cancellationToken?.register(() => {
            abortController.abort();
        });
        let response: Response;
        try {
            response = await fetch(url, {
                signal: abortController.signal,
                body: options?.body,
                method: options?.method,
                headers: options?.headers,
            });
        }
        catch (error: any) {
            if (cancellationToken &&
                (error.name === 'AbortError' ||
                    (error instanceof DOMException && error.code === DOMException.ABORT_ERR) ||
                    cancellationToken.isCancelled())) {
                throw new OperationCanceledError(cancellationToken);
            }
            console.error('Fetch raw failed:', error);
            throw new DownloadError(`Fetch failed with error: ${error.name}: ${error.message}`, { cause: error });
        }
        if (!response.ok) {
            throw new DownloadError(`Fetch failed with status ${response.status}: ${response.statusText}`, undefined, response.status);
        }
        const contentType = response.headers.get("Content-Type");
        if (contentType && contentType.includes("text/html") && !options?.allowHtmlMimeType) {
            throw new ResourceNotFoundError(url, contentType, response.status);
        }
        if (!response.body) {
            throw new DownloadError("Response has no body.");
        }
        const reader = response.body.getReader();
        const contentLength = Number(response.headers.get('Content-Length') || 0);
        const chunks: Uint8Array[] = [];
        let receivedLength = 0;
        try {
            while (true) {
                cancellationToken?.throwIfCancelled();
                const { done, value } = await reader.read();
                if (cancellationToken?.isCancelled()) {
                    reader.cancel('Download cancelled by user');
                    throw new OperationCanceledError(cancellationToken);
                }
                if (done) {
                    break;
                }
                chunks.push(value!);
                receivedLength += value!.length;
                options?.onProgress?.(value!.length, contentLength);
            }
        }
        catch (error: any) {
            if (error.name === 'AbortError' || error instanceof OperationCanceledError) {
                throw error;
            }
            console.error('Error during response body reading:', error);
            throw new DownloadError(`Failed to read response body: ${error.message}`, { cause: error });
        }
        const completeBuffer = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
            completeBuffer.set(chunk, position);
            position += chunk.length;
        }
        return completeBuffer.buffer;
    }
    parseResult(type: 'text' | 'binary' | 'json', data: ArrayBuffer): ArrayBuffer | string | any {
        if (type === "binary") {
            return data;
        }
        const text = new TextDecoder("utf-8").decode(data);
        if (type === "json") {
            try {
                return JSON.parse(text);
            }
            catch (e: any) {
                throw new Error(`Failed to parse JSON: ${e.message}. Content: ${text.substring(0, 100)}`);
            }
        }
        return text;
    }
}
