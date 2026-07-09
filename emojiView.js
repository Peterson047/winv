// Emoji picker view — embedded in the same popup as the clipboard view.
//
// Loads emoji.json (bundled with the extension: char + keywords + category),
// shows a search entry, a category selector bar, and a scrollable grid.
// Clicking an emoji copies it to the clipboard and (if enabled) pastes it
// into the previously focused app via the synthetic keyboard.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { EMOJI_GRID_COLUMNS } from './constants.js';

// Category icons (symbolic names available on GNOME 50).
const CATEGORY_ICONS = {
    'Smileys & Body':     'face-smile-symbolic',
    'Animals & Nature':   'face-monkey-symbolic',
    'Food & Drink':       'food-symbolic',
    'Travel & Places':    'mark-location-symbolic',
    'Activities':         'preferences-desktop-screensaver-symbolic',
    'Objects':            'preferences-system-windows-symbolic',
    'Symbols':            'emoji-symbols-symbolic',
    'Flags':              'flag-symbolic',
};

const EmojiCell = GObject.registerClass({
    Signals: {
        'selected': { param_types: [GObject.TYPE_JSOBJECT] },
    },
}, class EmojiCell extends St.Button {
    _init(emoji) {
        super._init({
            label: emoji.char,
            style_class: 'winv-emoji-cell',
            can_focus: true,
        });
        this.emoji = emoji;
        this.connect('clicked', () => this.emit('selected', this.emoji));
    }
});

export class EmojiView {
    constructor({ extension, settings, onClosed, makeDraggable }) {
        this.extension = extension;
        this.settings = settings;
        this.onClosed = onClosed;
        this.makeDraggable = makeDraggable;

        this._all = [];
        this._query = '';
        this._category = null; // null = all / search results
    }

    async load() {
        if (this._all.length) return;
        try {
            const path = `${this.extension.path}/emoji.json`;
            const file = Gio.file_new_for_path(path);
            const [ok, bytes] = await new Promise(resolve =>
                file.load_contents_async(null, (obj, res) =>
                    resolve(obj.load_contents_finish(res))));
            if (!ok) { console.error('WinV: emoji.json read failed'); return; }
            const text = new TextDecoder().decode(bytes);
            this._all = JSON.parse(text);
        } catch (e) {
            console.error('WinV: emoji.json load error:', e);
        }
    }

    build() {
        const box = new St.BoxLayout({ vertical: true, reactive: true });

        // Search entry (also a drag handle).
        this._search = new St.Entry({
            style_class: 'winv-search search-entry winv-drag-handle',
            can_focus: true,
            hint_text: 'Pesquisar emoji…',
            track_hover: true,
            x_expand: true,
            reactive: true,
        });
        this._search.set_primary_icon(new St.Icon({ icon_name: 'edit-find-symbolic', icon_size: 16 }));
        this._search.get_clutter_text().connect('text-changed', () => {
            this._query = this._search.get_text();
            this._populate();
        });
        if (this.makeDraggable) this.makeDraggable(this._search);
        box.add_child(this._search);

        // Category bar.
        const catBar = new St.BoxLayout({
            style_class: 'winv-category-bar winv-drag-handle',
            reactive: true,
        });
        if (this.makeDraggable) this.makeDraggable(catBar);
        this._catBar = catBar;
        this._buildCategoryBar();
        box.add_child(catBar);

        // Scrollable grid area.
        this._scrollView = new St.ScrollView({
            style_class: 'winv-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._gridContainer = new St.BoxLayout({ vertical: true, style_class: 'winv-emoji-grid-wrapper' });
        this._scrollView.add_child(this._gridContainer);
        box.add_child(this._scrollView);

        this.actor = box;
        this._populate();

        // Focus search so the user can type right away.
        global.stage.set_key_focus(this._search);

        return box;
    }

    _buildCategoryBar() {
        // "All" button
        const allBtn = this._makeCategoryButton(null, 'edit-find-symbolic');
        allBtn.checked = true;
        this._catBar.add_child(allBtn);
        this._catAll = allBtn;

        const cats = [...new Set(this._all.map(e => e.category))];
        this._catButtons = {};
        for (const cat of cats) {
            const iconName = CATEGORY_ICONS[cat] || 'emoji-symbols-symbolic';
            const btn = this._makeCategoryButton(cat, iconName);
            this._catBar.add_child(btn);
            this._catButtons[cat] = btn;
        }
    }

    _makeCategoryButton(category, iconName) {
        const btn = new St.Button({
            style_class: 'winv-category-btn',
            can_focus: true,
            toggle_mode: true,
            child: new St.Icon({ icon_name: iconName, icon_size: 18 }),
        });
        btn.connect('clicked', () => {
            this._category = category;
            // Sync toggle state
            this._catAll.checked = (category === null);
            for (const [c, b] of Object.entries(this._catButtons)) b.checked = (c === category);
            this._search.set_text('');
            this._query = '';
            this._populate();
        });
        return btn;
    }

    _visibleEmojis() {
        const q = this._query.trim().toLowerCase();
        if (q) {
            // Search across all categories when there's a query.
            return this._all.filter(e =>
                e.keywords.some(k => k.toLowerCase().includes(q)));
        }
        if (this._category) return this._all.filter(e => e.category === this._category);
        return this._all;
    }

    _populate() {
        this._gridContainer.destroy_all_children();
        const visible = this._visibleEmojis();
        if (!visible.length) {
            this._gridContainer.add_child(new St.Label({
                text: 'Nenhum emoji encontrado',
                style_class: 'winv-empty-hint',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        // Render grouped by category when no query; flat when searching.
        let groups;
        if (this._query.trim()) {
            groups = [{ name: null, items: visible }];
        } else {
            const order = [...new Set(this._all.map(e => e.category))];
            groups = order
                .map(name => ({ name, items: visible.filter(e => e.category === name) }))
                .filter(g => g.items.length);
        }

        for (const group of groups) {
            if (group.name) {
                this._gridContainer.add_child(new St.Label({
                    text: group.name,
                    style_class: 'winv-emoji-group-title',
                }));
            }
            const grid = new St.Widget({
                layout_manager: new Clutter.GridLayout({ orientation: Clutter.Orientation.HORIZONTAL }),
                style_class: 'winv-emoji-grid',
            });
            const layout = grid.layout_manager;
            let col = 0, row = 0;
            for (const emoji of group.items) {
                const cell = new EmojiCell(emoji);
                cell.connect('selected', (_c, e) => this._onSelected(e));
                layout.attach(cell, col, row, 1, 1);
                if (++col >= EMOJI_GRID_COLUMNS) { col = 0; row++; }
            }
            this._gridContainer.add_child(grid);
        }
    }

    _onSelected(emoji) {
        // Copy emoji to clipboard and auto-paste (Win11 behavior).
        this.extension.copyAndPaste(emoji.char)
            .then(() => this.onClosed())
            .catch(e => console.error('WinV emoji select:', e));
    }

    destroy() {}
}
