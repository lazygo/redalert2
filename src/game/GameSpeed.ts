export class GameSpeed {
    static BASE_TICKS_PER_SECOND = 15;
    /**
     * With lockstep lookahead, netplay can run near single-player speeds.
     * Kept as an escape hatch if a host still wants to cap lobby speed.
     */
    static NETPLAY_MAX_SPEED = 6;
    static NETPLAY_DEFAULT_SPEED = 5;
    static computeGameSpeed(speed: number): number {
        let ticksPerSecond: number;
        if (speed === 6) {
            ticksPerSecond = 60;
        }
        else if (speed === 5) {
            ticksPerSecond = 45;
        }
        else {
            ticksPerSecond = 60 / (6 - speed);
        }
        return ticksPerSecond / GameSpeed.BASE_TICKS_PER_SECOND;
    }
    static clampNetplaySpeed(speed: number): number {
        if (!Number.isFinite(speed)) {
            return GameSpeed.NETPLAY_DEFAULT_SPEED;
        }
        return Math.max(0, Math.min(GameSpeed.NETPLAY_MAX_SPEED, Math.floor(speed)));
    }
}
