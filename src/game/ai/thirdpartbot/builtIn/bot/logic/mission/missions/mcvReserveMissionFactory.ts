import { SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { MissionController } from "../missionController";
import type { StrategicFocusPlanner } from "../../../strategy/strategicFocusPlanner";
import { McvReserveMission } from "./mcvReserveMission";

export class McvReserveMissionFactory {
    private initialized = false;

    constructor(private focusPlanner: StrategicFocusPlanner) {}

    getName(): string {
        return "McvReserveMissionFactory";
    }

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        if (!context.botProfile?.fortifyBase) {
            return;
        }
        if (this.initialized) {
            return;
        }
        missionController.addMission(new McvReserveMission(logger, this.focusPlanner));
        this.initialized = true;
    }
}
