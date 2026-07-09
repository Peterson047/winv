// Clipboard history tab content (the list of copied items).
//
// This is embedded inside the unified window (winvView.js) which provides the
// header / tab bar / search-or-not. Here we render: the scrollable list of rows
// (preview + timestamp + pin + delete), the empty state, and the "clear all"
// footer action.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ROW_PREVIEW_CHARS } from './constants.js';
import { DialogManager } from './confirmDialog.js';

// ---- helpers -----------------------------------------------------------

function truncate(text, n) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

function relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < min) return 'agora';
    if (diff < hr)   return `${Math.floor(diff / min)} min`;
    if (diff < day)  return `${Math.floor(diff / hr)} h`;
    return `${Math.floor(diff / day)} d`;
}

// ---- A single history row ---------------------------------------------

const HistoryRow = GObject.registerClass({
    Signals: {
        'selected':   { param_types: [GObject.TYPE_JSOBJECT] },
        'toggle-pin': { param_types: [GObject.TYPE_JSOBJECT] },
        'deleted':    { param_types: [GObject.TYPE_JSOBJECT] },
    },
}, class HistoryRow extends St.BoxLayout {
    _init(entry, thumbActor) {
        super._init({ style_class: 'winv-row popup-menu-item', reactive: true, can_focus: true });

        // Left: thumbnail (images) or icon (text)
        if (thumbActor) {
            thumbActor.add_style_class_name('winv-thumb');
            this.add_child(thumbActor);
        } else {
            this.add_child(new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'popup-menu-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const preview = new St.Label({
            text: truncate(entry.getStringValue(), ROW_PREVIEW_CHARS),
            style_class: 'winv-row-preview',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        preview.clutter_text.set_line_wrap(false);
        preview.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this.add_child(preview);

        this.add_child(new St.Widget({ x_expand: true }));

        this.add_child(new St.Label({
            text: relativeTime(entry.getTimestamp()),
            style_class: 'winv-time',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const pinBtn = new St.Button({
            style_class: 'winv-action-btn',
            can_focus: true,
            child: new St.Icon({
                icon_name: entry.isFavorite() ? 'starred-symbolic' : 'non-starred-symbolic',
                style_class: 'popup-menu-icon',
            }),
            toggle_mode: true,
            checked: entry.isFavorite(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        pinBtn.connect('clicked', () => this.emit('toggle-pin', this.entry));
        this.add_child(pinBtn);

        const delBtn = new St.Button({
            style_class: 'winv-action-btn',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'popup-menu-icon',
            }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        delBtn.connect('clicked', () => this.emit('deleted', this.entry));
        this.add_child(delBtn);

        this.entry = entry;
        this._pinBtn = pinBtn;

        this.connect('button-press-event', () => { this.emit('selected', this.entry); return Clutter.EVENT_STOP; });
        this.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Return ||
                event.get_key_symbol() === Clutter.KEY_KP_Enter) {
                this.emit('selected', this.entry);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    syncFavorite() {
        this._pinBtn.checked = this.entry.isFavorite();
        this._pinBtn.get_child().set_icon_name(
            this.entry.isFavorite() ? 'starred-symbolic' : 'non-starred-symbolic');
    }
});

// ---- The clipboard tab content ----------------------------------------

export class ClipboardView {
    constructor({ manager, settings, registry, extension, onClosed, onClearAll }) {
        this.manager = manager;
        this.settings = settings;
        this.registry = registry;
        this.extension = extension;
        this.onClosed = onClosed;
        this.onClearAll = onClearAll;

        this._onlyFavorites = false;
        this._rows = new Map();
        this._dialogs = new DialogManager();
    }

    // Called when the tab becomes active: refresh + focus search.
    activate() { this._rebuildRows(); }

    build() {
        const box = new St.BoxLayout({ vertical: true, reactive: true });

        // Segmented control: Tudo | Fixado
        const tabs = new St.BoxLayout({ style_class: 'winv-tabs' });
        this._tabAll = this._makeTab('Tudo', false);
        this._tabFav = this._makeTab('Fixado', true);
        tabs.add_child(this._tabAll);
        tabs.add_child(this._tabFav);
        box.add_child(tabs);

        // Scroll list
        this._scrollView = new St.ScrollView({
            style_class: 'winv-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._list = new St.BoxLayout({ vertical: true, style_class: 'winv-history-section' });
        this._scrollView.add_child(this._list);
        box.add_child(this._scrollView);

        // Empty state
        this._empty = new St.BoxLayout({ vertical: true, style_class: 'winv-empty', visible: false });
        this._empty.add_child(new St.Label({
            text: 'Nada copiado ainda', style_class: 'winv-empty-title',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._empty.add_child(new St.Label({
            text: 'Copie algo (Ctrl+C) e aparecerá aqui.', style_class: 'winv-empty-hint',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(this._empty);

        // Footer with "clear all"
        const footer = new St.BoxLayout({ style_class: 'winv-footer' });
        const clearBtn = new St.Button({
            label: 'Limpar tudo',
            style_class: 'winv-clear-all button',
            can_focus: true,
        });
        clearBtn.connect('clicked', () => this._confirmClear());
        footer.add_child(clearBtn);
        box.add_child(footer);

        this.actor = box;
        this._rebuildRows();
        return box;
    }

    _makeTab(label, onlyFavorites) {
        const tab = new St.Button({
            label, style_class: 'winv-tab', can_focus: true, checked: !onlyFavorites,
        });
        tab.connect('clicked', () => {
            this._onlyFavorites = onlyFavorites;
            this._tabAll.checked = !onlyFavorites;
            this._tabFav.checked = onlyFavorites;
            this._applyFilter();
        });
        return tab;
    }

    // External filter hook (search box lives in the parent window).
    setFilter(query) {
        this._query = query || '';
        this._applyFilter();
    }

    _rebuildRows() {
        this._list.destroy_all_children();
        this._rows.clear();
        for (const entry of this.manager.entries) {
            const row = this._createRow(entry);
            this._list.add_child(row);
            this._rows.set(entry, row);
        }
        this._applyFilter();
    }

    _createRow(entry) {
        let thumbActor = null;
        if (entry.isImage()) {
            try {
                const file = GLib.file_new_for_path(this.registry.imageFilePath(entry));
                const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                thumbActor = St.TextureCache.get_default()
                    .load_file_async(file, 40, 40, scaleFactor, 1.0);
            } catch (e) {
                console.error('WinV thumb load:', e);
            }
        }
        const row = new HistoryRow(entry, thumbActor);
        row.connect('selected', (_r, e) => this._onSelected(e));
        row.connect('toggle-pin', (_r, e) => {
            this.manager.toggleFavorite(e);
            row.syncFavorite();
        });
        row.connect('deleted', (_r, e) => {
            this.manager.deleteEntry(e);
            this._list.remove_child(row);
            this._rows.delete(e);
            row.destroy();
            this._updateEmpty();
        });
        return row;
    }

    _applyFilter() {
        const q = (this._query || '').trim().toLowerCase();
        let visible = 0;
        for (const [entry, row] of this._rows) {
            let match = true;
            if (this._onlyFavorites && !entry.isFavorite()) match = false;
            if (match && q) match = entry.getStringValue().toLowerCase().includes(q);
            row.visible = match;
            if (match) visible++;
        }
        this._updateEmpty(visible);
    }

    _updateEmpty(visibleCount) {
        const n = visibleCount ?? [...this._rows.values()].filter(r => r.visible).length;
        const isEmpty = n === 0;
        this._scrollView.visible = !isEmpty;
        this._empty.visible = isEmpty;
    }

    _onSelected(entry) {
        this.manager.selectItem(entry)
            .then(() => {
                this.onClosed();
                if (this.settings.get_boolean('paste-on-select')) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                        this.extension.pasteIntoFocus();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            })
            .catch(e => console.error('WinV select:', e));
    }

    _confirmClear() {
        const doClear = () => {
            this.manager.clearAll()
                .then(() => this._rebuildRows())
                .catch(e => console.error('WinV clear:', e));
        };
        if (this.settings.get_boolean('confirm-clear')) {
            this._dialogs.open(
                'Limpar histórico?',
                'Todos os itens não fixados serão removidos.',
                'Limpar', 'Cancelar', doClear);
        } else {
            doClear();
        }
    }

    destroy() {
        this._dialogs.destroy();
    }
}
