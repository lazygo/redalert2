import { EventDispatcher } from '@/util/event';
import { NetPlayClientMessage, NetPlayServerMessage } from '@/network/netplay/NetPlayProtocol';

export type WsClientStatus = 'disconnected' | 'connecting' | 'connected';

export class WsClient {
    private socket?: WebSocket;
    private status: WsClientStatus = 'disconnected';
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private intentionalClose = false;

    public readonly onStatusChange = new EventDispatcher<this, WsClientStatus>();
    public readonly onMessage = new EventDispatcher<this, NetPlayServerMessage>();
    public readonly onError = new EventDispatcher<this, string>();

    getStatus(): WsClientStatus {
        return this.status;
    }

    isConnected(): boolean {
        return this.status === 'connected' && !!this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    connect(url: string): Promise<void> {
        this.intentionalClose = false;
        if (this.socket) {
            this.disconnect();
        }
        this.setStatus('connecting');
        return new Promise((resolve, reject) => {
            let settled = false;
            try {
                this.socket = new WebSocket(url);
            } catch (error) {
                this.setStatus('disconnected');
                reject(error);
                return;
            }
            this.socket.onopen = () => {
                this.setStatus('connected');
                this.startHeartbeat();
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };
            this.socket.onmessage = (event) => {
                try {
                    const parsed = JSON.parse(String(event.data)) as NetPlayServerMessage;
                    this.onMessage.dispatch(this, parsed);
                } catch {
                    this.onError.dispatch(this, 'invalid server message');
                }
            };
            this.socket.onerror = () => {
                this.onError.dispatch(this, 'websocket error');
                if (!settled) {
                    settled = true;
                    reject(new Error('websocket error'));
                }
            };
            this.socket.onclose = () => {
                this.stopHeartbeat();
                this.socket = undefined;
                this.setStatus('disconnected');
                if (!settled && !this.intentionalClose) {
                    settled = true;
                    reject(new Error('websocket closed'));
                }
            };
        });
    }

    disconnect(): void {
        this.intentionalClose = true;
        this.stopHeartbeat();
        if (this.socket) {
            try {
                this.socket.close();
            } catch {
                // ignore
            }
            this.socket = undefined;
        }
        this.setStatus('disconnected');
    }

    send(message: NetPlayClientMessage): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not connected');
        }
        this.socket.send(JSON.stringify(message));
    }

    private setStatus(status: WsClientStatus): void {
        if (this.status === status) {
            return;
        }
        this.status = status;
        this.onStatusChange.dispatch(this, status);
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.isConnected()) {
                try {
                    this.send({ type: 'ping' });
                } catch {
                    // ignore
                }
            }
        }, 20000);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }
}
