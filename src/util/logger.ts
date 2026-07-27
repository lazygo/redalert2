import Logger from 'js-logger';

Logger.useDefaults();
// Hide high-frequency debug spam in production (move pathing, missing art, etc.).
// Call enableDebugLogging() from app bootstrap when Config.devMode is on.
Logger.setLevel(Logger.INFO);

export const AppLogger = Logger;

export function enableDebugLogging(enabled: boolean): void {
    Logger.setLevel(enabled ? Logger.DEBUG : Logger.INFO);
}

export default AppLogger;
