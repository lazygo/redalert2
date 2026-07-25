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
    private readonly turnBatchesByTick = new Map<number, Map<string, LanMatchTurnBatch>>();
    private readonly localTurnIdByTick = new Map<number, string>();
    private readonly loadPercentByPeerId = new Map<string, number>();
    private graceCheckTimer?: ReturnType<typeof setInterval>;

    private lastSnapshot: LanMatchTransportSnapshot;
    private localTurnCounter = 0;
    private disposed = false;
    private roomLeft = false;

    public readonly onSnapshotChange = new EventDispatcher<this, LanMatchSnapshotState>();
    public readonly onActionsReceived = new EventDispatcher<this, string>();
    public readonly onMatchResumeFailed = new EventDispatcher<this, void>();

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
        if (status === 'connected') {
            this.resendPendingLocalTurns();
        }
        this.dispatchSnapshot();
    };

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
        this.localTurnIdByTick.forEach((turnId, tick) => {
            const batch = this.turnBatchesByTick.get(tick)?.get(localPeerId);
            if (batch && batch.turnId === turnId) {
                this.broadcastLocalTurn(batch);
            }
        });
    }

    tryConsumeTurn(tick: number): LanResolvedTurn | undefined {
        const tickBatches = this.turnBatchesByTick.get(tick);
        if (!tickBatches) {
            return undefined;
        }

        const controlPeerId = this.getControlPeerId();
        const controlBatch = tickBatches.get(controlPeerId);
        if (!controlBatch) {
            return undefined;
        }

        const dropPeerIds = controlBatch.dropPeerIds.filter((peerId) => this.activePeerIds.has(peerId));
        const expectedPeerIds = this.getOrderedActivePeerIds().filter((peerId) => !dropPeerIds.includes(peerId));
        if (expectedPeerIds.some((peerId) => !tickBatches.has(peerId))) {
            return undefined;
        }

        const resolvedBatches = expectedPeerIds
            .map((peerId) => tickBatches.get(peerId))
            .filter((batch): batch is LanMatchTurnBatch => Boolean(batch))
            .map(cloneBatch);

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

    private handleSnapshotChange(snapshot: LanMatchTransportSnapshot, _source: unknown): void {
        this.lastSnapshot = snapshot;
        const memberById = new Map(snapshot.members.map((member) => [member.id, member]));
        const connectedPeerIds = new Set(
            snapshot.members
                .filter((member) => member.isSelf || member.status === 'connected' || member.status === 'self')
                .map((member) => member.id)
        );

        const now = Date.now();
        this.getOrderedActivePeerIds().forEach((peerId) => {
            if (connectedPeerIds.has(peerId)) {
                this.reconnectDeadlineByPeerId.delete(peerId);
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
        if (changed) {
            this.refreshLocalControlTurns();
            this.dispatchSnapshot();
        }
    }

    private handleAppMessage(entry: LanMeshAppMessage, _source: unknown): void {
        const payload = entry.payload;
        if (!payload || typeof payload !== 'object') {
            return;
        }

        const message = payload as LanGameTurnMessage | LanGameLoadProgressMessage;
        if (message.gameId !== this.descriptor.gameId) {
            return;
        }
        if (message.fromPeerId !== entry.from.id || !this.assignmentByPeerId.has(message.fromPeerId)) {
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
        this.suspectedDropPeerIds.delete(batch.peerId);
        this.reconnectDeadlineByPeerId.delete(batch.peerId);
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
        return {
            gameId: this.descriptor.gameId,
            localPeerId: this.transport.getSelf().id,
            controlPeerId: this.getControlPeerId(),
            activePeerIds: orderedActivePeerIds,
            suspectedDropPeerIds: this.getSortedPeerIds(this.suspectedDropPeerIds),
            waitingReconnectPeerIds: this.getSortedPeerIds(new Set(this.reconnectDeadlineByPeerId.keys())),
            localReconnecting:
                (this.transport as { getConnectionStatus?: () => string }).getConnectionStatus?.() === 'reconnecting',
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
