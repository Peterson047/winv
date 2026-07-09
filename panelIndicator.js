// Top-bar indicator (PanelMenu.Button) for WinV.
//
// A small clipboard icon in the system status area. Click opens the popup at
// the clipboard tab; right-click opens preferences. Provides always-on
// discoverability (the user doesn't need to remember the shortcuts).

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const Indicator = GObject.registerClass(
class WinVIndicator extends PanelMenu.Button {
    _init() {
        // 0 = left-aligned menu; nameText used for a11y.
        super._init(0.0, 'WinV');

        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));
    }

    // Build the dropdown menu items.
    rebuildMenu({ onOpenClipboard, onOpenEmoji, onPreferences, onClearHistory }) {
        this.menu.removeAll();

        const itemClip = new PopupMenu.PopupMenuItem('Abrir área de transferência');
        itemClip.connect('activate', onOpenClipboard);
        this.menu.addMenuItem(itemClip);

        const itemEmoji = new PopupMenu.PopupMenuItem('Abrir emojis');
        itemEmoji.connect('activate', onOpenEmoji);
        this.menu.addMenuItem(itemEmoji);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const itemClear = new PopupMenu.PopupMenuItem('Limpar histórico');
        itemClear.connect('activate', onClearHistory);
        this.menu.addMenuItem(itemClear);

        const itemPrefs = new PopupMenu.PopupMenuItem('Preferências');
        itemPrefs.connect('activate', onPreferences);
        this.menu.addMenuItem(itemPrefs);
    }

    // Override: left-click should toggle the popup, not just open the menu.
    // We keep the menu for right-click / pointer behavior.
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_PRIMARY) {
            // Handled by the 'button-press-event' connection in setup().
            return Clutter.EVENT_PROPAGATE;
        }
        return super.vfunc_event(event);
    }
});

export class PanelIndicator {
    constructor(callbacks) {
        this._callbacks = callbacks;
        this._indicator = new Indicator();
    }

    init() {
        // Left-click toggles the clipboard popup (Windows-ish "open here").
        this._indicator.connect('button-press-event', (_i, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._callbacks.onOpenClipboard();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._indicator.rebuildMenu(this._callbacks);
    }

    get actor() { return this._indicator; }
    get menu() { return this._indicator.menu; }

    destroy() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
