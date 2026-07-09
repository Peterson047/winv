// Unified WinV window — hosts both the Clipboard tab and the Emoji tab in a
// single floating popup, exactly like Windows 11.
//
// Layout:
//   [Title ........................  ⚙  ✕]      <- header, title is drag handle
//   [ Clipboard ] [ Emoji ]                     <- tab switcher
//   [🔍 search]                                  <- shared search box (also draggable)
//   (tab content)
//
// Win+V opens with the Clipboard tab; Win+. opens with the Emoji tab.
// The search box is shared: in Clipboard mode it filters history, in Emoji
// mode it filters emojis. We rebuild content lazily when switching tabs.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ClipboardView } from './clipboardView.js';
import { EmojiView } from './emojiView.js';

const TAB_CLIPBOARD = 'clipboard';
const TAB_EMOJI = 'emoji';

export class WinvView {
    constructor({ manager, settings, registry, extension, popup, initialTab, emojiData, onClosed }) {
        this.manager = manager;
        this.settings = settings;
        this.registry = registry;
        this.extension = extension;
        this.popup = popup;
        this.onClosed = onClosed;
        this._emojiData = emojiData || [];

        this._activeTab = initialTab || TAB_CLIPBOARD;
        this._clipboardView = null;
        this._emojiView = null;
        this._contentArea = null;
    }

    build() {
        const box = new St.BoxLayout({ vertical: true, reactive: true, style_class: 'winv-popup' });

        // ---- Header ----
        const header = new St.BoxLayout({ style_class: 'winv-header' });
        const title = new St.Label({
            text: this._activeTab === TAB_EMOJI ? 'Emojis' : 'Área de Transferência',
            style_class: 'winv-title winv-drag-handle',
            reactive: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._makeDraggable(title);
        header.add_child(title);

        const settingsBtn = this._makeIconButton('emblem-system-symbolic', () => {
            this.onClosed();
            this.extension.openPreferences();
        });
        header.add_child(settingsBtn);

        const closeBtn = this._makeIconButton('window-close-symbolic', () => this.onClosed());
        header.add_child(closeBtn);
        box.add_child(header);

        // ---- Tab switcher (icon buttons, like Windows 11) ----
        const tabBar = new St.BoxLayout({ style_class: 'winv-tab-bar' });
        this._tabClipBtn = this._makeTabButton('edit-paste-symbolic', TAB_CLIPBOARD);
        this._tabEmojiBtn = this._makeTabButton('face-smile-symbolic', TAB_EMOJI);
        tabBar.add_child(this._tabClipBtn);
        tabBar.add_child(this._tabEmojiBtn);
        box.add_child(tabBar);

        // ---- Shared search ----
        this._search = new St.Entry({
            style_class: 'winv-search search-entry winv-drag-handle',
            can_focus: true,
            hint_text: this._activeTab === TAB_EMOJI ? 'Pesquisar emoji…' : 'Pesquisar itens copiados…',
            track_hover: true,
            x_expand: true,
            reactive: true,
        });
        this._search.set_primary_icon(new St.Icon({ icon_name: 'edit-find-symbolic', icon_size: 16 }));
        this._search.get_clutter_text().connect('text-changed', () => this._onSearchChanged());
        this._makeDraggable(this._search);
        box.add_child(this._search);

        // ---- Content area (tab content goes here) ----
        this._contentArea = new St.BoxLayout({ vertical: true, reactive: true });
        box.add_child(this._contentArea);

        this.actor = box;
        this._renderActiveTab();
        global.stage.set_key_focus(this._search);

        return box;
    }

    _makeIconButton(iconName, onClick) {
        const btn = new St.Button({
            style_class: 'winv-header-btn',
            can_focus: true,
            child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    _makeTabButton(iconName, tabId) {
        const btn = new St.Button({
            style_class: 'winv-tab winv-tab-icon',
            can_focus: true,
            checked: this._activeTab === tabId,
            child: new St.Icon({ icon_name: iconName, icon_size: 18 }),
        });
        btn.connect('clicked', () => this._switchTab(tabId));
        return btn;
    }

    // Lazily build the requested tab into the content area.
    _renderActiveTab() {
        this._contentArea.destroy_all_children();
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
            this._contentArea.add_child(content);
        } else {
            this._emojiView = new EmojiView({
                extension: this.extension,
                settings: this.settings,
                onClosed: this.onClosed,
                makeDraggable: (a) => this._makeDraggable(a),
            });
            this._emojiView._all = this._emojiData;
            const content = this._emojiView.build();
            this._contentArea.add_child(content);
            this._emojiView._query = this._search.get_text();
            this._emojiView._populate();
        }
    }

    _switchTab(tabId) {
        if (this._activeTab === tabId) return;
        // Tear down the previous tab.
        if (this._clipboardView) { this._clipboardView.destroy(); this._clipboardView = null; }
        if (this._emojiView)     { this._emojiView.destroy();     this._emojiView = null; }

        this._activeTab = tabId;
        this._tabClipBtn.checked = tabId === TAB_CLIPBOARD;
        this._tabEmojiBtn.checked = tabId === TAB_EMOJI;

        // Update search hint + clear search for a clean slate.
        this._search.set_text('');
        this._search.hint_text = tabId === TAB_EMOJI ? 'Pesquisar emoji…' : 'Pesquisar itens copiados…';

        this._renderActiveTab();
        global.stage.set_key_focus(this._search);
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

    // Drag handle wiring: press on the actor -> hand off to popup.beginDrag.
    // The grab/grabbing cursor is applied via CSS (St widgets have no set_cursor).
    _makeDraggable(actor) {
        if (actor._winvDragWired) return;
        actor._winvDragWired = true;
        actor.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            actor.add_style_pseudo_class('dragging');
            this.popup?.beginDrag(actor, x, y);
            return Clutter.EVENT_STOP;
        });
    }

    destroy() {
        if (this._clipboardView) { this._clipboardView.destroy(); this._clipboardView = null; }
        if (this._emojiView)     { this._emojiView.destroy();     this._emojiView = null; }
    }
}
