// Resolves keybinding collisions between WinV's shortcuts and other system
// bindings — both GNOME Shell's own and IBus.
//
// Known collisions:
//   • toggle-message-tray (org.gnome.shell.keybindings) ships Super+V by
//     default — same key we want for the clipboard history.
//   • IBus emoji panel (org.freedesktop.ibus.panel.emoji) ships Super+. by
//     default — same key we want for the emoji picker.
//
// Strategy: for each target binding, snapshot its original accelerators the
// first time we touch it, then strip any accelerator we're claiming and write
// the filtered list back. On disable, every target is restored to its exact
// original value, so a user's custom setup is never clobbered. Targets whose
// schema isn't installed (e.g. no IBus) are skipped silently.

import Gio from 'gi://Gio';

import {
    SHELL_KEYBINDINGS_SCHEMA, MESSAGE_TRAY_KEY,
    IBUS_EMOJI_SCHEMA, IBUS_EMOJI_KEY,
} from './constants.js';

// Each target is a system binding we may strip our accelerators from.
// A target that can't be loaded (schema missing) reports unavailable = true and
// is ignored.
class Target {
    constructor(schemaId, key) {
        this.schemaId = schemaId;
        this.key = key;
        this.original = null;     // strv snapshot, or null until first touch
        try {
            this.settings = new Gio.Settings({ schema_id: schemaId });
        } catch (e) {
            this.settings = null;  // schema not installed on this system
        }
    }

    get available() { return this.settings !== null; }

    snapshot() {
        this.original = this.settings.get_strv(this.key);
    }

    apply(claimed) {
        if (!this.original) return;
        const effective = this.original.filter(a => !claimed.has(a));
        this.settings.set_strv(this.key, effective);
    }

    restore() {
        if (!this.original) return;
        this.settings.set_strv(this.key, this.original);
        this.original = null;
    }

    destroy() {
        this.settings = null;
    }
}

export class KeybindConflictResolver {
    constructor() {
        this._targets = [
            new Target(SHELL_KEYBINDINGS_SCHEMA, MESSAGE_TRAY_KEY),
            new Target(IBUS_EMOJI_SCHEMA, IBUS_EMOJI_KEY),
        ];
        // Accelerators we currently hold across all targets.
        this._claimed = new Set();
    }

    /**
     * Synchronise the set of accelerators we should own. Accelerators we held
     * that are no longer in `accels` are returned to their targets; new ones are
     * claimed. Used when the user remaps a shortcut in prefs or on enable.
     */
    sync(accels) {
        const want = new Set(accels.filter(a => a));
        // Note: we don't subtract here — sync() defines the full desired set, so
        // rebuild _claimed from scratch based on what targets actually contain.
        this._claimed = new Set();
        for (const accel of want) {
            if (this._targets.some(t => t.available && this._targetHas(t, accel)))
                this._claimed.add(accel);
        }
        this._applyTargets();
    }

    // Whether `accel` is present on a target's (snapshotted or live) binding.
    _targetHas(target, accel) {
        if (!target.original) target.snapshot();
        return target.original.includes(accel);
    }

    _applyTargets() {
        for (const t of this._targets) {
            if (!t.available) continue;
            if (!t.original) t.snapshot();
            t.apply(this._claimed);
        }
    }

    /**
     * Restore every target to its original value. Called from disable().
     */
    releaseAll() {
        for (const t of this._targets) t.restore();
        this._claimed.clear();
    }

    destroy() {
        this.releaseAll();
        for (const t of this._targets) t.destroy();
        this._targets = [];
    }
}
