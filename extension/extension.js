import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {isActorWithin} from './dockModel.js';
import {DESIGN} from './designTokens.js';
import {KakaoModule} from './modules/kakao.js';
import {SpotifyModule} from './modules/spotify.js';
import {AudioModule} from './modules/audio.js';
import {AgentModule} from './modules/agent.js';
import {DownloadModule} from './modules/download.js';

// One private cache directory for album art and probe files.
export const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'notci@local']);

export default class Notci extends Extension {
    enable() {
        this._settings = this.getSettings();
        GLib.mkdir_with_parents(CACHE_DIR, 0o700);
        // The top bar goes pure black too, so the island reads as one piece with it (Mac notch /
        // Dynamic Island). Yaru dark declares `#panel { background-color: #131313 !important }`; the
        // inline style is marked !important as well and stylesheet.css repeats the rule, because the
        // plain inline left the real panel at #131313 (2026-10-25). disable() restores the style, and
        // the lock screen never sees it because this extension runs in the user session only.
        this._panelStyle = Main.panel.get_style();
        Main.panel.set_style(`background-color: ${DESIGN.color.surfacePrimary} !important; transition-duration: 0ms;`);
        const context = {settings: this._settings, uuid: this.uuid, path: this.path, cacheDir: CACHE_DIR};
        this._spotify = new SpotifyModule(context);
        this._kakao = new KakaoModule(context);
        this._audio = new AudioModule(context);
        this._agent = new AgentModule(context);
        this._download = new DownloadModule(context);
        // Esc collapses whichever module holds key focus; alert cards never steal focus.
        this._keyId = global.stage.connect('key-press-event', (_stage, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
            const focus = global.stage.get_key_focus();
            for (const module of [this._kakao, this._spotify, this._audio]) {
                if (!module?.root || !isActorWithin(focus, module.root)) continue;
                module.collapse();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    disable() {
        if (this._keyId) {
            try { global.stage.disconnect(this._keyId); } catch (_error) {}
        }
        this._keyId = 0;
        this._download?.destroy();
        this._agent?.destroy();
        // audio first: it owns subprocesses and udev/UPower listeners.
        this._audio?.destroy();
        this._kakao?.destroy();
        this._spotify?.destroy();
        try { Main.panel.set_style(this._panelStyle ?? null); } catch (_error) {}
        this._kakao = this._spotify = this._audio = this._agent = this._download = this._settings = null;
    }
}
