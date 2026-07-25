import { EventDispatcher } from '@/util/event';
import { LanMatchTransport } from '@/network/lan/LanMatchSession';
import { LanMeshAppMessage, LanMeshSnapshot, LanMemberSnapshot } from '@/network/lan/LanMeshSession';
import { LanPeerIdentity } from '@/network/lan/LanQrPayload';
import { WsClient } from '@/network/netplay/WsClient';
import { NetPlayPeerInfo, NetPlayRoomInfo, NetPlayServerMessage } from '@/network/netplay/NetPlayProtocol';

export type NetPlayConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

export interface WsRoomTransportSnapshot {
    self: LanPeerIdentity;
    roomId?: string;
    isInRoom: boolean;
    roomReady: boolean;
    directPeerCount: number;
    members: LanMemberSnapshot[];
    rooms: NetPlayRoomInfo[];
    currentRoom?: NetPlayRoomInfo;
    connected: boolean;
}

/**
 * Full WebSocket room transport. Implements LanMatchTransport for lockstep
 * and a LanMeshSession-compatible surface for NetRoomSession.
 */
export class WsRoomTransport implements LanMatchTransport {
    private readonly client = new WsClient();
    private self: LanPeerIdentity = { id: '', name: 'Player' };
    private roomId?: string;
    private currentRoom?: NetPlayRoomInfo;
    private members = new Map<string, NetPlayPeerInfo>();
    private rooms: NetPlayRoomInfo[] = [];
    private welcomeReceived = false;
    private autoReconnect = false;
    private reconnectUrl?: string;
    private reconnectNickname = 'Player';
    private reconnectAttempt = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private connectPromise?: Promise<void>;
    private matchMode = false;
    private disconnectedMemberIds = new Set<string>();
    private connectionStatus: NetPlayConnectionStatus = 'disconnected';
    private hasConnectedOnce = false;

    public readonly onSnapshotChange = new EventDispatcher<this, LanMeshSnapshot>();
    public readonly onAppMessage = new EventDispatcher<this, LanMeshAppMessage>();
    public readonly onRoomsChange = new EventDispatcher<this, NetPlayRoomInfo[]>();
    public readonly onLog = new EventDispatcher<this, { level: 'info' | 'warn' | 'error'; text: string; timestamp: number }>();
    public readonly onConnectionChange = new EventDispatcher<this, boolean>();
    public readonly onConnectionStatusChange = new EventDispatcher<this, NetPlayConnectionStatus>();
    public readonly onMatchResumeFailed = new EventDispatcher<this, void>();

    constructor() {
        this.client.onMessage.subscribe((message) => this.handleServerMessage(message));
        this.client.onStatusChange.subscribe((status) => {
            if (status !== 'connected') {
                this.welcomeReceived = false;
                if (this.matchMode && this.roomId) {
                    this.log('warn', '对局连接中断，正在尝试重连…');
                } else if (this.roomId) {
                    this.roomId = undefined;
                    this.currentRoom = undefined;
                    this.members.clear();
                    this.disconnectedMemberIds.clear();
                    this.log('warn', '与服务器断开连接，已自动离开房间');
                }
                this.onConnectionChange.dispatch(this, false);
                this.dispatchSnapshot();
                if (this.autoReconnect && !this.connectPromise) {
                    this.scheduleReconnect();
                } else if (!this.connectPromise) {
                    this.setConnectionStatus(
                        this.autoReconnect && this.hasConnectedOnce ? 'reconnecting' : 'disconnected'
                    );
                }
                return;
            }
            this.dispatchSnapshot();
        });
        this.client.onError.subscribe((text) => {
            this.log('error', text);
        });
    }

    async connect(url: string, nickname: string): Promise<void> {
        this.reconnectUrl = url;
        this.reconnectNickname = nickname.trim() || 'Player';
        this.clearReconnectTimer();
        this.setConnectionStatus(this.hasConnectedOnce || this.matchMode ? 'reconnecting' : 'connecting');
        try {
            await this.connectInternal();
        } catch (error) {
            if (this.autoReconnect) {
                this.scheduleReconnect();
            } else {
                this.setConnectionStatus('disconnected');
            }
            throw error;
        }
    }

    /** Lobby screen enables this; leave/game launch disables so mid-match reconnect stays off. */
    setAutoReconnect(enabled: boolean): void {
        // Match mode owns reconnect until setMatchReconnect(false); ignore lobby onLeave.
        if (!enabled && this.matchMode) {
            return;
        }
        this.autoReconnect = enabled;
        if (!enabled) {
            this.clearReconnectTimer();
            if (!this.isConnected()) {
                this.setConnectionStatus('disconnected');
            }
            return;
        }
        if (!this.isConnected() && this.reconnectUrl && !this.connectPromise) {
            this.scheduleReconnect();
        }
    }

    /** Keep room seat + auto-reconnect while a lockstep match is running. */
    setMatchReconnect(enabled: boolean): void {
        this.matchMode = enabled;
        this.setAutoReconnect(enabled);
        if (!enabled) {
            this.disconnectedMemberIds.clear();
        }
    }

    getConnectionStatus(): NetPlayConnectionStatus {
        return this.connectionStatus;
    }

    disconnect(): void {
        this.matchMode = false;
        this.autoReconnect = false;
        this.clearReconnectTimer();
        try {
            if (this.roomId) {
                this.client.send({ type: 'leave-room' });
            }
        } catch {
            // ignore
        }
        this.roomId = undefined;
        this.currentRoom = undefined;
        this.members.clear();
        this.disconnectedMemberIds.clear();
        this.welcomeReceived = false;
        this.client.disconnect();
        this.setConnectionStatus('disconnected');
        this.dispatchSnapshot();
    }

    private async connectInternal(): Promise<void> {
        if (this.connectPromise) {
            return this.connectPromise;
        }
        if (!this.reconnectUrl) {
            throw new Error('WebSocket URL is not set');
        }
        const resumePeerId = this.matchMode ? this.self.id : '';
        const resumeRoomId = this.matchMode ? this.roomId : undefined;
        this.setConnectionStatus(
            this.hasConnectedOnce || this.reconnectAttempt > 0 || this.matchMode ? 'reconnecting' : 'connecting'
        );
        this.connectPromise = (async () => {
            this.self = {
                id: resumePeerId || '',
                name: this.reconnectNickname,
            };
            this.welcomeReceived = false;
            try {
                await this.client.connect(this.reconnectUrl!);
                const hello: { type: 'hello'; nickname: string; resumePeerId?: string; roomId?: string } = {
                    type: 'hello',
                    nickname: this.self.name,
                };
                if (resumePeerId && resumeRoomId) {
                    hello.resumePeerId = resumePeerId;
                    hello.roomId = resumeRoomId;
                }
                this.client.send(hello);
                await this.waitForWelcome(8000);
                if (resumePeerId && (this.self.id !== resumePeerId || this.roomId !== resumeRoomId)) {
                    this.matchMode = false;
                    this.autoReconnect = false;
                    this.onMatchResumeFailed.dispatch(this);
                    throw new Error('match resume failed');
                }
            } catch (error) {
                try {
                    this.client.disconnect();
                } catch {
                    // ignore
                }
                this.welcomeReceived = false;
                throw error;
            }
            this.reconnectAttempt = 0;
            this.hasConnectedOnce = true;
            if (!this.matchMode) {
                this.refreshRooms();
            }
        })();
        try {
            await this.connectPromise;
        } finally {
            this.connectPromise = undefined;
        }
    }

    private scheduleReconnect(): void {
        if (!this.autoReconnect || !this.reconnectUrl || this.reconnectTimer || this.connectPromise) {
            return;
        }
        if (this.client.getStatus() === 'connecting' || this.client.isConnected()) {
            return;
        }
        this.setConnectionStatus('reconnecting');
        const delayMs = Math.min(1000 * (2 ** this.reconnectAttempt), 15000);
        this.reconnectAttempt += 1;
        this.log('warn', `连接断开，${Math.round(delayMs / 1000)}s 后尝试重连…`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (!this.autoReconnect || this.isConnected()) {
                return;
            }
            void this.connectInternal().catch((error) => {
                this.log('warn', `重连失败: ${(error as Error).message || String(error)}`);
                this.scheduleReconnect();
            });
        }, delayMs);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private setConnectionStatus(status: NetPlayConnectionStatus): void {
        if (this.connectionStatus === status) {
            return;
        }
        this.connectionStatus = status;
        this.onConnectionStatusChange.dispatch(this, status);
    }

    isConnected(): boolean {
        return this.client.isConnected() && this.welcomeReceived;
    }

    getSelf(): LanPeerIdentity {
        return { ...this.self };
    }

    updateSelfName(name: string): void {
        this.self = { ...this.self, name: name.trim() || this.self.name };
        this.reconnectNickname = this.self.name;
        this.dispatchSnapshot();
    }

    getRooms(): NetPlayRoomInfo[] {
        return this.rooms.map((room) => ({ ...room }));
    }

    refreshRooms(): void {
        if (!this.client.isConnected()) {
            return;
        }
        this.client.send({ type: 'list-rooms' });
    }

    createRoom(options: { title: string; maxPlayers?: number; mapName?: string; public?: boolean }): void {
        this.client.send({
            type: 'create-room',
            title: options.title,
            maxPlayers: options.maxPlayers ?? 8,
            mapName: options.mapName,
            public: options.public ?? true,
        });
    }

    joinRoom(roomId: string): void {
        this.client.send({ type: 'join-room', roomId });
    }

    updateRoomMeta(options: { title?: string; mapName?: string; maxPlayers?: number; public?: boolean }): void {
        if (!this.roomId) {
            return;
        }
        this.client.send({
            type: 'update-room',
            title: options.title,
            mapName: options.mapName,
            maxPlayers: options.maxPlayers,
            public: options.public,
        });
    }

    markMatchStarted(): void {
        if (!this.roomId) {
            return;
        }
        this.matchMode = true;
        this.client.send({ type: 'start-match' });
    }

    ensureLocalRoom(): LanMeshSnapshot {
        // Hosting is done via createRoom(); this mirrors LanMeshSession.ensureLocalRoom.
        return this.getSnapshot();
    }

    leaveRoom(): void {
        this.matchMode = false;
        this.autoReconnect = false;
        this.clearReconnectTimer();
        if (!this.roomId) {
            this.dispatchSnapshot();
            return;
        }
        try {
            this.client.send({ type: 'leave-room' });
        } catch {
            // ignore
        }
        this.roomId = undefined;
        this.currentRoom = undefined;
        this.members.clear();
        this.disconnectedMemberIds.clear();
        this.dispatchSnapshot();
    }

    getSnapshot(): LanMeshSnapshot {
        const members: LanMemberSnapshot[] = [];
        if (this.self.id) {
            members.push({
                ...this.self,
                isSelf: true,
                isDirect: true,
                status: 'self',
            });
        }
        this.members.forEach((member) => {
            if (member.id === this.self.id) {
                return;
            }
            members.push({
                id: member.id,
                name: member.name,
                isSelf: false,
                isDirect: true,
                status: this.disconnectedMemberIds.has(member.id)
                    ? 'disconnected'
                    : (this.roomId ? 'connected' : 'known'),
            });
        });
        return {
            self: this.getSelf(),
            roomId: this.roomId,
            isInRoom: !!this.roomId,
            roomReady: !!this.roomId && members.length > 0,
            directPeerCount: Math.max(0, members.length - 1),
            members,
            activeQrPayloadText: '',
        };
    }

    getTransportSnapshot(): WsRoomTransportSnapshot {
        const mesh = this.getSnapshot();
        return {
            self: mesh.self,
            roomId: mesh.roomId,
            isInRoom: mesh.isInRoom,
            roomReady: mesh.roomReady,
            directPeerCount: mesh.directPeerCount,
            members: mesh.members,
            rooms: this.getRooms(),
            currentRoom: this.currentRoom ? { ...this.currentRoom } : undefined,
            connected: this.isConnected(),
        };
    }

    broadcastAppMessage(payload: unknown, excludedPeerId?: string): void {
        if (!this.roomId) {
            return;
        }
        if (!this.client.isConnected()) {
            if (this.matchMode) {
                return;
            }
            throw new Error('WebSocket is not connected');
        }
        // Server broadcasts to everyone except sender; excludedPeerId is best-effort client-side only.
        void excludedPeerId;
        this.client.send({ type: 'room-broadcast', payload });
    }

    sendAppMessage(peerId: string, payload: unknown): void {
        if (!this.roomId) {
            return;
        }
        this.client.send({ type: 'room-send', toPeerId: peerId, payload });
    }

    private handleServerMessage(message: NetPlayServerMessage): void {
        switch (message.type) {
            case 'welcome':
                this.self = { id: message.peerId, name: message.member?.name || this.self.name };
                this.welcomeReceived = true;
                this.hasConnectedOnce = true;
                this.reconnectAttempt = 0;
                this.log('info', `已连接，peerId=${message.peerId}`);
                this.setConnectionStatus('connected');
                this.onConnectionChange.dispatch(this, true);
                this.dispatchSnapshot();
                return;
            case 'room-list':
                this.rooms = message.rooms ?? [];
                this.onRoomsChange.dispatch(this, this.getRooms());
                this.dispatchSnapshot();
                return;
            case 'room-joined':
                this.roomId = message.room.roomId;
                this.currentRoom = message.room;
                if (!this.matchMode || this.members.size === 0) {
                    this.members.clear();
                    this.disconnectedMemberIds.clear();
                    this.members.set(this.self.id, { id: this.self.id, name: this.self.name });
                } else {
                    this.disconnectedMemberIds.delete(this.self.id);
                    this.members.set(this.self.id, { id: this.self.id, name: this.self.name });
                }
                this.log('info', `已加入房间 ${message.room.title}`);
                this.dispatchSnapshot();
                return;
            case 'room-left':
                this.matchMode = false;
                this.autoReconnect = false;
                this.clearReconnectTimer();
                this.roomId = undefined;
                this.currentRoom = undefined;
                this.members.clear();
                this.disconnectedMemberIds.clear();
                if (message.reason === 'host_disconnect' || message.reason === 'host_left') {
                    this.log('warn', '房主已离开，房间已解散');
                } else if (message.reason === 'disconnect') {
                    this.log('warn', '连接中断，已离开房间');
                } else {
                    this.log('info', '已离开房间');
                }
                this.dispatchSnapshot();
                return;
            case 'member-join':
                if (message.member) {
                    this.members.set(message.member.id, message.member);
                    this.disconnectedMemberIds.delete(message.member.id);
                    if (message.reason === 'reconnected') {
                        this.log('info', `${message.member.name} 已重连`);
                    }
                }
                if (message.room) {
                    this.currentRoom = message.room;
                    this.roomId = message.room.roomId;
                }
                this.dispatchSnapshot();
                return;
            case 'member-leave':
                if (message.member) {
                    if (message.reason === 'disconnecting') {
                        this.members.set(message.member.id, message.member);
                        this.disconnectedMemberIds.add(message.member.id);
                        this.log('warn', `${message.member.name} 掉线，等待重连…`);
                    } else {
                        this.members.delete(message.member.id);
                        this.disconnectedMemberIds.delete(message.member.id);
                        const reason = message.reason === 'disconnect' ? '断开连接' : '离开房间';
                        this.log('warn', `${message.member.name} ${reason}`);
                    }
                }
                if (message.room) {
                    this.currentRoom = message.room;
                }
                this.dispatchSnapshot();
                return;
            case 'relay':
                if (!message.from) {
                    return;
                }
                this.onAppMessage.dispatch(this, {
                    from: { id: message.from.id, name: message.from.name },
                    payload: message.payload,
                    timestamp: Date.now(),
                });
                return;
            case 'error':
                this.log('error', message.message || message.code || 'server error');
                return;
            case 'pong':
                return;
            default:
                return;
        }
    }

    private waitForWelcome(timeoutMs: number): Promise<void> {
        if (this.welcomeReceived) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.client.onMessage.unsubscribe(onMessage);
                reject(new Error('welcome timeout'));
            }, timeoutMs);
            const onMessage = (message: NetPlayServerMessage, _client: WsClient) => {
                if (message.type === 'welcome') {
                    clearTimeout(timer);
                    this.client.onMessage.unsubscribe(onMessage);
                    resolve();
                }
            };
            this.client.onMessage.subscribe(onMessage);
        });
    }

    private dispatchSnapshot(): void {
        this.onSnapshotChange.dispatch(this, this.getSnapshot());
    }

    private log(level: 'info' | 'warn' | 'error', text: string): void {
        this.onLog.dispatch(this, { level, text, timestamp: Date.now() });
    }
}
