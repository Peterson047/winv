// WinV — Windows-style clipboard history (Win+V) + emoji picker (Win+.)
// GNOME 50 / ESM entry point.

import Clutter from 'gi://Clutter';
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
import { WinVIndicator } from './panelIndicator.js';
import { KeybindConflictResolver } from './keybindConflict.js';

const TAB = { CLIPBOARD: 'clipboard', EMOJI: 'emoji' };

export default class WinVExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._registry = new Registry({ settings: this._settings, uuid: this.uuid });
        this._manager = new ClipboardManager({ settings: this._settings, registry: this._registry });
        this._keyboard = new Keyboard();
        this._pasteTimeoutId = null;

        // Load persisted history + start listening for clipboard changes.
        // Capture the manager locally: disable() may run before init() resolves,
        // in which case start() must not touch a nulled _manager (it would throw
        // a noisy TypeError in the journal on every fast enable/disable).
        const manager = this._manager;
        manager.init()
            .then(() => { if (manager === this._manager && !manager._destroyed) manager.start(); })
            .catch(e => console.error('WinV init:', e));

        // Preload emoji data so the emoji tab opens fast.
        this._emojiData = [];
        this._loadEmojiData();

        this._recentEmojis = [];
        this._registry.readRecentEmojis().then(emojis => {
            this._recentEmojis = emojis;
        }).catch(e => console.error('WinV: load recent emojis failed:', e));

        // Top-bar indicator — owns the PopupMenu (the popup window).
        this._indicator = new WinVIndicator();
        // Left-click opens the clipboard tab (Windows-style "open here").
        this._indicator.connect('button-press-event', (_i, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this.open(TAB.CLIPBOARD);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        Main.panel.addToStatusArea('winv', this._indicator, 1, 'right');

        // Keybindings
        this._boundKeys = [];
        // Free up any system shortcut that collides with ours (GNOME binds
        // Super+V to toggle-message-tray by default — same key we want).
        this._keybindResolver = new KeybindConflictResolver();
        this._syncKeybindings();
        this._enableKeysChangedId = this._settings.connect(
            `changed::${Prefs.ENABLE_KEYBINDINGS}`, () => this._syncKeybindings());
        // Re-resolve conflicts if the user remaps either shortcut in prefs.
        this._clipKeyChangedId = this._settings.connect(
            `changed::${Prefs.CLIPBOARD_KEYBINDING}`, () => this._onShortcutRemapped());
        this._emojiKeyChangedId = this._settings.connect(
            `changed::${Prefs.EMOJI_KEYBINDING}`, () => this._onShortcutRemapped());
    }

    disable() {
        if (this._indicator) {
            this._indicator.close();
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._manager)  { this._manager.stop();     this._manager = null; }
        if (this._keyboard) { this._keyboard.destroy(); this._keyboard = null; }
        // Cancel any pending auto-paste so it doesn't fire on torn-down state.
        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = null;
        }
        if (this._enableKeysChangedId) {
            this._settings.disconnect(this._enableKeysChangedId);
            this._enableKeysChangedId = null;
        }
        if (this._clipKeyChangedId) {
            this._settings.disconnect(this._clipKeyChangedId);
            this._clipKeyChangedId = null;
        }
        if (this._emojiKeyChangedId) {
            this._settings.disconnect(this._emojiKeyChangedId);
            this._emojiKeyChangedId = null;
        }
        this._unbindAll();
        // Restore the shell's original bindings (e.g. put Super+V back on the
        // message tray) before tearing down.
        if (this._keybindResolver) {
            this._keybindResolver.destroy();
            this._keybindResolver = null;
        }
        this._registry = null;
        this._settings = null;
    }

    // ---- keybindings ------------------------------------------------------

    _syncKeybindings() {
        this._unbindAll();
        if (this._settings.get_boolean(Prefs.ENABLE_KEYBINDINGS)) {
            this._bindKey(Prefs.CLIPBOARD_KEYBINDING, () => this.open(TAB.CLIPBOARD));
            this._bindKey(Prefs.EMOJI_KEYBINDING,     () => this.open(TAB.EMOJI));
            // Free our shortcuts from any colliding system binding (Super+V →
            // toggle-message-tray) so our popup actually gets the keypress.
            this._resolveKeybindConflicts();
        }
    }

    // When a shortcut is remapped in prefs, re-resolve against system bindings:
    // return the old accelerator to the tray and claim the new one.
    _onShortcutRemapped() {
        if (!this._settings.get_boolean(Prefs.ENABLE_KEYBINDINGS)) return;
        this._resolveKeybindConflicts();
    }

    // Push both of our current accelerators to the resolver, which diffs against
    // what it already owns and updates toggle-message-tray accordingly.
    _resolveKeybindConflicts() {
        if (!this._keybindResolver) return;
        this._keybindResolver.sync([
            this._getAccelerator(Prefs.CLIPBOARD_KEYBINDING),
            this._getAccelerator(Prefs.EMOJI_KEYBINDING),
        ].filter(Boolean));
    }

    // Read the first accelerator string for a keybinding pref (e.g. '<Super>v'),
    // or null if unbound.
    _getAccelerator(keyName) {
        const accels = this._settings.get_strv(keyName);
        return accels.length ? accels[0] : null;
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
        // Toggle behavior: if the menu is open, close it. But if the menu is
        // in a stale state (closed by selecting an item but isOpen not yet
        // updated), force-close first then reopen.
        if (this._indicator.isOpen) {
            const content = this._indicator._content;
            if (content && tab && content._activeTab !== tab) {
                content.switchTab(tab);
                return;
            }
            this._indicator.close();
            return;
        }
        this._indicator.openAtCursor(tab || TAB.CLIPBOARD, this._context());
    }

    _context() {
        return {
            manager: this._manager,
            settings: this._settings,
            registry: this._registry,
            extension: this,
            popup: this._indicator,
            emojiData: this._emojiData,
            onClosed: () => this._indicator.close(),
        };
    }

    // Load emoji.json (bundled) once, in the background.
    _loadEmojiData() {
        const path = `${this.path}/emoji.json`;
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (obj, res) => {
            try {
                const [ok, bytes] = obj.load_contents_finish(res);
                if (!ok) return;
                const text = new TextDecoder().decode(bytes);
                this._emojiData = JSON.parse(text);
                if (this._indicator?._content?._emojiView) {
                    this._indicator._content._emojiView._all = this._emojiData;
                    this._indicator._content._emojiView._populate();
                }
            } catch (e) {
                console.error('WinV: emoji.json load failed:', e);
            }
        });
    }

    // ---- helpers used by views -------------------------------------------

    // Recently-used emojis (kept in memory for the session; persisted later).
    // Newest first, capped at a small number for the "recent" row.
    _recentEmojis = [];
    get recentEmojis() { return this._recentEmojis; }
    pushRecentEmoji(emoji) {
        // Dedup by char, then unshift. Cap at 16 entries.
        this._recentEmojis = this._recentEmojis.filter(e => e.char !== emoji.char);
        this._recentEmojis.unshift(emoji);
        if (this._recentEmojis.length > 16)
            this._recentEmojis.length = 16;
        this._registry.writeRecentEmojis(this._recentEmojis).catch(e => console.error(e));
    }

    async copyAndPaste(text, closePopup) {
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        // Close the menu FIRST so the modal grab releases and keyboard focus
        // returns to the target app. Then paste after a short delay (matches
        // the clipboard-indicator timing of ~50ms).
        if (closePopup) closePopup();
        if (this._settings.get_boolean(Prefs.PASTE_ON_SELECT))
            this._schedulePaste(() => this.pasteIntoFocus());
    }

    commitEmoji(char, closePopup) {
        if (closePopup) closePopup();
        if (this._settings.get_boolean(Prefs.PASTE_ON_SELECT)) {
            this._schedulePaste(() => {
                try {
                    Main.inputMethod.commit(char);
                } catch (e) {
                    console.error('WinV: commit emoji failed, falling back to clipboard:', e);
                    this.copyAndPaste(char, null);
                }
            });
        } else {
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, char);
        }
    }

    // Schedule a paste/commit shortly after closing the popup (gives the target
    // app time to regain focus). Tracked so disable() can cancel a pending paste
    // instead of firing it on a torn-down extension (which would null-deref
    // _settings/_keyboard). One slot — a new paste cancels any pending one.
    _schedulePaste(fn) {
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._pasteTimeoutId = null;
            // Guard: disable() may have run during the delay.
            if (!this._settings) return GLib.SOURCE_REMOVE;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    pasteIntoFocus() {
        if (!this._keyboard?.ready) {
            Main.notify(_('WinV'), _('Copiado — use Ctrl+V.'));
            return;
        }
        this._keyboard.paste();
    }
}
