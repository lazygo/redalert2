import { MainMenuScreen } from '@/gui/screen/mainMenu/MainMenuScreen';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { jsx } from '@/gui/jsx/jsx';
import { NetPlaySetup } from '@/gui/screen/mainMenu/netplay/component/NetPlaySetup';
import { MusicType } from '@/engine/sound/Music';
import { LanMatchSession } from '@/network/lan/LanMatchSession';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { NetRoomSession } from '@/network/netplay/NetRoomSession';
import { WsRoomTransport } from '@/network/netplay/WsRoomTransport';
import { PregameController, PregameMapSelectionResult } from '@/gui/screen/mainMenu/lobby/PregameController';
import { MainMenuScreenType, ScreenType } from '@/gui/screen/ScreenType';
import { LobbyType } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { MapPreviewRenderer } from '@/gui/screen/mainMenu/lobby/MapPreviewRenderer';
import { MapFile } from '@/data/MapFile';
import { MainMenuRoute } from '@/gui/screen/mainMenu/MainMenuRoute';
import { StorageKey } from '@/LocalPrefs';
import { uint8ArrayToBase64String } from '@/util/string';
import { SlotType as NetSlotType } from '@/network/gameopt/SlotInfo';
import { OBS_COUNTRY_ID } from '@/game/gameopts/constants';

interface RootController {
    goToScreen(screenType: number, params?: any): void;
}

interface Rules {
    getMultiplayerCountries(): any[];
    getMultiplayerColors(): Map<number, any>;
    mpDialogSettings: any;
}

interface GameModes {
    getAll(): any[];
    getById(id: number): any;
}

interface MapList {
    getAll(): any[];
    getByName(name: string): any;
    addFromMapFile(file: any): void;
}

interface MapFileLoader {
    load(mapName: string): Promise<any>;
}

interface LocalPrefs {
    getItem(key: string): string | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

interface MessageBoxApi {
    show(message: string, buttonText?: string, onClose?: () => void): void;
}

interface MapDirectory {
    containsEntry(entryName: string): Promise<boolean>;
    writeFile(file: any): Promise<void>;
}

export class NetPlaySetupScreen extends MainMenuScreen {
    declare public title: string;
    declare public musicType: MusicType;

    private form?: any;
    private resetNonce = 0;
    private previewRequestId = 0;
    private pendingCreateTitle?: string;
    private roomsPollTimer?: ReturnType<typeof setInterval>;

    private readonly transport = new WsRoomTransport();
    private readonly chatHistory = new ChatHistory();
    private readonly roomSession: NetRoomSession;
    private pregameController: PregameController;
    private activeMatchSession?: LanMatchSession;

    constructor(
        private readonly rootController: RootController,
        private readonly strings: any,
        private readonly jsxRenderer: any,
        private readonly rules: Rules,
        private readonly mapFileLoader: MapFileLoader,
        private readonly mapList: MapList,
        private readonly gameModes: GameModes,
        private readonly localPrefs: LocalPrefs,
        private readonly messageBoxApi: MessageBoxApi,
        private readonly netplayWsUrl: string | undefined,
        private readonly mapDir?: MapDirectory
    ) {
        super();
        this.title = '';
        this.musicType = MusicType.Intro;
        const savedName = this.localPrefs.getItem(StorageKey.NetPlayPlayerName)?.trim()
            || this.localPrefs.getItem(StorageKey.LanPlayerName)?.trim();
        if (savedName) {
            this.transport.updateSelfName(savedName);
        }
        this.pregameController = this.createPregameController();
        this.roomSession = new NetRoomSession(
            this.transport,
            this.gameModes,
            this.mapFileLoader,
            this.mapDir,
            this.mapList
        );
    }

    onEnter(): void {
        this.controller.toggleMainVideo(false);
        this.initView();
        this.subscribeRoomEvents();
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        void this.refreshSidebarPreview();
        this.controller.showSidebarButtons();
        this.startRoomsPoll();
    }

    async onLeave(): Promise<void> {
        this.stopRoomsPoll();
        this.previewRequestId += 1;
        this.roomSession.onSnapshotChange.unsubscribe(this.handleRoomSnapshot);
        this.roomSession.onLaunch.unsubscribe(this.handleLaunch);
        this.transport.onRoomsChange.unsubscribe(this.handleRoomsChange);
        await this.controller.hideSidebarButtons();
        this.form = undefined;
    }

    async onStack(): Promise<void> {
        await this.onLeave();
    }

    onUnstack(params?: PregameMapSelectionResult): void {
        this.subscribeRoomEvents();
        if (params) {
            this.pregameController.applyMapSelection(params);
            this.pregameController.updateSelfName(this.transport.getSelf().name);
            if (this.pendingCreateTitle !== undefined) {
                void this.finishCreateRoomAfterMapSelect();
            } else if (this.roomSession.getSnapshot().isHost) {
                this.roomSession.applyHostPregameSnapshot(this.pregameController.getSnapshot());
                const snap = this.pregameController.getSnapshot();
                this.transport.updateRoomMeta({
                    mapName: snap.gameOpts.mapTitle || snap.gameOpts.mapName,
                    maxPlayers: snap.gameOpts.maxSlots,
                });
            }
        }
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        void this.refreshSidebarPreview();
        this.refreshView();
        this.controller.showSidebarButtons();
        this.startRoomsPoll();
    }

    private handleRoomSnapshot = () => {
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        void this.refreshSidebarPreview();
        this.refreshView();
    };

    private handleRoomsChange = () => {
        this.refreshView();
    };

    private handleLaunch = (descriptor: any) => {
        this.activeMatchSession?.dispose();
        this.activeMatchSession = new LanMatchSession(this.transport, descriptor);
        this.transport.markMatchStarted();
        const currentCustomMap = this.roomSession.getResolvedCustomMapFile();
        this.rootController.goToScreen(ScreenType.Game, {
            create: true,
            lanLaunch: descriptor,
            lanMatchSession: this.activeMatchSession,
            lanMapDataBase64: currentCustomMap ? uint8ArrayToBase64String(currentCustomMap.getBytes()) : undefined,
            returnTo: new MainMenuRoute(MainMenuScreenType.NetPlaySetup, {}),
        });
    };

    private subscribeRoomEvents(): void {
        this.roomSession.onSnapshotChange.unsubscribe(this.handleRoomSnapshot);
        this.roomSession.onLaunch.unsubscribe(this.handleLaunch);
        this.transport.onRoomsChange.unsubscribe(this.handleRoomsChange);
        this.roomSession.onSnapshotChange.subscribe(this.handleRoomSnapshot);
        this.roomSession.onLaunch.subscribe(this.handleLaunch);
        this.transport.onRoomsChange.subscribe(this.handleRoomsChange);
    }

    private createPregameController(): PregameController {
        return new PregameController(
            this.strings,
            this.rules,
            this.mapFileLoader,
            this.mapList,
            this.gameModes,
            this.localPrefs,
            this.transport.getSelf().name
        );
    }

    private initView(): void {
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            innerRef: (ref: any) => (this.form = ref),
            component: NetPlaySetup,
            props: this.buildComponentProps(),
        }));
        this.controller.setMainComponent(component);
    }

    private refreshView(): void {
        if (!this.form) {
            this.initView();
            return;
        }
        this.form.applyOptions((options: any) => {
            Object.assign(options, this.buildComponentProps());
        });
    }

    private buildComponentProps(): any {
        return {
            strings: this.strings,
            transport: this.transport,
            roomSession: this.roomSession,
            chatHistory: this.chatHistory,
            pregameController: this.pregameController,
            wsUrl: this.netplayWsUrl,
            resetNonce: this.resetNonce,
            onCommitName: (name: string) => this.persistPlayerName(name),
            onJoinRoom: async (roomId: string) => this.joinRoom(roomId),
            onHostPregameChanged: () => {
                this.roomSession.applyHostPregameSnapshot(this.pregameController.getSnapshot());
                const snap = this.pregameController.getSnapshot();
                this.transport.updateRoomMeta({
                    mapName: snap.gameOpts.mapTitle || snap.gameOpts.mapName,
                    maxPlayers: snap.gameOpts.maxSlots,
                });
                this.refreshSidebarMpText();
                void this.refreshSidebarPreview();
            },
            onStartGame: async () => this.startNetGame(),
            onLeaveRoom: async () => this.handleLeaveRoom(),
            onToggleReady: async () => {
                const selfMember = this.roomSession.getSnapshot().members.find((member) => member.isSelf);
                if (!selfMember) {
                    return;
                }
                await this.roomSession.setReady(!selfMember.ready);
            },
            onChangeMap: async () => this.handleChangeMap(),
        };
    }

    private async connect(): Promise<void> {
        if (!this.netplayWsUrl) {
            throw new Error(this.strings.get('GUI:NetPlayNoServer') || '未配置网络对战服务器');
        }
        await this.transport.connect(this.netplayWsUrl, this.transport.getSelf().name);
        this.refreshView();
        this.refreshSidebarButtons();
    }

    private async beginCreateRoom(title: string): Promise<void> {
        if (!this.transport.isConnected()) {
            await this.connect();
        }
        this.pendingCreateTitle = title;
        if (!this.pregameController.isInitialized()) {
            await this.pregameController.initialize();
        }
        this.pregameController.updateSelfName(this.transport.getSelf().name);
        await this.controller.pushScreen(MainMenuScreenType.MapSelection, {
            lobbyType: LobbyType.MultiplayerHost,
            gameOpts: this.pregameController.getGameOpts(),
            usedSlots: () => this.pregameController.getUsedSlots(),
        });
    }

    private async finishCreateRoomAfterMapSelect(): Promise<void> {
        const title = this.pendingCreateTitle || `${this.transport.getSelf().name}'s room`;
        this.pendingCreateTitle = undefined;
        const snapshot = this.createHostSnapshot();
        this.transport.createRoom({
            title,
            maxPlayers: snapshot.gameOpts.maxSlots,
            mapName: snapshot.gameOpts.mapTitle || snapshot.gameOpts.mapName,
            public: true,
        });
        // Wait briefly for room-joined then start hosting state.
        await this.waitUntilInRoom(5000);
        this.roomSession.startHosting(snapshot);
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        void this.refreshSidebarPreview();
        this.refreshView();
    }

    private async joinRoom(roomId: string): Promise<void> {
        if (!this.transport.isConnected()) {
            await this.connect();
        }
        if (!this.pregameController.isInitialized()) {
            await this.pregameController.initialize();
        }
        this.transport.joinRoom(roomId);
        await this.waitUntilInRoom(5000);
        this.refreshSidebarButtons();
        this.refreshView();
    }

    private waitUntilInRoom(timeoutMs: number): Promise<void> {
        if (this.transport.getSnapshot().isInRoom) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.transport.onSnapshotChange.unsubscribe(onSnap);
                reject(new Error(this.strings.get('GUI:NetPlayJoinTimeout') || '加入房间超时'));
            }, timeoutMs);
            const onSnap = () => {
                if (this.transport.getSnapshot().isInRoom) {
                    clearTimeout(timer);
                    this.transport.onSnapshotChange.unsubscribe(onSnap);
                    resolve();
                }
            };
            this.transport.onSnapshotChange.subscribe(onSnap);
        });
    }

    private async handleChangeMap(): Promise<void> {
        if (!this.roomSession.getSnapshot().isHost || !this.roomSession.getSnapshot().roomState) {
            return;
        }
        await this.controller.pushScreen(MainMenuScreenType.MapSelection, {
            lobbyType: LobbyType.MultiplayerHost,
            gameOpts: this.pregameController.getGameOpts(),
            usedSlots: () => this.pregameController.getUsedSlots(),
        });
    }

    private async handleLeaveRoom(): Promise<void> {
        this.roomSession.leaveRoom();
        this.transport.leaveRoom();
        this.chatHistory.reset();
        this.pregameController = this.createPregameController();
        this.resetNonce += 1;
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        this.controller.setSidebarPreview();
        this.refreshView();
    }

    private createHostSnapshot(): any {
        const snapshot = this.pregameController.getSnapshot();
        const visibleSlots = snapshot.gameOpts.humanPlayers[0]?.countryId === OBS_COUNTRY_ID
            ? snapshot.gameOpts.maxSlots + 1
            : snapshot.gameOpts.maxSlots;
        for (let slotIndex = 1; slotIndex < visibleSlots; slotIndex += 1) {
            if (snapshot.slotsInfo[slotIndex]?.type === NetSlotType.Player) {
                continue;
            }
            snapshot.slotsInfo[slotIndex] = { type: NetSlotType.Open };
            snapshot.gameOpts.aiPlayers[slotIndex] = undefined;
        }
        return snapshot;
    }

    private async startNetGame(): Promise<void> {
        try {
            this.roomSession.startGame({
                screenType: MainMenuScreenType.NetPlaySetup,
                params: {},
            });
        } catch (error) {
            this.messageBoxApi.show((error as Error).message);
        }
    }

    private refreshSidebarButtons(): void {
        const roomSnapshot = this.roomSession.getSnapshot();
        const buttons: any[] = [];

        if (!roomSnapshot.isRoomActive) {
            buttons.push({
                label: this.strings.get('GUI:NetPlayConnect') || '连接服务器',
                disabled: !this.netplayWsUrl || this.transport.isConnected(),
                onClick: () => {
                    void this.connect().catch((error) => this.messageBoxApi.show((error as Error).message));
                },
            });
            buttons.push({
                label: this.strings.get('GUI:NetPlayCreateRoom') || '创建房间',
                disabled: !this.netplayWsUrl || !this.transport.isConnected(),
                onClick: () => {
                    void this.beginCreateRoom(`${this.transport.getSelf().name}'s room`)
                        .catch((error) => this.messageBoxApi.show((error as Error).message));
                },
            });
            buttons.push({
                label: this.strings.get('GUI:NetPlayRefresh') || '刷新房间',
                disabled: !this.transport.isConnected(),
                onClick: () => this.transport.refreshRooms(),
            });
        } else {
            buttons.push({
                label: this.strings.get('GUI:NetPlayStart') || '开始游戏',
                disabled: !roomSnapshot.isHost || !roomSnapshot.canStart,
                onClick: () => {
                    void this.startNetGame();
                },
            });
            if (roomSnapshot.isHost) {
                buttons.push({
                    label: this.strings.get('GUI:NetPlayChangeMap') || '更换地图',
                    onClick: () => {
                        void this.handleChangeMap();
                    },
                });
            } else {
                const selfMember = roomSnapshot.members.find((member) => member.isSelf);
                buttons.push({
                    label: selfMember?.ready
                        ? (this.strings.get('GUI:NetPlayUnready') || '取消准备')
                        : (this.strings.get('GUI:NetPlayReady') || '准备'),
                    onClick: () => {
                        void this.roomSession.setReady(!selfMember?.ready);
                    },
                });
            }
            buttons.push({
                label: this.strings.get('GUI:NetPlayLeave') || '离开房间',
                isBottom: true,
                onClick: () => {
                    void this.handleLeaveRoom();
                },
            });
        }

        buttons.push({
            label: this.strings.get('GUI:Back') || '返回',
            isBottom: true,
            onClick: () => {
                void this.handleLeaveRoom();
                this.transport.disconnect();
                this.controller.goToScreen(MainMenuScreenType.Home);
            },
        });

        this.controller.setSidebarButtons(buttons, true);
    }

    private refreshSidebarMpText(): void {
        const roomSnapshot = this.roomSession.getSnapshot();
        if (roomSnapshot.roomState) {
            const gameOpts = roomSnapshot.roomState.gameOpts;
            this.controller.setSidebarMpContent({
                text: this.strings.get(this.gameModes.getById(gameOpts.gameMode).label) + '\n\n' + gameOpts.mapTitle,
                icon: gameOpts.mapOfficial ? 'gt18.pcx' : 'settings.png',
            });
            return;
        }
        this.controller.setSidebarMpContent({ text: '' });
    }

    private async refreshSidebarPreview(): Promise<void> {
        const roomSnapshot = this.roomSession.getSnapshot();
        const roomState = roomSnapshot.roomState;
        if (!roomState) {
            this.controller.toggleSidebarPreview(false);
            this.controller.setSidebarPreview();
            return;
        }
        const requestId = ++this.previewRequestId;
        try {
            let mapFile = this.roomSession.getResolvedCustomMapFile() ?? this.pregameController.getCurrentMapFile();
            if (!mapFile) {
                mapFile = await this.mapFileLoader.load(roomState.gameOpts.mapName);
            }
            if (requestId !== this.previewRequestId) {
                return;
            }
            const preview = new MapPreviewRenderer(this.strings).render(
                new MapFile(mapFile),
                roomSnapshot.isHost ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
                this.controller.getSidebarPreviewSize()
            );
            this.controller.toggleSidebarPreview(true);
            this.controller.setSidebarPreview(preview);
        } catch (error) {
            if (requestId !== this.previewRequestId) {
                return;
            }
            console.warn('[NetPlaySetupScreen] Failed to refresh sidebar preview', error);
            this.controller.setSidebarPreview();
        }
    }

    private persistPlayerName(name: string): void {
        const trimmed = name.trim();
        if (!trimmed) {
            this.localPrefs.removeItem(StorageKey.NetPlayPlayerName);
            return;
        }
        this.localPrefs.setItem(StorageKey.NetPlayPlayerName, trimmed.slice(0, 24));
    }

    private startRoomsPoll(): void {
        this.stopRoomsPoll();
        this.roomsPollTimer = setInterval(() => {
            if (this.transport.isConnected() && !this.roomSession.getSnapshot().isRoomActive) {
                this.transport.refreshRooms();
            }
        }, 5000);
    }

    private stopRoomsPoll(): void {
        if (this.roomsPollTimer) {
            clearInterval(this.roomsPollTimer);
            this.roomsPollTimer = undefined;
        }
    }
}
