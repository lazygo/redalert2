import { jsx } from '@/gui/jsx/jsx';
import { OBS_COUNTRY_ID, NO_TEAM_ID } from '@/game/gameopts/constants';
import { PlayerConnectionStatus } from '@/network/gamestate/PlayerConnectionStatus';
import { LanMatchSession } from '@/network/lan/LanMatchSession';
import { CompositeDisposable } from '@/util/disposable/CompositeDisposable';
import { LoadingScreenWrapper } from './LoadingScreenWrapper';
import { LoadingScreenApi } from './LoadingScreenApi';

interface Player {
    name: string;
    countryId: number;
    colorId: number;
    teamId: number;
}

interface Country {
    name: string;
    side: any;
    uiName: string;
}

interface Rules {
    getMultiplayerColors(): Map<number, any>;
    getMultiplayerCountries(): Country[];
    colors: Map<string, any>;
}

interface Strings {
    get(key: string, ...args: any[]): string;
}

interface UiScene {
    menuViewport: any;
    add(object: any): void;
    remove(object: any): void;
}

interface JsxRenderer {
    render(element: any): any[];
}

interface GameResConfig {
    isCdn(): boolean;
    getCdnBaseUrl(): string;
}

interface ExtendedPlayerInfo {
    name: string;
    status: any;
    loadPercent: number;
    country: Country;
    color: string;
    team: number;
    showKick?: boolean;
}

/**
 * Same classic LoadingScreen as game start. After initial load, beginNetworkWait()
 * recreates that page while peers reconnect (progress bars + optional kick).
 */
export class LanLoadingScreenApi implements LoadingScreenApi {
    private lastLoadPercent = 0;
    private disposables = new CompositeDisposable();
    private screenDisposables = new CompositeDisposable();
    private players?: Player[];
    private localPlayerName?: string;
    private mapName?: string;
    private loadingScreen?: any;
    /** True while mid-match reconnect page is showing (not a LoadingScreen prop). */
    private reconnectWaitActive = false;
    private initialLoadDone = false;

    private handleLanMatchUpdate = () => {
        if (!this.players || !this.localPlayerName || !this.mapName) {
            return;
        }
        if (this.initialLoadDone && !this.reconnectWaitActive) {
            return;
        }
        if (this.reconnectWaitActive) {
            const snapshot = this.lanMatchSession.getSnapshot();
            const shouldShow = snapshot.localReconnecting || snapshot.waitingReconnectPeerIds.length > 0;
            if (!shouldShow) {
                this.hideNetworkWait();
                return;
            }
        }
        if (this.loadingScreen) {
            this.loadingScreen.applyOptions((options: any) => {
                options.playerInfos = this.createExtendedLoadingInfos();
                options.onKickPlayer = this.reconnectWaitActive ? this.handleKickPlayer : undefined;
            });
            return;
        }
        this.createLoadingScreen();
    };

    private handleKickPlayer = (playerName: string) => {
        if (!this.reconnectWaitActive) {
            return;
        }
        const descriptor = this.lanMatchSession.getLaunchDescriptor();
        const assignment = descriptor.humanAssignments.find((entry) => entry.name === playerName);
        if (!assignment) {
            return;
        }
        this.lanMatchSession.forceDropWaitingPeers([assignment.peerId]);
    };

    constructor(
        private readonly lanMatchSession: LanMatchSession,
        private readonly rules: Rules,
        private readonly strings: Strings,
        private readonly uiScene: UiScene,
        private readonly jsxRenderer: JsxRenderer,
        private readonly gameResConfig: GameResConfig
    ) { }

    async start(players: Player[], mapName: string, localPlayerName: string): Promise<void> {
        this.players = players;
        this.localPlayerName = localPlayerName;
        this.mapName = mapName;
        this.initialLoadDone = false;
        this.reconnectWaitActive = false;
        this.lanMatchSession.onSnapshotChange.subscribe(this.handleLanMatchUpdate);
        this.disposables.add(() => this.lanMatchSession.onSnapshotChange.unsubscribe(this.handleLanMatchUpdate));
        this.handleLanMatchUpdate();
    }

    onLoadProgress(percent: number): void {
        const roundedPercent = Math.floor(percent);
        if (roundedPercent <= this.lastLoadPercent) {
            return;
        }
        this.lastLoadPercent = roundedPercent;
        this.lanMatchSession.reportLoadProgress(roundedPercent);
        this.handleLanMatchUpdate();
    }

    /** Hide the initial loading page but keep this API alive for mid-match reconnect. */
    endLoading(): void {
        this.initialLoadDone = true;
        this.reconnectWaitActive = false;
        this.destroyScreen();
    }

    /** Recreate the classic start loading page while a peer reconnects. */
    beginNetworkWait(): void {
        if (!this.players || !this.localPlayerName || !this.mapName) {
            return;
        }
        this.reconnectWaitActive = true;
        this.handleLanMatchUpdate();
    }

    hideNetworkWait(): void {
        // Do not destroy the initial load page while waiting for slower peers.
        if (!this.reconnectWaitActive) {
            return;
        }
        this.reconnectWaitActive = false;
        this.destroyScreen();
    }

    private createExtendedLoadingInfos(): ExtendedPlayerInfo[] {
        const colors = [...this.rules.getMultiplayerColors().values()];
        const countries = this.rules.getMultiplayerCountries();
        const lanSnapshot = this.lanMatchSession.getSnapshot();
        const descriptor = this.lanMatchSession.getLaunchDescriptor();
        const assignmentByName = new Map(descriptor.humanAssignments.map((assignment) => [assignment.name, assignment.peerId] as [string, string]));
        const transportByPeerId = new Map(lanSnapshot.transportMembers.map((member) => [member.id, member]));
        const waitingIds = new Set(lanSnapshot.waitingReconnectPeerIds);
        const canKick = this.reconnectWaitActive
            && !lanSnapshot.localReconnecting
            && this.lanMatchSession.isLocalControlPeer();
        const hasTeams = this.players?.every((player) => player.countryId === OBS_COUNTRY_ID || player.teamId !== NO_TEAM_ID);
        const extendedInfos = (this.players ?? []).map((player) => {
            const peerId = assignmentByName.get(player.name);
            const transportMember = peerId ? transportByPeerId.get(peerId) : undefined;
            let status: PlayerConnectionStatus;
            let loadPercent: number;
            if (this.reconnectWaitActive) {
                const waiting = peerId ? waitingIds.has(peerId) : false;
                const selfReconnecting = lanSnapshot.localReconnecting && transportMember?.isSelf;
                if (waiting || selfReconnecting) {
                    status = PlayerConnectionStatus.Disconnected;
                    loadPercent = peerId
                        ? (lanSnapshot.reconnectRemainPercentByPeerId?.[peerId] ?? 0)
                        : 0;
                } else {
                    status = PlayerConnectionStatus.Connected;
                    loadPercent = 100;
                }
            } else {
                status = !transportMember
                    ? PlayerConnectionStatus.Disconnected
                    : transportMember.isSelf || transportMember.status === 'connected'
                        ? PlayerConnectionStatus.Connected
                        : PlayerConnectionStatus.Lagging;
                loadPercent = peerId ? lanSnapshot.loadPercentByPeerId[peerId] ?? 0 : 0;
            }
            const showKick = Boolean(
                canKick
                && peerId
                && !transportMember?.isSelf
                && status === PlayerConnectionStatus.Disconnected
                && waitingIds.has(peerId)
            );
            return {
                name: player.name,
                status,
                loadPercent,
                country: countries[player.countryId],
                color: player.countryId === OBS_COUNTRY_ID
                    ? '#fff'
                    : colors[player.colorId].asHexString(),
                team: player.teamId,
                showKick,
            };
        });

        if (hasTeams) {
            return extendedInfos.sort((a, b) => {
                if (Boolean(a.country) === Boolean(b.country)) {
                    return a.team - b.team;
                }
                return Number(b.country !== undefined) - Number(a.country !== undefined);
            });
        }
        return extendedInfos;
    }

    private createLoadingScreen(): void {
        this.destroyScreen();
        const [uiObject] = this.jsxRenderer.render(jsx(LoadingScreenWrapper, {
            ref: (ref: any) => (this.loadingScreen = ref),
            strings: this.strings,
            rules: this.rules,
            viewport: this.uiScene.menuViewport,
            playerName: this.localPlayerName,
            mapName: this.mapName!,
            playerInfos: this.createExtendedLoadingInfos(),
            gameResConfig: this.gameResConfig,
            onKickPlayer: this.reconnectWaitActive ? this.handleKickPlayer : undefined,
        }));
        this.uiScene.add(uiObject);
        this.screenDisposables.add(uiObject, () => this.uiScene.remove(uiObject), () => (this.loadingScreen = undefined));
    }

    private destroyScreen(): void {
        this.screenDisposables.dispose();
        this.screenDisposables = new CompositeDisposable();
        this.loadingScreen = undefined;
    }

    dispose(): void {
        this.destroyScreen();
        this.disposables.dispose();
        this.players = undefined;
        this.localPlayerName = undefined;
        this.mapName = undefined;
        this.reconnectWaitActive = false;
        this.initialLoadDone = false;
    }

    updateViewport(): void {
        this.loadingScreen?.updateViewport(this.uiScene.menuViewport);
    }
}
