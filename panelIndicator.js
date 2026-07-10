// Top-bar indicator AND popup host for WinV.
//
// This is the single component that owns the menu. It extends PanelMenu.Button
// (which gives us `this.menu`, a PopupMenu.PopupMenu) and builds the clipboard
// + emoji UI inside it. PopupMenu manages the modal grab, keyboard focus, Esc,
// and click-outside-to-close automatically — that's why we use it instead of a
// hand-rolled St.Widget popup (which kept breaking the grab state).
//
// Opening at the cursor (Windows-style) uses the _cursorActor trick from
// clipboard-indicator: a 1x1 invisible actor we move to the pointer and set as
// the menu's sourceActor right before opening.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { POPUP_WIDTH, POPUP_MAX_HEIGHT } from './constants.js';
import { WinvContent } from './winvView.js';

export const WinVIndicator = GObject.registerClass(
class WinVIndicator extends PanelMenu.Button {
    _init() {
        // 0.5 = center-aligned; nameText for a11y. dontCreateMenu=false (default).
        super._init(0.5, 'WinV');

        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        // Invisible 1x1 actor we reposition to the pointer so the PopupMenu
        // (which opens relative to its sourceActor) appears at the cursor.
        this._cursorActor = new Clutter.Actor({ opacity: 0, width: 1, height: 1 });
        Main.uiGroup.add_child(this._cursorActor);

        // On close, restore the sourceActor to the button itself so the menu
        // doesn't try to position relative to a stale cursor location next time.
        this.menu.connect('open-state-changed', (_m, isOpen) => {
            if (!isOpen) this.menu.sourceActor = this;
        });

        this._content = null;  // built lazily on first open
    }

    // Build (or rebuild) the menu contents: header + tab bar + shared search +
    // content area. Called once on first open.
    _ensureContent(context) {
        if (this._content) return;
        this._content = new WinvContent(context);
        this._content.buildInto(this.menu);
    }

    // Open the menu at the pointer with the given tab selected.
    openAtCursor(tab, context) {
        this._ensureContent(context);
        this._content.switchTab(tab);

        // Fixed size (like Windows 11): both tabs show the same-size window.
        // Constraints go on this.menu.box (the inner St.BoxLayout that holds
        // the menu items), NOT on the BoxPointer — it sizes itself around .bin
        // so actor-level constraints don't propagate.
        const monitor = Main.layoutManager.currentMonitor;
        const fixedHeight = Math.min(POPUP_MAX_HEIGHT, monitor.height - 24);
        this.menu.box.set_style(
            `min-width: ${POPUP_WIDTH}px; max-width: ${POPUP_WIDTH}px;` +
            `min-height: ${fixedHeight}px; max-height: ${fixedHeight}px;`);

        // Position the popup at the cursor (Windows-style) by repointing the
        // sourceActor. Clamp the anchor point so the popup won't open with its
        // bottom past the screen edge (which would push it off-screen).
        if (context.settings.get_boolean('open-at-cursor')) {
            const [px, py] = global.get_pointer();
            // The menu opens with its top-left at the sourceActor, so if the
            // cursor is near the bottom edge, anchor higher up.
            const anchorY = Math.min(py, monitor.y + monitor.height - fixedHeight - 8);
            const anchorX = Math.min(px, monitor.x + monitor.width - POPUP_WIDTH - 8);
            this._cursorActor.set_position(Math.max(anchorX, monitor.x + 8),
                                           Math.max(anchorY, monitor.y + 8));
            this.menu.sourceActor = this._cursorActor;
        }

        this.menu.open();
    }

    close() {
        if (this.menu.isOpen) this.menu.close();
    }

    get isOpen() { return this.menu.isOpen; }

    destroy() {
        if (this._content) { this._content.destroy(); this._content = null; }
        if (this._cursorActor) {
            Main.uiGroup.remove_child(this._cursorActor);
            this._cursorActor.destroy();
            this._cursorActor = null;
        }
        super.destroy();
    }
});
