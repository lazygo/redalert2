import React from 'react';
import { AllianceStatus } from '@/game/Alliances';
import { OBS_COUNTRY_NAME, aiUiNames } from '@/game/gameopts/constants';
import { CountryIcon } from '@/gui/component/CountryIcon';
import { Chat } from '@/gui/component/Chat';
import { Image } from '@/gui/component/Image';
import { RECIPIENT_ALL, RECIPIENT_TEAM } from '@/network/gservConfig';
import { PingIndicator } from '@/gui/component/PingIndicator';
interface Color {
    asHexString(): string;
}
interface Country {
    name: string;
}
interface Player {
    name: string;
    color: Color;
    country?: Country;
    isAi: boolean;
    isObserver?: boolean;
    defeated: boolean;
    aiDifficulty?: string;
    getUnitsKilled(): number;
    isCombatant(): boolean;
}
interface Alliance {
    status: AllianceStatus;
    players: {
        first: Player;
        second: Player;
    };
}
interface PlayerInfo {
    player: Player;
    alliance?: Alliance;
    allianceToggleable: boolean;
    muted: boolean;
}
interface ConInfo {
    name: string;
    status: string;
    ping?: number;
    responseMs?: number;
}
interface GameMode {
    label: string;
}
interface GameModes {
    getById(id: string): GameMode;
}
interface GameOptions {
    gameMode: string;
    shortGame: boolean;
    cratesAppear: boolean;
    superWeapons: boolean;
    destroyableBridges: boolean;
    multiEngineer: boolean;
    noDogEngiKills: boolean;
}
interface Strings {
    get(key: string, ...args: any[]): string;
}
interface ChatHistory {
    lastComposeTarget?: {
        value: {
            type: any;
            name: string;
        };
    };
}
interface DiploFormProps {
    strings: Strings;
    playerInfos: PlayerInfo[];
    localPlayer?: Player;
    taunts?: boolean;
    singlePlayer: boolean;
    alliancesAllowed: boolean;
    gameModes: GameModes;
    gameOpts: GameOptions;
    mapName: string;
    messages?: any[];
    chatHistory?: ChatHistory;
    conInfos?: ConInfo[];
    canKickPlayers?: boolean;
    hostPlayerName?: string;
    onToggleTaunts: (enabled: boolean) => void;
    onToggleAlliance: (player: Player, enabled: boolean) => void;
    onToggleChat: (player: Player, enabled: boolean) => void;
    onSendMessage: (message: string) => void;
    onCancelMessage: () => void;
    onKickPlayer?: (player: Player) => void;
}
const PlayerConnectionStatus = {
    Connected: 'Connected',
    Disconnected: 'Disconnected',
    Lagging: 'Lagging'
};
const RESPONSE_METER_MAX_MS = 1000;
function getResponseMs(conInfo?: ConInfo): number | undefined {
    if (!conInfo) {
        return undefined;
    }
    if (conInfo.responseMs !== undefined) {
        return conInfo.responseMs;
    }
    if (conInfo.status === PlayerConnectionStatus.Disconnected) {
        return RESPONSE_METER_MAX_MS;
    }
    return conInfo.ping;
}
function ResponseCell({ ms, strings }: { ms?: number; strings: Strings }) {
    if (ms === undefined) {
        return null;
    }
    const capped = Math.min(RESPONSE_METER_MAX_MS, Math.max(0, ms));
    const ratio = capped / RESPONSE_METER_MAX_MS;
    const label = ms >= RESPONSE_METER_MAX_MS ? `${RESPONSE_METER_MAX_MS}+ms` : `${Math.round(ms)}ms`;
    const level = capped <= 150 ? 'good' : capped <= 500 ? 'warn' : 'bad';
    return (
        <div
            className={`player-response-cell player-response-${level}`}
            title={strings.get("Msg:PingInfo", Math.round(ms))}
        >
            <div className="player-response-bar" style={{ width: `${Math.max(6, ratio * 100)}%` }}/>
            <span className="player-response-ms">{label}</span>
        </div>
    );
}
function renderPingCell(
    strings: Strings,
    showResponse: boolean,
    conInfo: ConInfo | undefined,
    allowResponse: boolean
) {
    if (showResponse) {
        return allowResponse ? <ResponseCell ms={getResponseMs(conInfo)} strings={strings}/> : null;
    }
    const ping = conInfo?.status === PlayerConnectionStatus.Connected
        || conInfo?.status === PlayerConnectionStatus.Lagging
        ? conInfo.ping
        : undefined;
    return ping !== undefined ? <PingIndicator ping={ping} strings={strings}/> : null;
}
export const DiploForm: React.FC<DiploFormProps> = ({
    strings,
    playerInfos,
    localPlayer,
    taunts,
    singlePlayer,
    alliancesAllowed,
    gameModes,
    gameOpts,
    mapName,
    messages,
    chatHistory,
    conInfos,
    canKickPlayers,
    hostPlayerName,
    onToggleTaunts,
    onToggleAlliance,
    onToggleChat,
    onSendMessage,
    onCancelMessage,
    onKickPlayer,
}) => {
    const gameTypeLabel = strings.get(gameModes.getById(gameOpts.gameMode).label);
    const formatBoolean = (value: boolean): string => value ? strings.get("TXT_ON") : strings.get("TXT_OFF");
    const showResponse = !singlePlayer && conInfos !== undefined;
    const showKick = Boolean(canKickPlayers && onKickPlayer);
    const kickLabel = strings.get("GUI:NetPlayKick") || "Kick";
    const hostTooltip = strings.get("GUI:NetPlayHostTag") || strings.get("STT:HostPictureAcceptance");
    const renderCountryCell = (player: Player) => (
        <td className="player-country">
            <div className="player-country-cell">
                <span className="player-host-status" data-r-tooltip={hostPlayerName === player.name ? hostTooltip : undefined} title={hostPlayerName === player.name ? hostTooltip : undefined}>
                    {hostPlayerName === player.name ? <Image src="wolhost.pcx"/> : null}
                </span>
                <CountryIcon country={player.country ? player.country.name : OBS_COUNTRY_NAME}/>
            </div>
        </td>
    );
    const localConInfo = conInfos?.find((info) => info.name === localPlayer?.name);
    return (<div className="diplo-form">
      <div className="players">
        <table>
          <thead>
            <tr>
              <th className="player-country"></th>
              <th className="player-name">{strings.get("GUI:Player")}</th>
              <th>{strings.get("GUI:Allies")}</th>
              {!singlePlayer && <th>{strings.get("GUI:Chat")}</th>}
              <th>{strings.get("GUI:Kills")}</th>
              {showResponse && <th className="player-ping">{strings.get("GUI:NetPlayResponse")}</th>}
              {showKick && <th className="player-kick">{strings.get("GUI:NetPlayKick")}</th>}
            </tr>
          </thead>
          <tbody>
            {localPlayer && (<tr style={{
                color: localPlayer.defeated
                    ? "grey"
                    : localPlayer.color.asHexString(),
            }}>
                {renderCountryCell(localPlayer)}
                <td className="player-name">{localPlayer.name}</td>
                <td></td>
                {!singlePlayer && <td></td>}
                <td>
                  {!localPlayer.isObserver || localPlayer.defeated
                ? localPlayer.getUnitsKilled()
                : undefined}
                </td>
                {showResponse && (
                  <td className="player-ping">
                    {renderPingCell(strings, showResponse, localConInfo, true)}
                  </td>
                )}
                {showKick && <td className="player-kick"></td>}
              </tr>)}
            {playerInfos.map((playerInfo, index) => {
            const conInfo = conInfos?.find((info) => info.name === playerInfo.player.name);
            const canKickThis = showKick
                && !playerInfo.player.isAi
                && playerInfo.player.name !== localPlayer?.name;
            return (<tr key={index} style={{
                    color: playerInfo.player.defeated
                        ? "grey"
                        : playerInfo.player.color.asHexString(),
                    opacity: conInfo && conInfo.status === PlayerConnectionStatus.Disconnected ? 0.55 : 1,
                }}>
                  {renderCountryCell(playerInfo.player)}
                  <td className="player-name">
                    {playerInfo.player.isAi
                    ? strings.get(aiUiNames.get(playerInfo.player.aiDifficulty as any) || '')
                    : playerInfo.player.name}
                  </td>
                  <td>
                    {(!localPlayer?.isObserver || localPlayer.defeated) && (<input type="checkbox" name="alliance" className={playerInfo.alliance?.status === AllianceStatus.Requested
                        ? playerInfo.alliance.players.first === localPlayer
                            ? "semi-checked-left"
                            : "semi-checked-right"
                        : undefined} disabled={!alliancesAllowed ||
                        !playerInfo.allianceToggleable ||
                        !playerInfo.player.isCombatant()} checked={playerInfo.alliance?.status === AllianceStatus.Formed} onChange={() => onToggleAlliance(playerInfo.player, !(playerInfo.alliance?.status === AllianceStatus.Formed ||
                        (playerInfo.alliance?.status === AllianceStatus.Requested &&
                            playerInfo.alliance.players.first === localPlayer)))}/>)}
                  </td>
                  {!singlePlayer && (<td>
                      {!playerInfo.player.isAi && (<input type="checkbox" name="mute" checked={!playerInfo.muted} onChange={(e) => onToggleChat(playerInfo.player, e.target.checked)}/>)}
                    </td>)}
                  <td>
                    {!playerInfo.player.isObserver || playerInfo.player.defeated
                    ? playerInfo.player.getUnitsKilled()
                    : undefined}
                  </td>
                  {showResponse && (
                    <td className="player-ping">
                      {renderPingCell(strings, showResponse, conInfo, !playerInfo.player.isAi)}
                    </td>
                  )}
                  {showKick && (
                    <td className="player-kick">
                      {canKickThis && (
                        <button
                          type="button"
                          className="player-kick-btn"
                          onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onKickPlayer?.(playerInfo.player);
                          }}
                        >
                          {kickLabel}
                        </button>
                      )}
                    </td>
                  )}
                </tr>);
        })}
          </tbody>
        </table>
      </div>
      <div className="diplo-form-footer">
        <div className="game-settings">
          <div>{strings.get("TXT_MAP", mapName)}</div>
          <div>
            {[
            `${strings.get("GUI:GameType")}: ${gameTypeLabel}`,
            `${strings.get("GUI:ShortGame")}: ${formatBoolean(gameOpts.shortGame)}`,
            `${strings.get("GUI:CratesAppear")}: ${formatBoolean(gameOpts.cratesAppear)}`,
            `${strings.get("GUI:SuperWeaponsAllowed")}: ${formatBoolean(gameOpts.superWeapons)}`,
            `${strings.get("GUI:DestroyableBridges")}: ${formatBoolean(gameOpts.destroyableBridges)}`,
            `${strings.get("GUI:MultiEngineer")}: ${formatBoolean(gameOpts.multiEngineer)}`,
            `${strings.get("GUI:NoDogEngiKills")}: ${formatBoolean(gameOpts.noDogEngiKills)}`,
        ].join(", ")}
          </div>
        </div>
        {!singlePlayer && (<div data-r-tooltip={strings.get("STT:TauntsOn")}>
            <label>
              <input type="checkbox" name="taunts" checked={!!taunts} disabled={taunts === undefined} onChange={(e) => onToggleTaunts(e.target.checked)}/>
              {" "}
              <span>{strings.get("GUI:TauntsOn")}</span>
            </label>
          </div>)}
        {!singlePlayer && messages && chatHistory && localPlayer && (<div className="chat">
            <Chat localUsername={localPlayer.name} messages={messages} chatHistory={chatHistory} channels={[RECIPIENT_ALL, RECIPIENT_TEAM]} strings={strings} userColors={new Map([localPlayer, ...playerInfos.map((info) => info.player)].map((player) => [
                player.name,
                player.color.asHexString(),
            ]))} onSendMessage={onSendMessage} onCancelMessage={onCancelMessage}/>
          </div>)}
      </div>
    </div>);
};
