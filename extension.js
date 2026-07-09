// WinV — Windows-style clipboard history (Win+V) + emoji picker (Win+.)
// GNOME 50 / ESM entry point.

import St from 'gi://St';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Prefs } from './constants.js';
import { Registry } from './registry.js';
import { ClipboardManager } from './clipboardManager.js';
import { Keyboard } from './keyboard.js';
import { Popup } from './popup.js';
import { WinvView } from './winvView.js';
import { PanelIndicator } from './panelIndicator.js';

const TAB = { CLIPBOARD: 'clipboard', EMOJI: 'emoji' };

export default class WinVExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._registry = new Registry({ settings: this._settings, uuid: this.uuid });
        this._manager = new ClipboardManager({ settings: this._settings, registry: this._registry });
        this._keyboard = new Keyboard();
        this._popup = new Popup();
        this._view = null;

        // Load persisted history + start listening for clipboard changes.
        this._manager.init().then(() => this._manager.start())
            .catch(e => console.error('WinV init:', e));

        // Preload emoji data (async, non-blocking) so the emoji tab opens fast.
        this._emojiData = [];
        this._loadEmojiData();

        // Keybindings
        this._boundKeys = [];
        this._syncKeybindings();
        this._enableKeysChangedId = this._settings.connect(
            `changed::${Prefs.ENABLE_KEYBINDINGS}`, () => this._syncKeybindings());

        // Top-bar indicator
        this._indicator = new PanelIndicator({
            onOpenClipboard: () => this.open(TAB.CLIPBOARD),
            onOpenEmoji:     () => this.open(TAB.EMOJI),
            onPreferences:   () => this.openPreferences(),
            onClearHistory:  () => this._manager.clearAll()
                .then(() => { if (this._view) this._view._clipboardView?._rebuildRows?.(); })
                .catch(e => console.error('WinV clear:', e)),
        });
        this._indicator.init();
        Main.panel.addToStatusArea('winv', this._indicator.actor, 1, 'right');
    }

    disable() {
        if (this._view)     { this._view.destroy();     this._view = null; }
        if (this._popup)    { this._popup.destroy();    this._popup = null; }
        if (this._indicator){ this._indicator.destroy(); this._indicator = null; }
        if (this._manager)  { this._manager.stop();     this._manager = null; }
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

    _syncKeybindings() {
        this._unbindAll();
        if (this._settings.get_boolean(Prefs.ENABLE_KEYBINDINGS)) {
            this._bindKey(Prefs.CLIPBOARD_KEYBINDING, () => this.open(TAB.CLIPBOARD));
            this._bindKey(Prefs.EMOJI_KEYBINDING,     () => this.open(TAB.EMOJI));
        }
    }

    _bindKey(keyName, handler) {
        Main.wm.addKeybinding(
            keyName, this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, handler);
        this._boundKeys.push(keyName);
    }

    _unbindAll() {
        while (this._boundKeys.length)
            Main.wm.removeKeybinding(this._boundKeys.pop());
    }

    // ---- popup launcher ---------------------------------------------------

    open(tab) {
        // Toggle: if already open, close.
        if (this._popup.isOpen) { this._popup.close(); return; }

        this._popup.setOnClose(() => {
            if (this._view) { this._view.destroy(); this._view = null; }
        });

        this._popup.open(() => {
            this._view = new WinvView({
                manager: this._manager,
                settings: this._settings,
                registry: this._registry,
                extension: this,
                popup: this._popup,
                initialTab: tab || TAB.CLIPBOARD,
                emojiData: this._emojiData,
                onClosed: () => this._popup.close(),
            });
            return this._view.build();
        });
    }

    // Load emoji.json (bundled) once, in the background. The emoji tab reads
    // this._emojiData when built; if the user opens Win+. before loading
    // finishes, the tab shows empty until the next open.
    _loadEmojiData() {
        const path = `${this.path}/emoji.json`;
        const file = Gio.file_new_for_path(path);
        file.load_contents_async(null, (obj, res) => {
            try {
                const [ok, bytes] = obj.load_contents_finish(res);
                if (!ok) return;
                const text = new TextDecoder().decode(bytes);
                this._emojiData = JSON.parse(text);
            } catch (e) {
                console.error('WinV: emoji.json load failed:', e);
            }
        });
    }

    // ---- helpers used by views -------------------------------------------

    // Copy text to the clipboard and (if enabled) auto-paste into focus.
    // `closePopup` is called FIRST so the modal grab is released and keyboard
    // focus returns to the target app before we synthesize Ctrl+V.
    async copyAndPaste(text, closePopup) {
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        if (closePopup) closePopup();
        if (this._settings.get_boolean(Prefs.PASTE_ON_SELECT)) {
            // Give the shell time to pop the modal grab and restore focus to
            // the target app before we emit the synthetic Ctrl+V.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this.pasteIntoFocus();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    pasteIntoFocus() {
        if (!this._keyboard?.ready) {
            Main.notify(_('WinV'), _('Copiado — use Ctrl+V.'));
            return;
        }
        this._keyboard.paste();
    }
}
