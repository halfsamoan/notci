import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Follows Shell's message tray and reports notifications that pass `match(source, n)`.
// Existing notifications are never replayed; only ones added after start().
export class NotifyWatch {
    constructor({match, onAdded, onUpdated, onRemoved}) {
        this._match = match;
        this._onAdded = onAdded;
        this._onUpdated = onUpdated;
        this._onRemoved = onRemoved;
        this._sources = new Set();
        this._notifications = new Set();
    }

    start() {
        Main.messageTray.connectObject('source-added', (_tray, source) => this._attach(source),
            'source-removed', (_tray, source) => this._detach(source), this);
        for (const source of Main.messageTray.getSources()) this._attach(source);
    }

    stop() {
        try { Main.messageTray.disconnectObject(this); } catch (_error) {}
        for (const source of this._sources) {
            try { source.disconnectObject(this); } catch (_error) {}
        }
        this._sources.clear();
        for (const notification of this._notifications) {
            try { notification.disconnectObject(this); } catch (_error) {}
        }
        this._notifications.clear();
    }

    _attach(source) {
        if (this._sources.has(source)) return;
        this._sources.add(source);
        source.connectObject('notification-added', (_source, n) => this._onNotificationAdded(source, n), this);
    }

    _detach(source) {
        try { source.disconnectObject(this); } catch (_error) {}
        this._sources.delete(source);
    }

    _onNotificationAdded(source, n) {
        if (!this._match(source, n)) return;
        this._notifications.add(n);
        n.connectObject('notify::datetime', () => this._onUpdated?.({source, notification: n}),
            'destroy', (_n, reason) => {
                this._notifications.delete(n);
                this._onRemoved?.(n, reason);
            }, this);
        this._onAdded({source, notification: n});
    }
}
