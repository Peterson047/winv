// Clipboard history tab content (the list of copied items).
//
// This is embedded inside the unified window (winvView.js) which provides the
// header / tab bar / search-or-not. Here we render: the scrollable list of rows
// (preview + timestamp + pin + delete), the empty state, and the "clear all"
// footer action.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
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
}, class HistoryRow extends St.Button {
    // Using St.Button (not St.BoxLayout) gives a reliable 'clicked' signal for
    // selection. Child action buttons (pin/delete) are themselves St.Buttons,
    // which capture their own clicks — so clicking them does NOT bubble up to
    // this row's clicked handler. No fragile get_source() filtering needed.
    _init(entry, thumbActor) {
        super._init({
            style_class: 'winv-row',
            reactive: true,
            can_focus: true,
            x_expand: true,
        });
        // St.Button renders a single 'label' by default; we manage our own
        // children, so use a horizontal box as the button's content. The box
        // must fill the button width so children distribute correctly (without
        // x_fill they'd center instead of left-align, breaking the layout).
        const content = new St.BoxLayout({
            style_class: 'winv-row-inner',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        this.set_child(content);

        // Left: thumbnail (images) or icon (text)
        if (thumbActor) {
            // TextureCache returns a Clutter.Actor (not St.Widget), which has
            // no add_style_class_name. Wrap it in an St.Bin for styling.
            const thumbWrap = new St.Bin({ style_class: 'winv-thumb', child: thumbActor });
            content.add_child(thumbWrap);
        } else {
            content.add_child(new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'popup-menu-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const preview = new St.Label({
            text: truncate(entry.getStringValue(), ROW_PREVIEW_CHARS),
            style_class: 'winv-row-preview',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        preview.clutter_text.set_line_wrap(false);
        preview.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        content.add_child(preview);

        // Right-aligned, fixed-width meta cluster: time + pin + delete.
        // These must not shift with text length, so they sit after the
        // expanding preview with their own fixed sizes.
        const meta = new St.BoxLayout({ style_class: 'winv-meta', y_align: Clutter.ActorAlign.CENTER });
        meta.add_child(new St.Label({
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
        });
        pinBtn.connect('clicked', () => { this.emit('toggle-pin', this.entry); });
        meta.add_child(pinBtn);

        const delBtn = new St.Button({
            style_class: 'winv-action-btn',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'popup-menu-icon',
            }),
        });
        delBtn.connect('clicked', () => { this.emit('deleted', this.entry); });
        meta.add_child(delBtn);

        content.add_child(meta);

        this.entry = entry;
        this._pinBtn = pinBtn;
        this._delBtn = delBtn;

        // Row-level 'clicked' (body, not the action buttons) selects the item.
        // Child St.Buttons consume their own clicks, so this only fires when the
        // click lands on the row itself.
        this.connect('clicked', () => this.emit('selected', this.entry));
        this.connect('key-focus-in', () => {}); // keep focus ring
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

        this._disconnectManager = this.manager.connect(() => {
            if (this.actor && this.actor.visible) {
                this._rebuildRows();
            }
        });
    }

    // Called when the tab becomes active: refresh + focus search.
    activate() { this._rebuildRows(); }

    build() {
        const box = new St.BoxLayout({ vertical: true, reactive: true, y_expand: true });

        // Control bar: "Tudo | Fixado" on the left, "Limpar tudo" on the right.
        // Collapsing the footer into this row saves vertical space.
        const controlBar = new St.BoxLayout({ style_class: 'winv-tabs' });
        this._tabAll = this._makeTab('Tudo', false);
        this._tabFav = this._makeTab('Fixado', true);
        controlBar.add_child(this._tabAll);
        controlBar.add_child(this._tabFav);
        // Expander pushes the clear button to the far right.
        controlBar.add_child(new St.Widget({ x_expand: true }));
        const clearBtn = new St.Button({
            label: 'Limpar tudo',
            style_class: 'winv-clear-all button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        clearBtn.connect('clicked', () => this._confirmClear());
        controlBar.add_child(clearBtn);
        box.add_child(controlBar);

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
                const file = Gio.File.new_for_path(this.registry.imageFilePath(entry));
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
                // Close FIRST so the modal grab is released and focus returns
                // to the target app before we synthesize Ctrl+V.
                this.onClosed();
                if (this.settings.get_boolean('paste-on-select')) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
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

    refresh() {
        this._rebuildRows();
    }

    destroy() {
        if (this._disconnectManager) {
            this._disconnectManager();
            this._disconnectManager = null;
        }
        this._dialogs.destroy();
    }
}
