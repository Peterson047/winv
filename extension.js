// WinV — Windows-style clipboard history (Win+V) + emoji picker (Win+.)
// GNOME 50 / ESM entry point.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SCHEMA_ID, Prefs } from './constants.js';
import { Registry } from './registry.js';
import { ClipboardManager } from './clipboardManager.js';
import { Keyboard } from './keyboard.js';
import { Popup } from './popup.js';
import { ClipboardView } from './clipboardView.js';

export default class WinVExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._registry = new Registry({ settings: this._settings, uuid: this.uuid });
        this._manager = new ClipboardManager({ settings: this._settings, registry: this._registry });
        this._keyboard = new Keyboard();
        this._popup = new Popup();

        // Bind the two shortcuts.
        this._boundKeys = [];
        if (this._settings.get_boolean(Prefs.ENABLE_KEYBINDINGS)) {
            this._bindKey(Prefs.CLIPBOARD_KEYBINDING, () => this.openClipboard());
            this._bindKey(Prefs.EMOJI_KEYBINDING, () => this.openEmoji());
        }
        // React to the user toggling shortcuts in prefs.
        this._enableKeysChangedId = this._settings.connect(
            `changed::${Prefs.ENABLE_KEYBINDINGS}`, () => this._syncKeybindings());

        // Load persisted history + start listening for clipboard changes.
        this._manager.init().then(() => {
            this._manager.start();
        }).catch(e => console.error('WinV init:', e));
    }

    disable() {
        if (this._popup) { this._popup.destroy(); this._popup = null; }
        if (this._manager) { this._manager.stop(); this._manager = null; }
        if (this._keyboard) { this._keyboard.destroy(); this._keyboard = null; }
        if (this._enableKeysChangedId) {
            this._settings.disconnect(this._enableKeysChangedId);
            this._enableKeysChangedId = null;
        }
        this._unbindAll();
        this._registry = null;
        this._settings = null;
    }

    // ---- keybindings ------------------------------------------------------

    _bindKey(keyName, handler) {
        Main.wm.addKeybinding(
            keyName,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            handler,
        );
        this._boundKeys.push(keyName);
    }

    _unbindAll() {
        while (this._boundKeys.length)
            Main.wm.removeKeybinding(this._boundKeys.pop());
    }

    _syncKeybindings() {
        this._unbindAll();
        if (this._settings.get_boolean(Prefs.ENABLE_KEYBINDINGS)) {
            this._bindKey(Prefs.CLIPBOARD_KEYBINDING, () => this.openClipboard());
            this._bindKey(Prefs.EMOJI_KEYBINDING, () => this.openEmoji());
        }
    }

    // ---- popup launchers --------------------------------------------------

    openClipboard() {
        if (this._popup.isOpen) { this._popup.close(); return; }

        this._popup.setOnClose(null);
        this._popup.open(() => {
            const view = new ClipboardView({
                manager: this._manager,
                settings: this._settings,
                registry: this._registry,
                extension: this,
                popup: this._popup,
                onClosed: () => this._popup.close(),
            });
            this._activeView = view;
            return view.build();
        });
    }

    openEmoji() {
        // Phase 2: emoji picker will plug in here via the same Popup.
        if (this._popup.isOpen) { this._popup.close(); return; }
        Main.notify(_('WinV'), _('O seletor de emojis chega na próxima fase!'));
    }

    // Called by the view after selecting an item (and after the popup closes,
    // so focus is back on the target app).
    pasteIntoFocus() {
        if (!this._keyboard?.ready) {
            Main.notify(_('WinV'), _('Item copiado — use Ctrl+V.'));
            return;
        }
        this._keyboard.paste();
    }
}
