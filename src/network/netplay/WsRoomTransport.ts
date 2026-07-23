import { EventDispatcher } from '@/util/event';
import { LanMatchTransport } from '@/network/lan/LanMatchSession';
import { LanMeshAppMessage, LanMeshSnapshot, LanMemberSnapshot } from '@/network/lan/LanMeshSession';
import { LanPeerIdentity } from '@/network/lan/LanQrPayload';
import { WsClient } from '@/network/netplay/WsClient';
import { NetPlayPeerInfo, NetPlayRoomInfo, NetPlayServerMessage } from '@/network/netplay/NetPlayProtocol';

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

    public readonly onSnapshotChange = new EventDispatcher<this, LanMeshSnapshot>();
    public readonly onAppMessage = new EventDispatcher<this, LanMeshAppMessage>();
    public readonly onRoomsChange = new EventDispatcher<this, NetPlayRoomInfo[]>();
    public readonly onLog = new EventDispatcher<this, { level: 'info' | 'warn' | 'error'; text: string; timestamp: number }>();
    public readonly onConnectionChange = new EventDispatcher<this, boolean>();

    constructor() {
        this.client.onMessage.subscribe((message) => this.handleServerMessage(message));
        this.client.onStatusChange.subscribe((status) => {
            this.onConnectionChange.dispatch(this, status === 'connected');
            this.dispatchSnapshot();
        });
        this.client.onError.subscribe((text) => {
            this.log('error', text);
        });
    }

    async connect(url: string, nickname: string): Promise<void> {
        this.self = { id: '', name: nickname.trim() || 'Player' };
        this.welcomeReceived = false;
        await this.client.connect(url);
        this.client.send({ type: 'hello', nickname: this.self.name });
        await this.waitForWelcome(8000);
    }

    disconnect(): void {
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
        this.client.disconnect();
        this.dispatchSnapshot();
    }

    isConnected(): boolean {
        return this.client.isConnected() && this.welcomeReceived;
    }

    getSelf(): LanPeerIdentity {
        return { ...this.self };
    }

    updateSelfName(name: string): void {
        this.self = { ...this.self, name: name.trim() || this.self.name };
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
        this.client.send({ type: 'start-match' });
    }

    ensureLocalRoom(): LanMeshSnapshot {
        // Hosting is done via createRoom(); this mirrors LanMeshSession.ensureLocalRoom.
        return this.getSnapshot();
    }

    leaveRoom(): void {
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
                status: this.roomId ? 'connected' : 'known',
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
                this.log('info', `已连接，peerId=${message.peerId}`);
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
                this.members.clear();
                this.members.set(this.self.id, { id: this.self.id, name: this.self.name });
                this.log('info', `已加入房间 ${message.room.title}`);
                this.dispatchSnapshot();
                return;
            case 'room-left':
                this.roomId = undefined;
                this.currentRoom = undefined;
                this.members.clear();
                this.log('info', '已离开房间');
                this.dispatchSnapshot();
                return;
            case 'member-join':
                if (message.member) {
                    this.members.set(message.member.id, message.member);
                }
                if (message.room) {
                    this.currentRoom = message.room;
                    this.roomId = message.room.roomId;
                }
                this.dispatchSnapshot();
                return;
            case 'member-leave':
                if (message.member) {
                    this.members.delete(message.member.id);
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
