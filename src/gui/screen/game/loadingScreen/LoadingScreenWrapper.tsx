import { jsx } from '@/gui/jsx/jsx';
import { HtmlContainer } from '@/gui/HtmlContainer';
import { UiComponent } from '@/gui/jsx/UiComponent';
import { UiObject } from '@/gui/UiObject';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { LoadingScreen } from './LoadingScreen';
import { OBS_COUNTRY_NAME, OBS_COUNTRY_UI_NAME } from '@/game/gameopts/constants';
import * as THREE from 'three';
import { SideType } from '@/game/SideType';
import { Engine } from '@/engine/Engine';
interface Country {
    name: string;
    side: SideType;
    uiName: string;
}
interface PlayerInfo {
    name: string;
    country?: Country;
    color?: string;
}
interface Rules {
    getMultiplayerCountries(): Country[];
    colors: Map<string, any>;
}
interface Viewport {
    x: number;
    y: number;
    width: number;
    height: number;
}
interface GameResConfig {
    isCdn(): boolean;
    getCdnBaseUrl(): string;
}
interface LoadingScreenWrapperProps {
    playerInfos: PlayerInfo[];
    strings: {
        get(key: string, ...args: any[]): string;
    };
    rules: Rules;
    viewport: Viewport;
    playerName?: string;
    mapName: string;
    gameResConfig: GameResConfig;
    onKickPlayer?: (playerName: string) => void;
}
const countryBackgrounds = new Map<string, string>()
    .set("Americans", "ls800ustates.png")
    .set("French", "ls800france.png")
    .set("Germans", "ls800germany.png")
    .set("British", "ls800ukingdom.png")
    .set("Russians", "ls800russia.png")
    .set("Confederation", "ls800cuba.png")
    .set("Africans", "ls800libya.png")
    .set("Arabs", "ls800iraq.png")
    .set("Alliance", "ls800korea.png")
    .set(OBS_COUNTRY_NAME, "ls800obs.png");
export class LoadingScreenWrapper extends UiComponent<LoadingScreenWrapperProps> {
    private declare countryName: string;
    private declare color: string;
    private declare bgHtmlImg?: string;
    private declare bgSpriteImg?: string;
    private declare bgSpritePal?: string;
    private declare htmlEl?: any;
    private declare sprite?: any;
    createUiObject({ playerName, gameResConfig }: {
        playerName?: string;
        gameResConfig: GameResConfig;
    }): UiObject {
        const uiObject = new UiObject(new THREE.Object3D(), new HtmlContainer());
        const player = playerName
            ? this.props.playerInfos.find(p => p.name === playerName)
            : undefined;
        const countryName = player?.country ? player.country.name : OBS_COUNTRY_NAME;
        this.countryName = countryName;
        let color = player?.color ?? "#fff";
        if (player?.country) {
            const loadColorKey = player.country.side === SideType.GDI ? "AlliedLoad" : "SovietLoad";
            color = this.props.rules.colors.get(loadColorKey)?.asHexString() ?? "#fff";
        }
        this.color = color;
        const backgroundImage = countryBackgrounds.get(countryName);
        if (backgroundImage) {
            if (gameResConfig.isCdn()) {
                this.bgHtmlImg = gameResConfig.getCdnBaseUrl() + "ls/" + backgroundImage;
            }
            else {
                this.bgSpriteImg = backgroundImage.replace("png", "shp");
                this.bgSpritePal = player?.country ? "mpls.pal" : "mplsobs.pal";
            }
        }
        else {
            console.warn("Missing loading image for country " + countryName);
        }
        return uiObject;
    }
    defineChildren(): any {
        const countries = this.props.rules.getMultiplayerCountries();
        const viewport = this.props.viewport;
        return jsx("fragment", null, this.props.gameResConfig.isCdn()
            ? []
            : jsx("sprite", {
                image: this.bgSpriteImg,
                palette: this.bgSpritePal,
                x: viewport.x,
                y: viewport.y,
                ref: (sprite: any) => (this.sprite = sprite),
            }), jsx(HtmlView, {
            innerRef: (el: any) => (this.htmlEl = el),
            component: LoadingScreen,
            props: {
                viewport: this.props.viewport,
                countryUiNames: new Map([
                    [OBS_COUNTRY_NAME, OBS_COUNTRY_UI_NAME],
                    ...countries.map(country => [country.name, country.uiName] as [
                        string,
                        string
                    ])
                ]),
                strings: this.props.strings,
                countryName: this.countryName,
                mapName: this.props.mapName,
                color: this.color,
                playerInfos: this.props.playerInfos,
                bgImageSrc: this.bgHtmlImg,
                onKickPlayer: this.props.onKickPlayer,
            },
        }));
    }
    updateViewport(viewport: Viewport): void {
        this.htmlEl?.applyOptions((options: any) => (options.viewport = viewport));
        this.sprite?.setPosition(viewport.x, viewport.y);
    }
    applyOptions(optionsUpdater: (options: any) => void): void {
        this.htmlEl?.applyOptions(optionsUpdater);
    }
}
