export interface NetPlayPeerInfo {
    id: string;
    name: string;
}

export interface NetPlayRoomInfo {
    roomId: string;
    title: string;
    hostName: string;
    hostPeerId: string;
    playerCount: number;
    maxPlayers: number;
    mapName?: string;
    status: 'open' | 'started';
    public: boolean;
}

export type NetPlayClientMessage =
    | { type: 'hello'; nickname: string }
    | { type: 'list-rooms' }
    | { type: 'create-room'; title: string; maxPlayers?: number; mapName?: string; public?: boolean }
    | { type: 'join-room'; roomId: string }
    | { type: 'leave-room' }
    | { type: 'update-room'; title?: string; maxPlayers?: number; mapName?: string; public?: boolean }
    | { type: 'room-broadcast'; payload: unknown }
    | { type: 'room-send'; toPeerId: string; payload: unknown }
    | { type: 'start-match' }
    | { type: 'ping' };

export type NetPlayServerMessage =
    | { type: 'welcome'; peerId: string; member?: NetPlayPeerInfo }
    | { type: 'room-list'; rooms: NetPlayRoomInfo[] }
    | { type: 'room-joined'; room: NetPlayRoomInfo }
    | { type: 'room-left'; roomId?: string; reason?: string }
    | { type: 'member-join'; member: NetPlayPeerInfo; room?: NetPlayRoomInfo }
    | { type: 'member-leave'; member: NetPlayPeerInfo; reason?: string; room?: NetPlayRoomInfo }
    | { type: 'relay'; from: NetPlayPeerInfo; payload: unknown; roomId?: string }
    | { type: 'error'; code?: string; message?: string }
    | { type: 'pong' };
