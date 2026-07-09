// Unified WinV content — built into a PopupMenu.PopupMenu (owned by the
// PanelMenu.Button indicator). This is NOT a standalone popup; it adds menu
// items (header, tabs, search, content) to the menu it's given.
//
// PopupMenu handles modal grab, keyboard nav, Esc, and click-outside — so we
// don't manage any of that here. We just lay out the widgets.
//
// Layout added to the menu (top to bottom):
//   [header: drag-title .......... ⚙ ✕]
//   [tab switcher: 📋 clipboard | 😀 emoji]
//   [shared search entry]
//   [content area: clipboard list OR emoji grid]

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

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

// A non-interactive menu item that just holds an arbitrary actor. Used to embed
// our custom St widgets (header, tab bar, search, content) into the PopupMenu.
const ActorMenuItem = GObject.registerClass(
class ActorMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(actor, { reactive } = {}) {
        super._init({ reactive: !!reactive, can_focus: !!reactive, hover: false });
        this.add_child(actor);
    }
});

export class WinvContent {
    constructor({ manager, settings, registry, extension, popup, emojiData, onClosed }) {
        this.manager = manager;
        this.settings = settings;
        this.registry = registry;
        this.extension = extension;
        this.popup = popup;       // the PanelMenu.Button (for drag)
        this.onClosed = onClosed;
        this._emojiData = emojiData || [];

        this._activeTab = TAB_CLIPBOARD;
        this._clipboardView = null;
        this._emojiView = null;
    }

    // Build everything into the given PopupMenu.
    buildInto(menu) {
        this._menu = menu;

        // ---- Top bar: tab icons (left) + settings/close (right) ----
        // Minimalist, like Windows 11: no title, just icon tabs + a few actions.
        // The whole top bar is the drag handle.
        const topBar = new St.BoxLayout({ style_class: 'winv-topbar winv-drag-handle', reactive: true });
        this._makeDraggable(topBar);

        this._tabClipBtn = this._tabButton(TAB_CLIPBOARD);
        this._tabEmojiBtn = this._tabButton(TAB_EMOJI);
        topBar.add_child(this._tabClipBtn);
        topBar.add_child(this._tabEmojiBtn);

        // Spacer pushes actions to the right.
        topBar.add_child(new St.Widget({ x_expand: true }));

        const settingsBtn = this._iconButton('emblem-system-symbolic', () => {
            this.onClosed();
            this.extension.openPreferences();
        });
        topBar.add_child(settingsBtn);

        const closeBtn = this._iconButton('window-close-symbolic', () => this.onClosed());
        topBar.add_child(closeBtn);
        menu.addMenuItem(new ActorMenuItem(topBar));

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
        this._searchItem = new ActorMenuItem(this._search);
        this._searchItem.actor.visible = false; // hidden on clipboard tab
        menu.addMenuItem(this._searchItem);

        // ---- Content area (one section we swap children of) ----
        this._contentSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._contentSection);

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

        // Tear down previous tab.
        if (this._clipboardView) { this._clipboardView.destroy(); this._clipboardView = null; }
        if (this._emojiView)     { this._emojiView.destroy();     this._emojiView = null; }

        this._activeTab = tabId;
        this._tabClipBtn.checked = tabId === TAB_CLIPBOARD;
        this._tabEmojiBtn.checked = tabId === TAB_EMOJI;

        // Search is only shown on the emoji tab (Windows 11 style).
        this._search.set_text('');
        this._searchItem.actor.visible = (tabId === TAB_EMOJI);

        this._renderActiveTab();
    }

    _renderActiveTab() {
        // Destroy any actors previously added to the content section. We can't
        // use section.removeAll() because we add raw St actors (not PopupMenu
        // items), so the two APIs would desync and leave stale content behind.
        this._contentSection.actor.destroy_all_children();
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
            this._contentSection.actor.add_child(content);
        } else {
            this._emojiView = new EmojiView({
                extension: this.extension,
                settings: this.settings,
                onClosed: this.onClosed,
                searchEntry: this._search,
            });
            this._emojiView._all = this._emojiData;
            const content = this._emojiView.build();
            this._contentSection.actor.add_child(content);
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

    // Drag handle: on press, hand off to the indicator's menu-less drag helper.
    // (We keep drag simple: pressing+moving the title nudges the menu actor.)
    _makeDraggable(actor) {
        if (actor._winvDragWired) return;
        actor._winvDragWired = true;
        let dragging = false, lastX = 0, lastY = 0;
        actor.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            [lastX, lastY] = event.get_coords();
            dragging = true;
            return Clutter.EVENT_STOP;
        });
        global.stage.connect('captured-event', (_s, event) => {
            if (!dragging) return Clutter.EVENT_PROPAGATE;
            if (event.type() === Clutter.EventType.MOTION) {
                const [x, y] = event.get_coords();
                const dx = x - lastX, dy = y - lastY;
                lastX = x; lastY = y;
                this._nudgeMenu(dx, dy);
                return Clutter.EVENT_STOP;
            }
            if (event.type() === Clutter.EventType.BUTTON_RELEASE) {
                dragging = false;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Move the open menu by (dx, dy), clamped to the current monitor.
    _nudgeMenu(dx, dy) {
        const actor = this._menu.actor;
        if (!actor) return;
        let [x, y] = actor.get_position();
        x += dx; y += dy;
        const monitor = Main.layoutManager.currentMonitor;
        const w = actor.width, h = actor.height;
        const M = 8;
        x = Math.max(monitor.x + M, Math.min(x, monitor.x + monitor.width - w - M));
        y = Math.max(monitor.y + M, Math.min(y, monitor.y + monitor.height - h - M));
        actor.set_position(x, y);
    }

    destroy() {
        if (this._clipboardView) { this._clipboardView.destroy(); this._clipboardView = null; }
        if (this._emojiView)     { this._emojiView.destroy();     this._emojiView = null; }
    }
}
