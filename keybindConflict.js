// Resolves keybinding collisions between WinV's shortcuts and GNOME Shell's
// own system bindings — most notably toggle-message-tray, which GNOME binds to
// Super+V by default (the same key we want for the clipboard history).
//
// Strategy: when WinV's clipboard shortcut is armed, strip it from the shell's
// message-tray binding (preserving any OTHER accelerators there, like Super+m).
// The original value is remembered and restored verbatim on disable, so we
// never clobber a user's custom setup.
//
// We only ever touch toggle-message-tray: it's the one shell binding that
// ships on Super+V and blocks us. Other shortcuts (Super+E etc.) don't collide
// with anything native, so we leave them alone.

import Gio from 'gi://Gio';

import { SHELL_KEYBINDINGS_SCHEMA, MESSAGE_TRAY_KEY } from './constants.js';

export class KeybindConflictResolver {
    constructor() {
        this._shell = new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA });
        // Snapshot of the user's message-tray binding, taken the first time we
        // claim a key. We mutate a working copy and restore the original on
        // releaseAll()/disable().
        this._originalTray = null;
        // The accelerators we currently hold (claimed from the tray).
        this._claimed = new Set();
    }

    /**
     * Take ownership of `accel`: remove it from the message-tray binding if
     * present (saving the original first). Idempotent — claiming an accel that
     * is already claimed is a no-op.
     */
    claim(accel) {
        if (!accel) return;
        if (!this._originalTray) this._snapshot();
        if (this._claimed.has(accel)) return;       // already ours
        if (!this._originalTray.includes(accel)) return; // never was on the tray
        this._claimed.add(accel);
        this._apply();
    }

    /**
     * Give `accel` back to the tray (when the user remaps our shortcut away from
     * it). Idempotent.
     */
    release(accel) {
        if (!accel || !this._claimed.has(accel)) return;
        this._claimed.delete(accel);
        this._apply();
    }

    /**
     * Synchronise the set of accelerators we should own. Any accelerator we held
     * that is no longer in `accels` is returned to the tray; any new one is
     * claimed. Used when the user remaps a shortcut in prefs.
     */
    sync(accels) {
        if (!this._originalTray) this._snapshot();
        const want = new Set(accels.filter(a => a));
        for (const a of this._claimed)
            if (!want.has(a)) this._claimed.delete(a);
        for (const a of want)
            if (this._originalTray.includes(a)) this._claimed.add(a);
        this._apply();
    }

    /**
     * Restore the message-tray binding to exactly what it was before we touched
     * it. Called from disable().
     */
    releaseAll() {
        if (!this._originalTray) return;
        this._shell.set_strv(MESSAGE_TRAY_KEY, this._originalTray);
        this._originalTray = null;
        this._claimed.clear();
    }

    destroy() {
        this.releaseAll();
        this._shell = null;
    }

    _snapshot() {
        this._originalTray = this._shell.get_strv(MESSAGE_TRAY_KEY);
    }

    // Tray = original accelerators minus the ones we currently own.
    _apply() {
        if (!this._originalTray) return;
        const effective = this._originalTray.filter(a => !this._claimed.has(a));
        this._shell.set_strv(MESSAGE_TRAY_KEY, effective);
    }
}
