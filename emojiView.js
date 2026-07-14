// Emoji picker tab content — embedded in the unified window (winvView.js),
// which provides the shared search entry. This view renders the category bar
// and the scrollable emoji grid only.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { EMOJI_GRID_COLUMNS } from './constants.js';

// Category icons. We use the Adwaita "emoji-*" symbolic set, which is shipped
// since GNOME 46 and maps 1:1 to Unicode CLDR categories — so every category
// has a guaranteed-present icon (the previous generic names like 'food-symbolic'
// or 'flag-symbolic' don't exist outside GNOME 50).
const CATEGORY_ICONS = {
    'Smileys & Body':     'emoji-people-symbolic',
    'Animals & Nature':   'emoji-nature-symbolic',
    'Food & Drink':       'emoji-food-symbolic',
    'Travel & Places':    'emoji-travel-symbolic',
    'Activities':         'emoji-activities-symbolic',
    'Objects':            'emoji-objects-symbolic',
    'Symbols':            'emoji-symbols-symbolic',
    'Flags':              'emoji-flags-symbolic',
};

const EmojiCell = GObject.registerClass({
    GTypeName: 'WinVEmojiCell',
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
    constructor({ extension, settings, onClosed, makeDraggable, searchEntry }) {
        this.extension = extension;
        this.settings = settings;
        this.onClosed = onClosed;
        this.makeDraggable = makeDraggable;
        this.searchEntry = searchEntry; // shared with the parent window

        this._all = [];
        this._query = '';
        this._category = null; // null = all / search results
    }

    build() {
        const box = new St.BoxLayout({ vertical: true, reactive: true, y_expand: true });

        // Recent emojis row (top, like Windows 11). Hidden until there are any.
        this._recentRow = new St.BoxLayout({
            style_class: 'winv-recent-row',
            visible: false,
        });
        box.add_child(this._recentRow);

        // Category bar (also a drag handle). Wrapped in a horizontal ScrollView
        // so the nine category buttons scroll instead of overflowing the popup
        // when they don't all fit in 320px (GNOME 46 / small windows).
        const catBar = new St.BoxLayout({
            style_class: 'winv-category-bar winv-drag-handle',
            reactive: true,
        });
        if (this.makeDraggable) this.makeDraggable(catBar);
        this._catBar = catBar;
        this._buildCategoryBar();
        this._catScroll = new St.ScrollView({
            style_class: 'winv-category-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
        });
        this._catScroll.add_child(catBar);
        box.add_child(this._catScroll);

        // Scrollable grid area.
        this._scrollView = new St.ScrollView({
            style_class: 'winv-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._gridContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'winv-emoji-grid-wrapper',
            x_expand: true,
        });
        this._scrollView.add_child(this._gridContainer);
        box.add_child(this._scrollView);

        this.actor = box;
        this._populate();
        this._refreshRecent();

        return box;
    }

    _buildCategoryBar() {
        const allBtn = this._makeCategoryButton(null, 'edit-find-symbolic');
        allBtn.checked = true;
        this._catBar.add_child(allBtn);
        this._catAll = allBtn;

        this._catButtons = {};
        const cats = [...new Set(this._all.map(e => e.category))];
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
            this._catAll.checked = (category === null);
            for (const [c, b] of Object.entries(this._catButtons))
                b.checked = (c === category);
            // Clear the shared search so the category filter takes effect.
            if (this.searchEntry) this.searchEntry.set_text('');
            this._query = '';
            this._populate();
        });
        return btn;
    }

    _visibleEmojis() {
        const q = this._query.trim().toLowerCase();
        if (q) {
            return this._all.filter(e =>
                e.lowerKeywords && e.lowerKeywords.some(k => k.includes(q)));
        }
        if (this._category) return this._all.filter(e => e.category === this._category);
        return this._all;
    }

    _populate() {
        this._gridContainer.destroy_all_children();
        const visible = this._visibleEmojis();
        if (!visible.length) {
            this._gridContainer.add_child(new St.Label({
                text: _('Nenhum emoji encontrado'),
                style_class: 'winv-empty-hint',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        // Render grouped by category when no query; flat when searching.
        // Cap rendering at 70 emojis per category (grouped view) and 140 emojis
        // (search results or specific category) to avoid thread blocks.
        let groups;
        if (this._query.trim()) {
            groups = [{ name: null, items: visible.slice(0, 140) }];
        } else {
            const order = [...new Set(this._all.map(e => e.category))];
            const maxItems = this._category ? 140 : 70;
            groups = order
                .map(name => ({
                    name,
                    items: visible.filter(e => e.category === name).slice(0, maxItems)
                }))
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
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
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
        // Track as recent BEFORE closing (so the row updates on next open too).
        this.extension.pushRecentEmoji(emoji);
        // GNOME reality: the PopupMenu modal grab prevents reliable paste into
        // the focused app while open. So we close the picker first (which
        // restores keyboard focus to the target app), then commit text — same
        // pattern clipboard-indicator uses. commitEmoji() handles the timing.
        this.extension.commitEmoji(emoji.char, () => this.onClosed());
    }

    _refreshRecent() {
        if (!this._recentRow) return;
        this._recentRow.destroy_all_children();
        const recent = this.extension.recentEmojis;
        if (!recent.length) {
            this._recentRow.visible = false;
            return;
        }
        this._recentRow.visible = true;
        for (const emoji of recent) {
            const cell = new EmojiCell(emoji);
            cell.connect('selected', (_c, e) => this._onSelected(e));
            this._recentRow.add_child(cell);
        }
    }

    setData(data) {
        this._all = data || [];
        if (this._catBar) {
            this._catBar.destroy_all_children();
            this._buildCategoryBar();
        }
    }

    setQuery(query) {
        this._query = query || '';
        this._populate();
    }

    refresh() {
        this._populate();
        this._refreshRecent();
    }

    destroy() {}
}
