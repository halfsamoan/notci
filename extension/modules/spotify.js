import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DockParticipant} from '../notchDock.js';

// Placeholder: replaced by the real module. Keeps the host loadable.
export class SpotifyModule {
    constructor({uuid}) {
        this.root = new St.BoxLayout({vertical: true, style_class: 'notci-module notci-spotify',
            reactive: false, can_focus: false, clip_to_allocation: true});
        this._dock = new DockParticipant({id: `${uuid}/spotify`, content: this.root, order: 2,
            monitor: () => Main.layoutManager.primaryMonitor, triggerActor: () => null,
            onOutside: () => this.collapse(), onYield: () => this.collapse()});
    }

    collapse() {}

    destroy() {
        this._dock?.destroy();
        this._dock = null;
        try { this.root?.destroy(); } catch (_error) {}
        this.root = null;
    }
}
