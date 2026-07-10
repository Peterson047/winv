// Unified WinV content — built into a PopupMenu.PopupMenu (owned by the
// PanelMenu.Button indicator). PopupMenu handles modal grab, keyboard nav,
// Esc, and click-outside; we just lay out widgets directly in menu.box.
//
// We do NOT use PopupBaseMenuItem/ActorMenuItem to wrap our custom widgets,
// because PopupBaseMenuItem injects an ornament icon and a ClickGesture that
// desalign and interfere with our own buttons. Instead we add raw St actors
// straight to menu.box — the same St.BoxLayout the menu uses for its items.
//
// Layout (top to bottom in menu.box):
//   [top bar: 📋 😀 ............ ⚙ ✕]   <- drag handle + actions
//   [search entry]                       <- emoji tab only
//   [content: clipboard list OR emoji grid]

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { ClipboardView } from './clipboardView.js';
import { EmojiView } from './emojiView.js';

const TAB_CLIPBOARD = 'clipboard';
const TAB_EMOJI = 'emoji';

const TAB_ICONS = {
    [TAB_CLIPBOARD]: 'edit-paste-symbolic',
    [TAB_EMOJI]:     'face-smile-symbolic',
};

export class WinvContent {
    constructor({ manager, settings, registry, extension, popup, emojiData, onClosed }) {
        this.manager = manager;
        this.settings = settings;
        this.registry = registry;
        this.extension = extension;
        this.popup = popup;
        this.onClosed = onClosed;
        this._emojiData = emojiData || [];

        this._activeTab = TAB_CLIPBOARD;
        this._clipboardView = null;
        this._emojiView = null;
    }

    buildInto(menu) {
        this._menu = menu;

        // ---- Top bar: tab icons (left) + settings/close (right) ----
        const topBar = new St.BoxLayout({ style_class: 'winv-topbar winv-drag-handle' });
        this._makeDraggable(topBar);

        this._tabClipBtn = this._tabButton(TAB_CLIPBOARD);
        this._tabEmojiBtn = this._tabButton(TAB_EMOJI);
        topBar.add_child(this._tabClipBtn);
        topBar.add_child(this._tabEmojiBtn);

        // Expander fills the space between tabs and the right-side actions.
        topBar.add_child(new St.Widget({ x_expand: true }));

        topBar.add_child(this._iconButton('emblem-system-symbolic', () => {
            this.onClosed();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this.extension.openPreferences();
                return GLib.SOURCE_REMOVE;
            });
        }));
        topBar.add_child(this._iconButton('window-close-symbolic', () => this.onClosed()));

        menu.box.add_child(topBar);

        // ---- Conditional search (emoji tab only; clipboard has none, like Win11) ----
        this._search = new St.Entry({
            style_class: 'winv-search search-entry',
            can_focus: true,
            hint_text: 'Pesquisar emoji…',
            track_hover: true,
            x_expand: true,
        });
        this._search.set_primary_icon(new St.Icon({ icon_name: 'edit-find-symbolic', icon_size: 16 }));
        this._search.get_clutter_text().connect('text-changed', () => this._onSearchChanged());
        this._search.visible = false; // hidden on clipboard tab
        menu.box.add_child(this._search);

        // ---- Content area ----
        this._contentBox = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        menu.box.add_child(this._contentBox);

        this._renderActiveTab();

        // Focus the search shortly after the menu opens (emoji tab only).
        menu.connect('open-state-changed', (_m, isOpen) => {
            if (isOpen)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                    if (this._activeTab === TAB_EMOJI)
                        global.stage.set_key_focus(this._search);
                    return GLib.SOURCE_REMOVE;
                });
        });
    }

    _iconButton(iconName, onClick) {
        const btn = new St.Button({
            style_class: 'winv-header-btn',
            can_focus: true,
            child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    _tabButton(tabId) {
        const btn = new St.Button({
            style_class: 'winv-tab winv-tab-icon',
            can_focus: true,
            checked: this._activeTab === tabId,
            child: new St.Icon({ icon_name: TAB_ICONS[tabId], icon_size: 18 }),
        });
        btn.connect('clicked', () => this.switchTab(tabId));
        return btn;
    }

    switchTab(tabId) {
        if (this._activeTab === tabId && (this._clipboardView || this._emojiView)) return;

        if (this._clipboardView) { this._clipboardView.destroy(); this._clipboardView = null; }
        if (this._emojiView)     { this._emojiView.destroy();     this._emojiView = null; }

        this._activeTab = tabId;
        this._tabClipBtn.checked = tabId === TAB_CLIPBOARD;
        this._tabEmojiBtn.checked = tabId === TAB_EMOJI;

        // Search is only shown on the emoji tab (Windows 11 style).
        this._search.set_text('');
        this._search.visible = (tabId === TAB_EMOJI);

        this._renderActiveTab();
    }

    _renderActiveTab() {
        this._contentBox.destroy_all_children();
        if (this._activeTab === TAB_CLIPBOARD) {
            this._clipboardView = new ClipboardView({
                manager: this.manager,
                settings: this.settings,
                registry: this.registry,
                extension: this.extension,
                onClosed: this.onClosed,
            });
            const content = this._clipboardView.build();
            this._clipboardView.setFilter(this._search.get_text());
            this._contentBox.add_child(content);
        } else {
            this._emojiView = new EmojiView({
                extension: this.extension,
                settings: this.settings,
                onClosed: this.onClosed,
                searchEntry: this._search,
            });
            this._emojiView._all = this._emojiData;
            const content = this._emojiView.build();
            this._contentBox.add_child(content);
            this._emojiView._query = this._search.get_text();
            this._emojiView._populate();
        }
    }

    _onSearchChanged() {
        const text = this._search.get_text();
        if (this._activeTab === TAB_CLIPBOARD && this._clipboardView) {
            this._clipboardView.setFilter(text);
        } else if (this._activeTab === TAB_EMOJI && this._emojiView) {
            this._emojiView._query = text;
            this._emojiView._populate();
        }
    }

    // Drag: press on the top bar -> track motion on the stage until release.
    _makeDraggable(actor) {
        if (actor._winvDragWired) return;
        actor._winvDragWired = true;

        actor.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [startX, startY] = event.get_coords();
            const dragId = global.stage.connect('captured-event', (_s, ev) => {
                const type = ev.type();
                if (type === Clutter.EventType.MOTION) {
                    const [x, y] = ev.get_coords();
                    this._nudgeMenu(x - startX, y - startY, startX, startY);
                    return Clutter.EVENT_STOP;
                }
                if (type === Clutter.EventType.BUTTON_RELEASE) {
                    global.stage.disconnect(dragId);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_STOP;
        });
    }

    // Reposition the open menu, clamped to monitor. Guard against destroyed menu.
    _nudgeMenu(dx, dy, startX, startY) {
        if (!this._menu || !this._menu.isOpen) return;
        const actor = this._menu.actor;
        if (!actor) return;
        let x = startX + dx, y = startY + dy;
        const monitor = Main.layoutManager.currentMonitor;
        const w = actor.width || 0, h = actor.height || 0;
        const M = 8;
        x = Math.max(monitor.x + M, Math.min(x, monitor.x + monitor.width - w - M));
        y = Math.max(monitor.y + M, Math.min(y, monitor.y + monitor.height - h - M));
        try { actor.set_position(x, y); } catch (e) { /* mid-teardown */ }
    }

    destroy() {
        if (this._clipboardView) { this._clipboardView.destroy(); this._clipboardView = null; }
        if (this._emojiView)     { this._emojiView.destroy();     this._emojiView = null; }
    }
}
