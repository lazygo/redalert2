import React, { useEffect, useMemo, useState } from 'react';
import { LobbyForm } from '@/gui/screen/mainMenu/lobby/component/LobbyForm';
import { LobbyType } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { PregameController } from '@/gui/screen/mainMenu/lobby/PregameController';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { List, ListItem } from '@/gui/component/List';
import { NetRoomSession } from '@/network/netplay/NetRoomSession';
import { WsRoomTransport } from '@/network/netplay/WsRoomTransport';
import { NetPlayRoomInfo } from '@/network/netplay/NetPlayProtocol';
import { LanRoomSnapshot } from '@/network/lan/LanRoomSession';

export interface NetPlaySetupProps {
    strings: any;
    transport: WsRoomTransport;
    roomSession: NetRoomSession;
    chatHistory: ChatHistory;
    pregameController: PregameController;
    wsUrl?: string;
    resetNonce: number;
    onCommitName: (name: string) => void;
    onJoinRoom: (roomId: string) => Promise<void>;
    onHostPregameChanged: () => void;
    onStartGame: () => Promise<void>;
    onLeaveRoom: () => Promise<void>;
    onToggleReady: () => Promise<void>;
    onChangeMap: () => Promise<void>;
}

export const NetPlaySetup: React.FC<NetPlaySetupProps> = ({
    strings,
    transport,
    roomSession,
    chatHistory,
    pregameController,
    wsUrl,
    resetNonce,
    onCommitName,
    onJoinRoom,
    onHostPregameChanged,
    onStartGame,
    onLeaveRoom,
    onToggleReady,
    onChangeMap,
}) => {
    const [nameInput, setNameInput] = useState(transport.getSelf().name);
    const [connected, setConnected] = useState(transport.isConnected());
    const [rooms, setRooms] = useState<NetPlayRoomInfo[]>(transport.getRooms());
    const [roomSnapshot, setRoomSnapshot] = useState<LanRoomSnapshot>(roomSession.getSnapshot());
    const [busy, setBusy] = useState(false);
    const [statusText, setStatusText] = useState<string>('');

    useEffect(() => {
        const onConn = (value: boolean) => setConnected(value);
        const onRooms = (next: NetPlayRoomInfo[]) => setRooms(next);
        const onRoomSnap = (snap: LanRoomSnapshot) => setRoomSnapshot(snap);
        const onLog = (entry: { level: string; text: string }) => {
            setStatusText(entry.text);
        };
        transport.onConnectionChange.subscribe(onConn);
        transport.onRoomsChange.subscribe(onRooms);
        roomSession.onSnapshotChange.subscribe(onRoomSnap);
        transport.onLog.subscribe(onLog);
        setConnected(transport.isConnected());
        setRooms(transport.getRooms());
        setRoomSnapshot(roomSession.getSnapshot());
        setNameInput(transport.getSelf().name);
        return () => {
            transport.onConnectionChange.unsubscribe(onConn);
            transport.onRoomsChange.unsubscribe(onRooms);
            roomSession.onSnapshotChange.unsubscribe(onRoomSnap);
            transport.onLog.unsubscribe(onLog);
        };
    }, [transport, roomSession, resetNonce]);

    const commitName = () => {
        const trimmed = nameInput.trim() || 'Player';
        setNameInput(trimmed);
        transport.updateSelfName(trimmed);
        onCommitName(trimmed);
        if (roomSnapshot.isHost && roomSnapshot.roomState) {
            pregameController.updateSelfName(trimmed);
            onHostPregameChanged();
        }
    };

    const formProps = useMemo(() => {
        if (!roomSnapshot.isRoomActive || !roomSnapshot.roomState) {
            return undefined;
        }
        if (roomSnapshot.roomState) {
            pregameController.hydrate({
                gameOpts: roomSnapshot.roomState.gameOpts,
                slotsInfo: roomSnapshot.roomState.slotsInfo,
                currentMapFile: roomSession.getResolvedCustomMapFile(),
            });
        }
        const selfAssignment = roomSnapshot.roomState.humanAssignments.find(
            (assignment) => assignment.peerId === roomSnapshot.self.id
        );
        const baseProps = pregameController.createLobbyFormProps({
            lobbyType: roomSnapshot.isHost ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
            activeSlotIndex: selfAssignment?.slotIndex ?? 0,
            localUsername: roomSnapshot.self.name,
            chatHistory: chatHistory as any,
            onStateChange: roomSnapshot.isHost ? onHostPregameChanged : undefined,
        });
        if (!roomSnapshot.isHost && selfAssignment) {
            const requestOwnSlotConfig = (updater: (slot: any) => {
                countryId: number;
                colorId: number;
                startPos: number;
                teamId: number;
            }) => {
                const slot = baseProps.playerSlots[selfAssignment.slotIndex];
                const next = updater(slot);
                void roomSession.requestSlotConfig(selfAssignment.slotIndex, next);
            };
            baseProps.onCountrySelect = (country: string) => {
                requestOwnSlotConfig((slot) => ({
                    countryId: pregameController.getCountryIdByName(country),
                    colorId: pregameController.getColorIdByName(slot.color),
                    startPos: slot.startPos,
                    teamId: slot.team,
                }));
            };
            baseProps.onColorSelect = (color: string) => {
                requestOwnSlotConfig((slot) => ({
                    countryId: pregameController.getCountryIdByName(slot.country),
                    colorId: pregameController.getColorIdByName(color),
                    startPos: slot.startPos,
                    teamId: slot.team,
                }));
            };
            baseProps.onStartPosSelect = (startPos: number) => {
                requestOwnSlotConfig((slot) => ({
                    countryId: pregameController.getCountryIdByName(slot.country),
                    colorId: pregameController.getColorIdByName(slot.color),
                    startPos,
                    teamId: slot.team,
                }));
            };
            baseProps.onTeamSelect = (teamId: number) => {
                requestOwnSlotConfig((slot) => ({
                    countryId: pregameController.getCountryIdByName(slot.country),
                    colorId: pregameController.getColorIdByName(slot.color),
                    startPos: slot.startPos,
                    teamId,
                }));
            };
        }
        return baseProps;
    }, [roomSnapshot, pregameController, chatHistory, onHostPregameChanged, roomSession]);

    const waitingMode = roomSnapshot.isRoomActive || roomSnapshot.mesh.isInRoom;

    return (
        <div
            className="lobby-form lan-setup-form lan-room-form"
            data-lan-view={waitingMode ? 'waiting' : 'entry'}
            data-netplay="true"
        >
            <div className="lan-setup-notice">
                {wsUrl
                    ? (connected
                        ? (strings.get('GUI:NetPlayConnected') || `已连接：${wsUrl}`)
                        : (strings.get('GUI:NetPlayDisconnected') || `未连接：${wsUrl}`))
                    : (strings.get('GUI:NetPlayNoServer') || '未配置网络对战服务器（config.ini → netplayWsUrl）')}
                {statusText ? ` · ${statusText}` : ''}
            </div>

            {!waitingMode ? (
                <div className="lan-entry-layout">
                    <div className="lan-panel lan-entry-panel lan-entry-profile-panel">
                        <div className="lan-panel-header">
                            <h3>{strings.get('GUI:NetPlayProfile') || '玩家与连接'}</h3>
                            <span>{strings.get('GUI:NetPlayProfileHint') || '输入昵称后，用右侧菜单连接中继、创建房间或刷新列表。'}</span>
                        </div>
                        <label className="lan-input-label" htmlFor="netplay-name">
                            {strings.get('GUI:NetPlayPlayerName') || '玩家名称'}
                        </label>
                        <input
                            id="netplay-name"
                            type="text"
                            className="lan-text-input"
                            maxLength={24}
                            value={nameInput}
                            onChange={(e) => setNameInput(e.target.value)}
                            onBlur={commitName}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    commitName();
                                }
                            }}
                        />
                        <div className="lan-entry-field-hint">
                            房间成员列表、聊天和开局后的玩家槽位都会使用这个名字。
                        </div>
                    </div>

                    <div className="lan-panel lan-entry-panel">
                        <div className="lan-panel-header">
                            <h3>{strings.get('GUI:NetPlayRoomList') || '公开房间'}</h3>
                            <span>
                                {connected
                                    ? (strings.get('GUI:NetPlayRoomCount') || `${rooms.length} 个房间`)
                                    : (strings.get('GUI:NetPlayConnectFirst') || '请先连接服务器')}
                            </span>
                        </div>
                        {rooms.length ? (
                            <List className="lan-entry-recent-list">
                                {rooms.map((room) => (
                                    <ListItem className="lan-entry-recent-item" key={room.roomId}>
                                        <div className="lan-entry-recent-item-top">
                                            <strong>{room.title}</strong>
                                            <span>
                                                {room.playerCount}/{room.maxPlayers}
                                            </span>
                                        </div>
                                        <div className="lan-entry-recent-item-meta">
                                            <span>{room.hostName}</span>
                                            <span>{room.mapName || (strings.get('GUI:NetPlayNoMapYet') || '未选地图')}</span>
                                            <span>{room.roomId}</span>
                                        </div>
                                        <div className="lan-actions" style={{ marginTop: 8 }}>
                                            <button
                                                type="button"
                                                className="dialog-button"
                                                disabled={busy || !connected || room.playerCount >= room.maxPlayers}
                                                onClick={() => {
                                                    void (async () => {
                                                        setBusy(true);
                                                        try {
                                                            commitName();
                                                            await onJoinRoom(room.roomId);
                                                        } catch (error) {
                                                            setStatusText((error as Error).message);
                                                        } finally {
                                                            setBusy(false);
                                                        }
                                                    })();
                                                }}
                                            >
                                                {strings.get('GUI:NetPlayJoin') || '加入'}
                                            </button>
                                        </div>
                                    </ListItem>
                                ))}
                            </List>
                        ) : (
                            <div className="lan-entry-empty-state">
                                {strings.get('GUI:NetPlayNoRooms') || '暂无公开房间，可以自己创建一个。'}
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="lan-waiting-main">
                    <div className="lan-panel" style={{ marginBottom: 12 }}>
                        <div className="lan-panel-header">
                            <h3>{roomSnapshot.roomState?.gameOpts.mapTitle || (strings.get('GUI:NetPlayLobby') || '房间大厅')}</h3>
                            <span>
                                {roomSnapshot.isHost
                                    ? (strings.get('GUI:NetPlayYouAreHost') || '你是房主')
                                    : (strings.get('GUI:NetPlayYouAreGuest') || '你是访客')}
                                {' · '}
                                {roomSnapshot.members.map((m) => m.name).join(', ')}
                            </span>
                        </div>
                        <div className="lan-actions">
                            {roomSnapshot.isHost ? (
                                <>
                                    <button type="button" className="dialog-button" onClick={() => void onChangeMap()}>
                                        {strings.get('GUI:NetPlayChangeMap') || '更换地图'}
                                    </button>
                                    <button
                                        type="button"
                                        className="dialog-button"
                                        disabled={!roomSnapshot.canStart}
                                        onClick={() => void onStartGame()}
                                    >
                                        {strings.get('GUI:NetPlayStart') || '开始游戏'}
                                    </button>
                                </>
                            ) : (
                                <button type="button" className="dialog-button" onClick={() => void onToggleReady()}>
                                    {roomSnapshot.members.find((m) => m.isSelf)?.ready
                                        ? (strings.get('GUI:NetPlayUnready') || '取消准备')
                                        : (strings.get('GUI:NetPlayReady') || '准备')}
                                </button>
                            )}
                            <button type="button" className="dialog-button" onClick={() => void onLeaveRoom()}>
                                {strings.get('GUI:NetPlayLeave') || '离开房间'}
                            </button>
                        </div>
                    </div>
                    {formProps ? (
                        <div className="lan-room-form-shell lan-room-form-shell-compact">
                            <LobbyForm {...formProps} />
                        </div>
                    ) : (
                        <div className="lan-panel lan-room-loading-panel">
                            {strings.get('GUI:NetPlayWaitingConfig') || '正在同步房间配置...'}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
