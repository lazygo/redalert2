import { LanMeshAppMessage, LanMeshSnapshot } from '@/network/lan/LanMeshSession';
import { LanPeerIdentity } from '@/network/lan/LanQrPayload';

/**
 * Minimal transport surface shared by LAN mesh (WebRTC) and netplay (WebSocket).
 */
export interface RoomTransport {
    getSelf(): LanPeerIdentity;
    getSnapshot(): LanMeshSnapshot;
    ensureLocalRoom(): LanMeshSnapshot;
    updateSelfName(name: string): void;
    broadcastAppMessage(payload: unknown, excludedPeerId?: string): void;
    sendAppMessage(peerId: string, payload: unknown): void;
    leaveRoom(): void;
    onSnapshotChange: {
        subscribe(listener: (snapshot: LanMeshSnapshot, source?: any) => void): void;
        unsubscribe(listener: (snapshot: LanMeshSnapshot, source?: any) => void): void;
    };
    onAppMessage: {
        subscribe(listener: (entry: LanMeshAppMessage, source?: any) => void): void;
        unsubscribe(listener: (entry: LanMeshAppMessage, source?: any) => void): void;
    };
}
