// Clipboard history controller.
//
// Listens for clipboard changes via Meta.Selection::'owner-changed' (NOT polling),
// reads the new content (text or image), dedupes by content hash, enforces the
// history-size cap, and persists to disk via the Registry.
//
// Key API (verified against GNOME 50.1):
//   const selection = Shell.Global.get().get_display().get_selection();
//   selection.connect('owner-changed', (sel, type, _source) => {...});
//   type === Meta.SelectionType.SELECTION_CLIPBOARD

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { ClipboardEntry } from './registry.js';
import { CLIPBOARD_MIMETYPES, MIMETYPE_NORMALIZE } from './constants.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

export class ClipboardManager {
    constructor({ settings, registry }) {
        this.settings = settings;
        this.registry = registry;
        this.clipboard = St.Clipboard.get_default();

        this.entries = [];           // newest first
        this._selectionOwnerChangedId = null;
        this._selection = null;
        this._destroyed = false;
        this._saveTimeoutId = null;

        // Reentrancy guard: when WE write to the clipboard (item reselected),
        // owner-changed fires again — skip it.
        this._suppressNext = false;
    }

    async init() {
        // Load persisted history first so the popup is populated immediately.
        this.entries = await this.registry.read();
    }

    start() {
        const display = Shell.Global.get().get_display();
        this._selection = display.get_selection();
        this._selectionOwnerChangedId =
            this._selection.connect('owner-changed', (_sel, type) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._onClipboardChanged().catch(e => console.error('WinV owner-changed:', e));
            });
    }

    stop() {
        this._destroyed = true;
        if (this._selectionOwnerChangedId && this._selection) {
            this._selection.disconnect(this._selectionOwnerChangedId);
            this._selectionOwnerChangedId = null;
        }
        this._selection = null;
        this._flushSaveNow();
    }

    // Read the current clipboard content, trying each mimetype in order.
    async _readContent() {
        for (let type of CLIPBOARD_MIMETYPES) {
            const result = await new Promise(resolve =>
                this.clipboard.get_content(CLIPBOARD_TYPE, type, (_cb, bytes) => {
                    if (bytes === null || bytes.get_size() === 0) { resolve(null); return; }

                    // GNOME mangles UTF8_STRING on 2nd+ copy; normalize it back.
                    // (gnome-shell#8233)
                    if (MIMETYPE_NORMALIZE[type]) type = MIMETYPE_NORMALIZE[type];

                    resolve(new ClipboardEntry(type, bytes.get_data(), false));
                }));

            if (!result) continue;

            // Honor the cache-images setting: ignore image copies if disabled.
            if (result.isImage() && !this.settings.get_boolean('cache-images'))
                return null;

            return result;
        }
        return null;
    }

    async _onClipboardChanged() {
        if (this._destroyed || this._suppressNext) return;

        const entry = await this._readContent();
        if (!entry) return;

        // Optional whitespace trim for text.
        if (entry.isText() && this.settings.get_boolean('strip-text')) {
            const trimmed = entry.getStringValue().trim();
            if (trimmed === '') return;
        }

        this._addEntry(entry);
    }

    _addEntry(entry) {
        // Dedup: if the same content already exists, optionally move it to top.
        const existingIdx = this.entries.findIndex(e => e.equals(entry));
        if (existingIdx >= 0) {
            if (this.settings.get_boolean('move-item-first')) {
                const [existing] = this.entries.splice(existingIdx, 1);
                existing.setTimestamp(entry.getTimestamp());
                this.entries.unshift(existing);
            }
            this._scheduleSave();
            return;
        }

        this.entries.unshift(entry);

        // Enforce cap: drop oldest non-favorite(s) until within size.
        const maxSize = this.settings.get_int('history-size');
        while (this.entries.filter(e => !e.isFavorite()).length > maxSize) {
            // find last non-favorite
            for (let i = this.entries.length - 1; i >= 0; i--) {
                if (!this.entries[i].isFavorite()) {
                    const [dropped] = this.entries.splice(i, 1);
                    if (dropped.isImage())
                        this.registry.deleteEntryFile(dropped).catch(()=>{});
                    break;
                }
            }
        }

        this._scheduleSave();
    }

    // Public: the UI calls this when the user re-selects an old item.
    // Writes it back to the clipboard (and moves it to top if configured).
    async selectItem(entry) {
        this._suppressNext = true;
        try {
            this.clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype(), entry.asBytes());
        } finally {
            // Re-arm after a short tick so our own write's owner-changed is skipped.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._suppressNext = false;
                return GLib.SOURCE_REMOVE;
            });
        }

        if (this.settings.get_boolean('move-item-first')) {
            const idx = this.entries.indexOf(entry);
            if (idx > 0) {
                const [e] = this.entries.splice(idx, 1);
                e.setTimestamp(Date.now());
                this.entries.unshift(e);
                this._scheduleSave();
            }
        }
    }

    toggleFavorite(entry) {
        entry.favorite = !entry.isFavorite();
        this._scheduleSave();
    }

    deleteEntry(entry) {
        const idx = this.entries.indexOf(entry);
        if (idx >= 0) {
            this.entries.splice(idx, 1);
            if (entry.isImage())
                this.registry.deleteEntryFile(entry).catch(() => {});
            this._scheduleSave();
        }
    }

    async clearAll() {
        // Keep favorites, drop everything else.
        const removed = this.entries.filter(e => !e.isFavorite());
        this.entries = this.entries.filter(e => e.isFavorite());
        for (const e of removed) {
            if (e.isImage())
                await this.registry.deleteEntryFile(e).catch(() => {});
        }
        this._scheduleSave();
    }

    filtered(query, onlyFavorites) {
        const q = query.trim().toLowerCase();
        return this.entries.filter(e => {
            if (onlyFavorites && !e.isFavorite()) return false;
            if (!q) return true;
            return e.getStringValue().toLowerCase().includes(q);
        });
    }

    // Debounced persistence: coalesce rapid bursts of copies.
    _scheduleSave() {
        if (this._saveTimeoutId) return;
        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveTimeoutId = null;
            this.registry.write(this.entries).catch(e => console.error('WinV save:', e));
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushSaveNow() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = null;
        }
        this.registry.write(this.entries).catch(e => console.error('WinV save:', e));
    }
}
