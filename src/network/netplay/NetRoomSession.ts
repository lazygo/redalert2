import { LanRoomSession } from '@/network/lan/LanRoomSession';
import { WsRoomTransport } from '@/network/netplay/WsRoomTransport';

interface GameModes {
    getById(id: number): { id: number; mpDialogSettings: any };
}

interface MapFileLoader {
    load(mapName: string): Promise<any>;
}

interface MapDirectory {
    containsEntry(entryName: string): Promise<boolean>;
    writeFile(file: any): Promise<void>;
}

interface MapList {
    addFromMapFile(file: any): void;
}

/**
 * Netplay room session = LanRoomSession over WebSocket transport (no WebRTC).
 */
export class NetRoomSession extends LanRoomSession {
    constructor(
        transport: WsRoomTransport,
        gameModes: GameModes,
        mapFileLoader: MapFileLoader,
        mapDir?: MapDirectory,
        mapList?: MapList
    ) {
        super(transport, gameModes, mapFileLoader, mapDir, mapList, 'netplay');
    }
}
