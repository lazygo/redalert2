import { LanMeshAppMessage } from '@/network/lan/LanMeshSession';
import { LanHumanAssignment, LanLaunchDescriptor } from '@/network/lan/LanRoomSession';
import { EventDispatcher } from '@/util/event';
import { base64StringToUint8Array, uint8ArrayToBase64String } from '@/util/string';

interface LanMatchPeerIdentity {
    id: string;
    name: string;
}

interface LanMatchSnapshotMember {
    id: string;
    name?: string;
    isSelf: boolean;
    status: 'self' | 'known' | 'connected' | 'connecting' | 'disconnected';
}

interface LanMatchTransportSnapshot {
    members: LanMatchSnapshotMember[];
}

interface LanMatchTransportMessage {
    from: LanMatchPeerIdentity;
    payload: unknown;
    timestamp: number;
}

export interface LanMatchTransport {
    getSelf(): LanMatchPeerIdentity;
    getSnapshot(): LanMatchTransportSnapshot;
    broadcastAppMessage(payload: unknown, excludedPeerId?: string): void;
    leaveRoom?(): void;
    onSnapshotChange: {
        subscribe(listener: (snapshot: LanMatchTransportSnapshot, source: unknown) => void): void;
        unsubscribe(listener: (snapshot: LanMatchTransportSnapshot, source: unknown) => void): void;
    };
    onAppMessage: {
        subscribe(listener: (entry: LanMatchTransportMessage, source: unknown) => void): void;
        unsubscribe(listener: (entry: LanMatchTransportMessage, source: unknown) => void): void;
    };
}

interface LanGameTurnMessage {
    type: 'lan-game-turn';
    gameId: string;
    tick: number;
    fromPeerId: string;
    turnId: string;
    actionData: string;
    dropPeerIds: string[];
}

interface LanGameLoadProgressMessage {
    type: 'lan-game-load-progress';
    gameId: string;
    fromPeerId: string;
    loadPercent: number;
}

interface LanGameForceDropMessage {
    type: 'lan-game-force-drop';
    gameId: string;
    fromPeerId: string;
    targetPeerIds: string[];
}

interface LanGameTurnResyncMessage {
    type: 'lan-game-turn-resync';
    gameId: string;
    fromPeerId: string;
}

export interface LanMatchTurnBatch {
    tick: number;
    peerId: string;
    turnId: string;
    actionData: Uint8Array;
    dropPeerIds: string[];
    receivedAt: number;
}

export interface LanResolvedTurn {
    tick: number;
    controlPeerId: string;
    dropPeerIds: string[];
    batches: LanMatchTurnBatch[];
}

export interface LanMatchSnapshotState {
    gameId: string;
    localPeerId: string;
    controlPeerId: string;
    activePeerIds: string[];
    suspectedDropPeerIds: string[];
    waitingReconnectPeerIds: string[];
    /** 0–100 remaining grace for peers currently waiting to reconnect. */
    reconnectRemainPercentByPeerId: Record<string, number>;
    /**
     * Per-peer intrinsic response lag (ms): how late this peer's turn arrives
     * relative to the earliest turn for the same tick (EMA-smoothed).
     * Only peers still missing the stalled tick show a live climbing value —
     * others are not inflated when lockstep waits on someone else.
     */
    responseLagMsByPeerId: Record<string, number>;
    localReconnecting: boolean;
    bufferedTicks: number[];
    batchPeerIdsByTick: Record<number, string[]>;
    pendingLocalTicks: number[];
    allPeersLoaded: boolean;
    loadPercentByPeerId: Record<string, number>;
    transportMembers: LanMatchSnapshotMember[];
}

/** Wait this long for a disconnected peer to resume before DropPlayer. */
export const MATCH_RECONNECT_GRACE_MS = 45_000;
/** Start stall recovery (turn resync) after lockstep is stuck this long. */
export const TURN_STALL_WAIT_UI_MS = 600;
/** While stuck on missing turns, ask peers to resend at most this often. */
const TURN_STALL_RESYNC_INTERVAL_MS = 1_500;
/** Keep resolved local turns so a peer who fell behind can still catch up after resume. */
const RESOLVED_TURN_ARCHIVE_MAX = 240;
/** Smooth per-tick arrival lag so the diplo meter does not flicker every poll. */
const RESPONSE_LAG_EMA_ALPHA = 0.35;
/** Quantize displayed lag to reduce sub-frame jitter in the UI. */
const RESPONSE_LAG_DISPLAY_STEP_MS = 25;

function sortAssignments(assignments: LanHumanAssignment[]): LanHumanAssignment[] {
    return assignments
        .slice()
        .sort((left, right) => left.slotIndex - right.slotIndex || left.name.localeCompare(right.name, 'zh-Hans-CN'));
}

function cloneBatch(batch: LanMatchTurnBatch): LanMatchTurnBatch {
    return {
        tick: batch.tick,
        peerId: batch.peerId,
        turnId: batch.turnId,
        actionData: new Uint8Array(batch.actionData),
        dropPeerIds: [...batch.dropPeerIds],
        receivedAt: batch.receivedAt,
    };
}

function cloneLaunchDescriptor(descriptor: LanLaunchDescriptor): LanLaunchDescriptor {
    return {
        ...descriptor,
        humanAssignments: descriptor.humanAssignments.map((assignment) => ({ ...assignment })),
        mapTransferStateByPeerId: Object.fromEntries(
            Object.entries(descriptor.mapTransferStateByPeerId).map(([peerId, transferState]) => [peerId, { ...transferState }])
        ),
    };
}

function arePeerListsEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((peerId, index) => peerId === right[index]);
}

/** Per-tick console logging stalls lockstep on mobile/desktop; keep off unless debugging. */
const LAN_MATCH_DEBUG = false;

function logLanMatch(event: string, details: Record<string, unknown>): void {
    if (!LAN_MATCH_DEBUG) {
        return;
    }
    console.log(`[lan-match] ${event}`, details);
}

export class LanMatchSession {
    private readonly descriptor: LanLaunchDescriptor;
    private readonly orderedAssignments: LanHumanAssignment[];
    private readonly assignmentByPeerId = new Map<string, LanHumanAssignment>();
    private readonly activePeerIds = new Set<string>();
    private readonly suspectedDropPeerIds = new Set<string>();
    private readonly reconnectDeadlineByPeerId = new Map<string, number>();
    private localReconnectDeadline?: number;
    private stallTick?: number;
    private stallStartedAt?: number;
    private lastStallResyncAt = 0;
    private turnResyncTimers: ReturnType<typeof setTimeout>[] = [];
    private readonly turnBatchesByTick = new Map<number, Map<string, LanMatchTurnBatch>>();
    /** Local turns already consumed — still resent on resync if another peer is behind. */
    private readonly resolvedLocalTurnArchive = new Map<number, LanMatchTurnBatch>();
    private readonly localTurnIdByTick = new Map<number, string>();
    private readonly loadPercentByPeerId = new Map<string, number>();
    /** EMA of per-tick arrival lag vs the earliest peer for that tick. */
    private readonly responseLagEmaByPeerId = new Map<string, number>();
    private graceCheckTimer?: ReturnType<typeof setInterval>;

    private lastSnapshot: LanMatchTransportSnapshot;
    private localTurnCounter = 0;
    private disposed = false;
    private roomLeft = false;

    public readonly onSnapshotChange = new EventDispatcher<this, LanMatchSnapshotState>();
    public readonly onActionsReceived = new EventDispatcher<this, string>();
    public readonly onMatchResumeFailed = new EventDispatcher<this, void>();
    /** Local peer was force-dropped by the control peer / host. */
    public readonly onLocalForcedDrop = new EventDispatcher<this, void>();
    private localForcedDropNotified = false;

    constructor(
        private readonly transport: LanMatchTransport,
        descriptor: LanLaunchDescriptor
    ) {
        this.descriptor = cloneLaunchDescriptor(descriptor);
        this.orderedAssignments = sortAssignments(this.descriptor.humanAssignments);
        this.orderedAssignments.forEach((assignment) => {
            this.assignmentByPeerId.set(assignment.peerId, { ...assignment });
            this.activePeerIds.add(assignment.peerId);
            this.loadPercentByPeerId.set(assignment.peerId, 0);
            this.responseLagEmaByPeerId.set(assignment.peerId, 0);
        });
        this.lastSnapshot = this.transport.getSnapshot();
        this.handleSnapshotChange = this.handleSnapshotChange.bind(this);
        this.handleAppMessage = this.handleAppMessage.bind(this);
        this.transport.onSnapshotChange.subscribe(this.handleSnapshotChange);
        this.transport.onAppMessage.subscribe(this.handleAppMessage);
        this.graceCheckTimer = setInterval(() => this.evaluateReconnectGrace(), 1000);
        (this.transport as { setMatchReconnect?: (enabled: boolean) => void }).setMatchReconnect?.(true);
        const matchTransport = this.transport as {
            onConnectionStatusChange?: {
                subscribe(listener: (status: string) => void): void;
                unsubscribe(listener: (status: string) => void): void;
            };
            onMatchResumeFailed?: {
                subscribe(listener: () => void): void;
                unsubscribe(listener: () => void): void;
            };
        };
        this.connectionStatusDispatcher = matchTransport.onConnectionStatusChange;
        this.resumeFailedDispatcher = matchTransport.onMatchResumeFailed;
        this.connectionStatusDispatcher?.subscribe(this.handleTransportConnectionStatus);
        this.resumeFailedDispatcher?.subscribe(this.handleMatchResumeFailed);
        this.handleSnapshotChange(this.lastSnapshot, this.transport);
    }

    private connectionStatusDispatcher?: {
        subscribe(listener: (status: string) => void): void;
        unsubscribe(listener: (status: string) => void): void;
    };
    private resumeFailedDispatcher?: {
        subscribe(listener: () => void): void;
        unsubscribe(listener: () => void): void;
    };

    private handleTransportConnectionStatus = (status: string): void => {
        if (status === 'reconnecting' || status === 'disconnected') {
            if (!this.localReconnectDeadline) {
                this.localReconnectDeadline = Date.now() + MATCH_RECONNECT_GRACE_MS;
            }
        } else if (status === 'connected') {
            this.localReconnectDeadline = undefined;
            this.clearTurnStall();
            // Room membership / relay may settle a beat after welcome — resync twice.
            this.scheduleTurnResync(300);
            this.scheduleTurnResync(1200);
        }
        this.dispatchSnapshot();
    };

    private scheduleTurnResync(delayMs: number): void {
        const timer = setTimeout(() => {
            this.turnResyncTimers = this.turnResyncTimers.filter((entry) => entry !== timer);
            if (!this.disposed && !this.isLockstepFrozen()) {
                this.performTurnResync();
            }
        }, delayMs);
        this.turnResyncTimers.push(timer);
    }

    private handleMatchResumeFailed = (): void => {
        this.onMatchResumeFailed.dispatch(this);
    };

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.graceCheckTimer) {
            clearInterval(this.graceCheckTimer);
            this.graceCheckTimer = undefined;
        }
        this.turnResyncTimers.forEach((timer) => clearTimeout(timer));
        this.turnResyncTimers = [];
        this.connectionStatusDispatcher?.unsubscribe(this.handleTransportConnectionStatus);
        this.resumeFailedDispatcher?.unsubscribe(this.handleMatchResumeFailed);
        (this.transport as { setMatchReconnect?: (enabled: boolean) => void }).setMatchReconnect?.(false);
        this.transport.onSnapshotChange.unsubscribe(this.handleSnapshotChange);
        this.transport.onAppMessage.unsubscribe(this.handleAppMessage);
    }

    leaveRoom(): void {
        if (this.roomLeft) {
            return;
        }
        this.roomLeft = true;
        this.transport.leaveRoom?.();
    }

    getLaunchDescriptor(): LanLaunchDescriptor {
        return cloneLaunchDescriptor(this.descriptor);
    }

    getHumanAssignment(peerId: string): LanHumanAssignment | undefined {
        const assignment = this.assignmentByPeerId.get(peerId);
        return assignment ? { ...assignment } : undefined;
    }

    getSnapshot(): LanMatchSnapshotState {
        return this.createSnapshot();
    }

    reportLoadProgress(percent: number): void {
        const localPeerId = this.transport.getSelf().id;
        const nextPercent = Math.max(0, Math.min(100, Math.floor(percent)));
        const currentPercent = this.loadPercentByPeerId.get(localPeerId) ?? 0;
        if (nextPercent <= currentPercent) {
            return;
        }
        this.loadPercentByPeerId.set(localPeerId, nextPercent);
        this.transport.broadcastAppMessage({
            type: 'lan-game-load-progress',
            gameId: this.descriptor.gameId,
            fromPeerId: localPeerId,
            loadPercent: nextPercent,
        } satisfies LanGameLoadProgressMessage);
        this.dispatchSnapshot();
    }

    areAllPlayersLoaded(): boolean {
        return this.getOrderedActivePeerIds().every((peerId) => (this.loadPercentByPeerId.get(peerId) ?? 0) >= 100);
    }

    /**
     * Control peer can schedule DropPlayer for any other active peer (lag / AFK / reconnect).
     */
    forceDropPeers(peerIds: string[]): boolean {
        if (this.disposed || !peerIds.length) {
            return false;
        }
        const localPeerId = this.transport.getSelf().id;
        if (this.getControlPeerId() !== localPeerId) {
            return false;
        }
        const targets = [...new Set(peerIds)].filter(
            (peerId) => peerId !== localPeerId && this.activePeerIds.has(peerId)
        );
        if (!targets.length) {
            return false;
        }
        this.applyForceDrop(targets);
        try {
            this.transport.broadcastAppMessage({
                type: 'lan-game-force-drop',
                gameId: this.descriptor.gameId,
                fromPeerId: localPeerId,
                targetPeerIds: this.getSortedPeerIds(new Set(targets)),
            } satisfies LanGameForceDropMessage);
        } catch {
            // Local drop still applies; peers catch up when control turns refresh.
        }
        return true;
    }

    /** @deprecated Prefer forceDropPeers — kept for reconnect-wait kick UI. */
    forceDropWaitingPeers(peerIds: string[]): boolean {
        return this.forceDropPeers(peerIds);
    }

    isLocalControlPeer(): boolean {
        return this.getControlPeerId() === this.transport.getSelf().id;
    }

    /**
     * While the local socket is down, freeze lockstep so this client cannot consume
     * turns and run ahead of peers who never received our broadcasts.
     */
    isLockstepFrozen(): boolean {
        if (this.disposed) {
            return true;
        }
        const transport = this.transport as {
            getConnectionStatus?: () => string;
            isConnected?: () => boolean;
        };
        const status = transport.getConnectionStatus?.();
        if (status === 'reconnecting' || status === 'disconnected') {
            return true;
        }
        if (typeof transport.isConnected === 'function' && !transport.isConnected()) {
            return true;
        }
        return false;
    }

    submitLocalTurn(tick: number, actionData: Uint8Array): string {
        const existingTurnId = this.localTurnIdByTick.get(tick);
        if (existingTurnId) {
            return existingTurnId;
        }

        const localPeerId = this.transport.getSelf().id;
        const turnId = `${localPeerId}:${tick}:${++this.localTurnCounter}`;
        const dropPeerIds = this.getControlPeerId() === localPeerId
            ? this.getSortedPeerIds(this.suspectedDropPeerIds)
            : [];
        const batch: LanMatchTurnBatch = {
            tick,
            peerId: localPeerId,
            turnId,
            actionData: new Uint8Array(actionData),
            dropPeerIds,
            receivedAt: Date.now(),
        };

        this.localTurnIdByTick.set(tick, turnId);
        this.storeBatch(batch);
        logLanMatch('submit-local-turn', {
            localPeerId,
            tick,
            turnId,
            controlPeerId: this.getControlPeerId(),
            dropPeerIds,
            activePeerIds: this.getOrderedActivePeerIds(),
        });
        this.broadcastLocalTurn(batch);

        return turnId;
    }

    private broadcastLocalTurn(batch: LanMatchTurnBatch): void {
        try {
            this.transport.broadcastAppMessage({
                type: 'lan-game-turn',
                gameId: this.descriptor.gameId,
                tick: batch.tick,
                fromPeerId: batch.peerId,
                turnId: batch.turnId,
                actionData: uint8ArrayToBase64String(batch.actionData),
                dropPeerIds: batch.dropPeerIds,
            } satisfies LanGameTurnMessage);
        } catch {
            // Connection may be down during match reconnect grace; resend on resume.
        }
    }

    private resendPendingLocalTurns(): void {
        const localPeerId = this.transport.getSelf().id;
        if (!localPeerId) {
            return;
        }
        const pendingTicks: number[] = [];
        this.localTurnIdByTick.forEach((turnId, tick) => {
            const batch = this.turnBatchesByTick.get(tick)?.get(localPeerId);
            if (batch && batch.turnId === turnId) {
                this.broadcastLocalTurn(batch);
                pendingTicks.push(tick);
            }
        });
        // Also rebroadcast recently resolved local turns so a peer who froze behind can catch up.
        const archivedTicks: number[] = [];
        this.resolvedLocalTurnArchive.forEach((batch, tick) => {
            if (this.localTurnIdByTick.has(tick)) {
                return;
            }
            this.broadcastLocalTurn(batch);
            archivedTicks.push(tick);
        });
        logLanMatch('resend-pending-local-turns', {
            localPeerId,
            pendingTicks: pendingTicks.sort((a, b) => a - b),
            archivedTicks: archivedTicks.sort((a, b) => a - b),
        });
    }

    tryConsumeTurn(tick: number): LanResolvedTurn | undefined {
        if (this.isLockstepFrozen()) {
            return undefined;
        }
        const tickBatches = this.turnBatchesByTick.get(tick);
        if (!tickBatches) {
            this.noteTurnStall(tick);
            return undefined;
        }

        const controlPeerId = this.getControlPeerId();
        const controlBatch = tickBatches.get(controlPeerId);
        if (!controlBatch) {
            this.noteTurnStall(tick);
            return undefined;
        }

        const dropPeerIds = controlBatch.dropPeerIds.filter((peerId) => this.activePeerIds.has(peerId));
        const expectedPeerIds = this.getOrderedActivePeerIds().filter((peerId) => !dropPeerIds.includes(peerId));
        if (expectedPeerIds.some((peerId) => !tickBatches.has(peerId))) {
            this.noteTurnStall(tick);
            return undefined;
        }

        this.clearTurnStall();

        const resolvedBatches = expectedPeerIds
            .map((peerId) => tickBatches.get(peerId))
            .filter((batch): batch is LanMatchTurnBatch => Boolean(batch))
            .map(cloneBatch);

        const localBatch = tickBatches.get(this.transport.getSelf().id);
        if (localBatch) {
            this.archiveResolvedLocalTurn(localBatch);
        }

        this.turnBatchesByTick.delete(tick);
        this.commitDrops(dropPeerIds);
        logLanMatch('resolve-turn', {
            localPeerId: this.transport.getSelf().id,
            tick,
            controlPeerId,
            dropPeerIds,
            peerIds: resolvedBatches.map((batch) => batch.peerId),
        });

        const localTurnId = this.localTurnIdByTick.get(tick);
        if (localTurnId) {
            this.localTurnIdByTick.delete(tick);
            this.onActionsReceived.dispatch(this, localTurnId);
        }

        this.dispatchSnapshot();
        return {
            tick,
            controlPeerId,
            dropPeerIds: [...dropPeerIds],
            batches: resolvedBatches,
        };
    }

    private archiveResolvedLocalTurn(batch: LanMatchTurnBatch): void {
        this.resolvedLocalTurnArchive.set(batch.tick, cloneBatch(batch));
        if (this.resolvedLocalTurnArchive.size <= RESOLVED_TURN_ARCHIVE_MAX) {
            return;
        }
        const oldestTick = Math.min(...this.resolvedLocalTurnArchive.keys());
        this.resolvedLocalTurnArchive.delete(oldestTick);
    }

    /**
     * Lockstep is blocked waiting for peer turns.
     * - Still-connected peers: throttle turn resync (packet loss / post-resume race).
     * - Truly disconnected peers: open reconnect grace + wait UI.
     * Never put online peers into drop-grace — that showed the wait page with no recovery.
     */
    noteTurnStall(tick: number): void {
        if (this.disposed) {
            return;
        }
        const missingPeerIds = this.getMissingPeerIdsForTick(tick);
        if (!missingPeerIds.length) {
            this.clearTurnStall();
            return;
        }
        const now = Date.now();
        if (this.stallTick !== tick) {
            this.stallTick = tick;
            this.stallStartedAt = now;
            this.lastStallResyncAt = 0;
        }
        const stalledFor = now - (this.stallStartedAt ?? now);
        if (stalledFor < TURN_STALL_WAIT_UI_MS) {
            return;
        }

        if (now - this.lastStallResyncAt >= TURN_STALL_RESYNC_INTERVAL_MS) {
            this.lastStallResyncAt = now;
            this.performTurnResync();
        }

        const memberById = new Map(this.lastSnapshot.members.map((member) => [member.id, member]));
        const connectedPeerIds = new Set(
            this.lastSnapshot.members
                .filter((member) => member.isSelf || member.status === 'connected' || member.status === 'self')
                .map((member) => member.id)
        );

        let startedGrace = false;
        missingPeerIds.forEach((peerId) => {
            if (this.suspectedDropPeerIds.has(peerId) || this.reconnectDeadlineByPeerId.has(peerId)) {
                return;
            }
            // Online peers are recovered via resync above — do not fake a disconnect wait.
            if (connectedPeerIds.has(peerId)) {
                return;
            }
            const member = memberById.get(peerId);
            if (member?.status === 'disconnected' || !member) {
                this.reconnectDeadlineByPeerId.set(peerId, now + MATCH_RECONNECT_GRACE_MS);
                startedGrace = true;
            }
        });
        if (startedGrace) {
            this.dispatchSnapshot();
        }
    }

    private clearTurnStall(): void {
        this.stallTick = undefined;
        this.stallStartedAt = undefined;
        this.lastStallResyncAt = 0;
    }

    private getMissingPeerIdsForTick(tick: number): string[] {
        const tickBatches = this.turnBatchesByTick.get(tick);
        const expectedPeerIds = this.getOrderedActivePeerIds().filter(
            (peerId) => !this.suspectedDropPeerIds.has(peerId)
        );
        if (!tickBatches) {
            return expectedPeerIds;
        }
        const controlPeerId = this.getControlPeerId();
        if (!tickBatches.has(controlPeerId)) {
            return expectedPeerIds.filter((peerId) => !tickBatches.has(peerId));
        }
        const dropPeerIds = new Set(
            (tickBatches.get(controlPeerId)?.dropPeerIds ?? []).filter((peerId) => this.activePeerIds.has(peerId))
        );
        return expectedPeerIds.filter((peerId) => !dropPeerIds.has(peerId) && !tickBatches.has(peerId));
    }

    private handleSnapshotChange(snapshot: LanMatchTransportSnapshot, _source: unknown): void {
        this.lastSnapshot = snapshot;
        const memberById = new Map(snapshot.members.map((member) => [member.id, member]));
        const connectedPeerIds = new Set(
            snapshot.members
                .filter((member) => member.isSelf || member.status === 'connected' || member.status === 'self')
                .map((member) => member.id)
        );

        const now = Date.now();
        const reconnectedPeerIds: string[] = [];
        this.getOrderedActivePeerIds().forEach((peerId) => {
            if (connectedPeerIds.has(peerId)) {
                // Peer is back online — clear grace wait and ask everyone to resend buffered turns.
                if (this.reconnectDeadlineByPeerId.has(peerId)) {
                    reconnectedPeerIds.push(peerId);
                }
                this.reconnectDeadlineByPeerId.delete(peerId);
                this.suspectedDropPeerIds.delete(peerId);
                return;
            }
            if (this.suspectedDropPeerIds.has(peerId)) {
                return;
            }
            const member = memberById.get(peerId);
            // Explicit temporary disconnect keeps a grace window; missing members are final.
            if (member?.status === 'disconnected') {
                if (!this.reconnectDeadlineByPeerId.has(peerId)) {
                    this.reconnectDeadlineByPeerId.set(peerId, now + MATCH_RECONNECT_GRACE_MS);
                }
                return;
            }
            this.suspectedDropPeerIds.add(peerId);
            this.reconnectDeadlineByPeerId.delete(peerId);
        });

        this.evaluateReconnectGrace();
        this.refreshLocalControlTurns();
        if (reconnectedPeerIds.length) {
            // Staying peers must rebroadcast turns the returnee missed while offline.
            this.clearTurnStall();
            this.performTurnResync();
            this.scheduleTurnResync(800);
        }
        this.dispatchSnapshot();
    }

    private evaluateReconnectGrace(): void {
        if (this.disposed) {
            return;
        }
        const now = Date.now();
        let changed = false;
        this.reconnectDeadlineByPeerId.forEach((deadline, peerId) => {
            if (now < deadline || this.suspectedDropPeerIds.has(peerId)) {
                return;
            }
            this.suspectedDropPeerIds.add(peerId);
            this.reconnectDeadlineByPeerId.delete(peerId);
            changed = true;
        });
        if (this.localReconnectDeadline && now >= this.localReconnectDeadline) {
            // Local grace exhausted while still down — keep trying WS reconnect, but UI bar is at 0.
            this.localReconnectDeadline = now;
        }
        if (changed) {
            this.refreshLocalControlTurns();
        }
        // Keep UI progress bars ticking every second while anyone is in grace.
        if (changed || this.reconnectDeadlineByPeerId.size > 0 || this.isLocalReconnecting()) {
            this.dispatchSnapshot();
        }
    }

    private performTurnResync(): void {
        this.resendPendingLocalTurns();
        const localPeerId = this.transport.getSelf().id;
        if (!localPeerId) {
            return;
        }
        try {
            this.transport.broadcastAppMessage({
                type: 'lan-game-turn-resync',
                gameId: this.descriptor.gameId,
                fromPeerId: localPeerId,
            } satisfies LanGameTurnResyncMessage);
        } catch {
            // ignore while socket is still settling
        }
    }

    private isLocalReconnecting(): boolean {
        return (this.transport as { getConnectionStatus?: () => string }).getConnectionStatus?.() === 'reconnecting';
    }

    private getReconnectRemainPercent(peerId: string, now: number): number {
        const deadline = this.reconnectDeadlineByPeerId.get(peerId);
        if (deadline === undefined) {
            return 100;
        }
        return Math.max(0, Math.min(100, Math.round(((deadline - now) / MATCH_RECONNECT_GRACE_MS) * 100)));
    }

    private handleAppMessage(entry: LanMeshAppMessage, _source: unknown): void {
        const payload = entry.payload;
        if (!payload || typeof payload !== 'object') {
            return;
        }

        const message = payload as
            | LanGameTurnMessage
            | LanGameLoadProgressMessage
            | LanGameForceDropMessage
            | LanGameTurnResyncMessage;
        if (message.gameId !== this.descriptor.gameId) {
            return;
        }
        if (message.fromPeerId !== entry.from.id || !this.assignmentByPeerId.has(message.fromPeerId)) {
            return;
        }

        if (message.type === 'lan-game-turn-resync') {
            this.resendPendingLocalTurns();
            return;
        }

        if (message.type === 'lan-game-force-drop') {
            // Only the lockstep control peer may force-end reconnect wait.
            if (message.fromPeerId !== this.getControlPeerId()) {
                return;
            }
            const localPeerId = this.transport.getSelf().id;
            const targets = (message.targetPeerIds ?? []).filter((peerId) => this.activePeerIds.has(peerId));
            if (targets.includes(localPeerId)) {
                this.notifyLocalForcedDrop();
            }
            const others = targets.filter((peerId) => peerId !== localPeerId);
            if (others.length) {
                this.applyForceDrop(others);
            }
            return;
        }

        if (message.type === 'lan-game-load-progress') {
            const currentPercent = this.loadPercentByPeerId.get(message.fromPeerId) ?? 0;
            if (message.loadPercent > currentPercent) {
                this.loadPercentByPeerId.set(message.fromPeerId, Math.min(100, Math.floor(message.loadPercent)));
                this.dispatchSnapshot();
            }
            return;
        }

        if (message.type !== 'lan-game-turn') {
            return;
        }

        this.storeBatch({
            tick: message.tick,
            peerId: message.fromPeerId,
            turnId: message.turnId,
            actionData: base64StringToUint8Array(message.actionData),
            dropPeerIds: this.getSortedPeerIds(new Set((message.dropPeerIds ?? []).filter((peerId) => this.activePeerIds.has(peerId)))),
            receivedAt: entry.timestamp,
        });
        logLanMatch('receive-turn', {
            localPeerId: this.transport.getSelf().id,
            fromPeerId: message.fromPeerId,
            tick: message.tick,
            turnId: message.turnId,
            dropPeerIds: message.dropPeerIds ?? [],
        });
    }

    private storeBatch(batch: LanMatchTurnBatch): void {
        if (!this.activePeerIds.has(batch.peerId)) {
            return;
        }

        let tickBatches = this.turnBatchesByTick.get(batch.tick);
        if (!tickBatches) {
            tickBatches = new Map<string, LanMatchTurnBatch>();
            this.turnBatchesByTick.set(batch.tick, tickBatches);
        }
        const existingBatch = tickBatches.get(batch.peerId);
        if (existingBatch) {
            if (existingBatch.turnId === batch.turnId &&
                !arePeerListsEqual(existingBatch.dropPeerIds, batch.dropPeerIds)) {
                tickBatches.set(batch.peerId, cloneBatch(batch));
                this.dispatchSnapshot();
            }
            return;
        }

        tickBatches.set(batch.peerId, cloneBatch(batch));
        this.recordResponseLagSample(batch.peerId, tickBatches);
        this.suspectedDropPeerIds.delete(batch.peerId);
        this.reconnectDeadlineByPeerId.delete(batch.peerId);
        this.dispatchSnapshot();
    }

    /**
     * Sample = how late this peer arrived after the earliest turn for the same tick.
     * Fast peers stay near 0 even while a slow peer is still missing that tick.
     */
    private recordResponseLagSample(peerId: string, tickBatches: Map<string, LanMatchTurnBatch>): void {
        const batch = tickBatches.get(peerId);
        if (!batch) {
            return;
        }
        let firstReceivedAt = batch.receivedAt;
        tickBatches.forEach((entry) => {
            if (entry.receivedAt < firstReceivedAt) {
                firstReceivedAt = entry.receivedAt;
            }
        });
        const sampleMs = Math.max(0, batch.receivedAt - firstReceivedAt);
        const previous = this.responseLagEmaByPeerId.get(peerId) ?? sampleMs;
        this.responseLagEmaByPeerId.set(
            peerId,
            previous + RESPONSE_LAG_EMA_ALPHA * (sampleMs - previous)
        );
    }

    private getTickFirstReceivedAt(tick: number): number | undefined {
        const tickBatches = this.turnBatchesByTick.get(tick);
        if (!tickBatches?.size) {
            return undefined;
        }
        let firstReceivedAt: number | undefined;
        tickBatches.forEach((batch) => {
            if (firstReceivedAt === undefined || batch.receivedAt < firstReceivedAt) {
                firstReceivedAt = batch.receivedAt;
            }
        });
        return firstReceivedAt;
    }

    private formatResponseLagMs(lagMs: number): number {
        const capped = Math.min(10_000, Math.max(0, lagMs));
        return Math.round(capped / RESPONSE_LAG_DISPLAY_STEP_MS) * RESPONSE_LAG_DISPLAY_STEP_MS;
    }

    private applyForceDrop(peerIds: string[]): void {
        let changed = false;
        peerIds.forEach((peerId) => {
            if (!this.activePeerIds.has(peerId)) {
                return;
            }
            if (!this.suspectedDropPeerIds.has(peerId)) {
                this.suspectedDropPeerIds.add(peerId);
                changed = true;
            }
            if (this.reconnectDeadlineByPeerId.delete(peerId)) {
                changed = true;
            }
        });
        if (!changed) {
            return;
        }
        this.refreshLocalControlTurns();
        this.dispatchSnapshot();
    }

    private refreshLocalControlTurns(): void {
        const localPeerId = this.transport.getSelf().id;
        if (this.getControlPeerId() !== localPeerId) {
            return;
        }

        const nextDropPeerIds = this.getSortedPeerIds(this.suspectedDropPeerIds);
        this.localTurnIdByTick.forEach((turnId, tick) => {
            const tickBatches = this.turnBatchesByTick.get(tick);
            const localBatch = tickBatches?.get(localPeerId);
            if (!tickBatches || !localBatch || arePeerListsEqual(localBatch.dropPeerIds, nextDropPeerIds)) {
                return;
            }

            const updatedBatch: LanMatchTurnBatch = {
                ...localBatch,
                dropPeerIds: [...nextDropPeerIds],
            };
            tickBatches.set(localPeerId, updatedBatch);
            logLanMatch('refresh-control-turn', {
                localPeerId,
                tick,
                turnId,
                dropPeerIds: updatedBatch.dropPeerIds,
            });
            this.broadcastLocalTurn(updatedBatch);
        });
    }

    private commitDrops(dropPeerIds: string[]): void {
        if (!dropPeerIds.length) {
            return;
        }

        const localPeerId = this.transport.getSelf().id;
        const localDropped = dropPeerIds.includes(localPeerId);

        dropPeerIds.forEach((peerId) => {
            this.activePeerIds.delete(peerId);
            this.suspectedDropPeerIds.delete(peerId);
            this.reconnectDeadlineByPeerId.delete(peerId);
        });

        Array.from(this.turnBatchesByTick.entries()).forEach(([tick, tickBatches]) => {
            dropPeerIds.forEach((peerId) => tickBatches.delete(peerId));
            if (!tickBatches.size) {
                this.turnBatchesByTick.delete(tick);
            }
        });

        if (localDropped) {
            this.notifyLocalForcedDrop();
        }
    }

    private notifyLocalForcedDrop(): void {
        if (this.disposed || this.localForcedDropNotified) {
            return;
        }
        this.localForcedDropNotified = true;
        this.onLocalForcedDrop.dispatch(this);
    }

    private getControlPeerId(): string {
        const orderedActivePeerIds = this.getOrderedActivePeerIds();
        const availableControlPeers = orderedActivePeerIds.filter((peerId) => !this.suspectedDropPeerIds.has(peerId));
        return availableControlPeers[0] ?? orderedActivePeerIds[0] ?? this.transport.getSelf().id;
    }

    private getOrderedActivePeerIds(): string[] {
        return this.orderedAssignments
            .map((assignment) => assignment.peerId)
            .filter((peerId) => this.activePeerIds.has(peerId));
    }

    private getSortedPeerIds(peerIds: Set<string>): string[] {
        const orderedPeerIds = this.getOrderedActivePeerIds();
        return orderedPeerIds.filter((peerId) => peerIds.has(peerId));
    }

    private createSnapshot(): LanMatchSnapshotState {
        const batchPeerIdsByTick = Object.fromEntries(
            Array.from(this.turnBatchesByTick.entries())
                .sort(([left], [right]) => left - right)
                .map(([tick, tickBatches]) => [
                    tick,
                    Array.from(tickBatches.keys()).sort((left, right) => {
                        const orderedPeerIds = this.getOrderedActivePeerIds();
                        return orderedPeerIds.indexOf(left) - orderedPeerIds.indexOf(right);
                    }),
                ])
        );
        const orderedActivePeerIds = this.getOrderedActivePeerIds();
        const now = Date.now();
        const waitingIds = new Set(this.reconnectDeadlineByPeerId.keys());
        const localReconnecting = this.isLocalReconnecting();
        const reconnectRemainPercentByPeerId: Record<string, number> = {};
        const responseLagMsByPeerId: Record<string, number> = {};
        const missingForStall = this.stallTick !== undefined
            ? new Set(this.getMissingPeerIdsForTick(this.stallTick))
            : new Set<string>();
        const stallFirstReceivedAt = this.stallTick !== undefined
            ? this.getTickFirstReceivedAt(this.stallTick)
            : undefined;
        const stallWaitAnchor = stallFirstReceivedAt
            ?? this.stallStartedAt
            ?? now;
        this.orderedAssignments.forEach((assignment) => {
            if (waitingIds.has(assignment.peerId)) {
                reconnectRemainPercentByPeerId[assignment.peerId] = this.getReconnectRemainPercent(assignment.peerId, now);
            } else if (localReconnecting && assignment.peerId === this.transport.getSelf().id && this.localReconnectDeadline) {
                reconnectRemainPercentByPeerId[assignment.peerId] = Math.max(
                    0,
                    Math.min(100, Math.round(((this.localReconnectDeadline - now) / MATCH_RECONNECT_GRACE_MS) * 100))
                );
            } else {
                reconnectRemainPercentByPeerId[assignment.peerId] = 100;
            }

            // Baseline: smoothed intrinsic lag (stable while others block lockstep).
            let lagMs = this.responseLagEmaByPeerId.get(assignment.peerId) ?? 0;
            if (waitingIds.has(assignment.peerId) || this.suspectedDropPeerIds.has(assignment.peerId)) {
                // Dropped / reconnecting: show live wait, do not smear onto healthy peers.
                lagMs = Math.max(lagMs, now - stallWaitAnchor, 1000);
            } else if (missingForStall.has(assignment.peerId)) {
                // Only the peer(s) holding the current tick climb in real time.
                lagMs = Math.max(lagMs, now - stallWaitAnchor);
            }
            responseLagMsByPeerId[assignment.peerId] = this.formatResponseLagMs(lagMs);
        });
        return {
            gameId: this.descriptor.gameId,
            localPeerId: this.transport.getSelf().id,
            controlPeerId: this.getControlPeerId(),
            activePeerIds: orderedActivePeerIds,
            suspectedDropPeerIds: this.getSortedPeerIds(this.suspectedDropPeerIds),
            waitingReconnectPeerIds: this.getSortedPeerIds(waitingIds),
            reconnectRemainPercentByPeerId,
            responseLagMsByPeerId,
            localReconnecting,
            bufferedTicks: Array.from(this.turnBatchesByTick.keys()).sort((left, right) => left - right),
            batchPeerIdsByTick,
            pendingLocalTicks: Array.from(this.localTurnIdByTick.keys()).sort((left, right) => left - right),
            allPeersLoaded: orderedActivePeerIds.every((peerId) => (this.loadPercentByPeerId.get(peerId) ?? 0) >= 100),
            loadPercentByPeerId: Object.fromEntries(
                this.orderedAssignments.map((assignment) => [assignment.peerId, this.loadPercentByPeerId.get(assignment.peerId) ?? 0])
            ),
            transportMembers: this.lastSnapshot.members.map((member) => ({ ...member })),
        };
    }

    private dispatchSnapshot(): void {
        this.onSnapshotChange.dispatch(this, this.createSnapshot());
    }
}
