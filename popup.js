// Floating popup host — Windows 11 style.
//
// Architecture:
//   - A full-monitor reactive St.Widget overlay is added to global.stage.
//     It captures clicks-outside (to dismiss) and key events (Esc to close).
//   - The actual popup content (a St.BoxLayout styled like a menu surface)
//     is a child of the overlay, positioned near the pointer with clamping.
//   - We take a modal grab via Main.pushModal so keystrokes don't leak to the
//     app behind. pushModal returns a grab object; popModal takes THAT object.
//
// The popup is content-agnostic: it takes a "view" factory that returns an
// St.Widget to embed. clipboardView and emojiView both plug in here.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { POPUP_WIDTH } from './constants.js';

const MARGIN = 8; // px kept between popup edge and monitor edge

const WinVOverlay = GObject.registerClass({
    Signals: {
        'close-requested': {},
    },
}, class WinVOverlay extends St.Widget {
    _init() {
        const monitor = Main.layoutManager.currentMonitor;
        super._init({
            reactive: true,
            can_focus: true,
            x: monitor.x, y: monitor.y,
            width: monitor.width, height: monitor.height,
        });
        this._monitor = monitor;
    }

    // Place the content box near the pointer, clamped to the monitor.
    positionContent(content) {
        this.add_child(content);
        this._content = content;

        // Natural size before we constrain width.
        const [, natHeight] = content.get_preferred_height(POPUP_WIDTH);
        const w = POPUP_WIDTH;
        const h = Math.min(natHeight, this._monitor.height - 2 * MARGIN);

        content.set_width(w);

        let [px, py] = global.get_pointer();
        px -= this._monitor.x;
        py -= this._monitor.y;

        let x = px;
        let y = py;
        if (x + w > this._monitor.width - MARGIN)
            x = this._monitor.width - MARGIN - w;
        if (y + h > this._monitor.height - MARGIN)
            y = Math.max(MARGIN, this._monitor.height - MARGIN - h);
        if (x < MARGIN) x = MARGIN;
        if (y < MARGIN) y = MARGIN;

        content.set_position(this._monitor.x + x, this._monitor.y + y);
    }

    vfunc_button_press_event(event) {
        // Only dismiss when the click is OUTSIDE the content box.
        // Events on inner widgets (buttons/rows) either stop propagation
        // themselves or bubble up here with a source inside _content.
        const source = event.get_source();
        if (this._content && this._content.contains(source))
            return Clutter.EVENT_PROPAGATE;
        this.emit('close-requested');
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.emit('close-requested');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});

export class Popup {
    constructor() {
        this._overlay = null;
        this._grab = null;
        this._destroyId = null;
        this._closeId = null;
        this._onClose = null;
    }

    get isOpen() { return this._overlay !== null; }

    // buildContent() -> St.Widget  (called once on open)
    open(buildContent) {
        if (this._overlay) return;

        const overlay = new WinVOverlay();
        global.stage.add_child(overlay);

        const content = buildContent();
        if (!(content instanceof Clutter.Actor)) {
            console.error('WinV: view factory did not return a Clutter.Actor');
            overlay.destroy();
            return;
        }
        content.add_style_class_name('winv-popup');
        // Reuse the shell's menu surface so it adapts to the active theme.
        content.add_style_class_name('popup-menu');
        content.add_style_class_name('popup-menu-content');

        overlay.positionContent(content);

        // Modal grab: steal all input while the popup is up.
        let grab;
        try {
            grab = Main.pushModal(overlay, { actionMode: Shell.ActionMode.POPUP });
        } catch (e) {
            console.error('WinV: pushModal failed, opening without grab:', e);
            grab = null;
        }

        this._overlay = overlay;
        this._grab = grab;

        // If the actor is destroyed out from under us (e.g. screen lock), clean up.
        this._destroyId = overlay.connect('destroy', () => this._cleanup());
        this._closeId = overlay.connect('close-requested', () => this.close());

        overlay.grab_key_focus();
    }

    setOnClose(cb) { this._onClose = cb; }

    // Returns a small controller the view can hand to its drag handle.
    // The view calls begin() on button-press, update(dx,dy) on motion, end() on release.
    get dragController() {
        if (!this._overlay || !this._overlay._content) return null;
        const content = this._overlay._content;
        const monitor = this._overlay._monitor;
        return {
            begin() { /* hook for cursor change, handled in view */ },
            update(dx, dy) {
                if (dx === 0 && dy === 0) return;
                let [x, y] = content.get_position();
                x += dx; y += dy;
                // Clamp so the popup stays reachable on screen.
                const w = content.width, h = content.height;
                if (x < monitor.x + MARGIN) x = monitor.x + MARGIN;
                if (y < monitor.y + MARGIN) y = monitor.y + MARGIN;
                if (x + w > monitor.x + monitor.width - MARGIN)
                    x = monitor.x + monitor.width - MARGIN - w;
                if (y + h > monitor.y + monitor.height - MARGIN)
                    y = monitor.y + monitor.height - MARGIN - h;
                content.set_position(x, y);
            },
            end() { /* hook */ },
        };
    }

    close() {
        if (!this._overlay) return;
        try {
            if (this._onClose) this._onClose();
        } finally {
            // destroying the overlay triggers _cleanup via the 'destroy' signal
            this._overlay.destroy();
        }
    }

    _cleanup() {
        if (this._grab) {
            try { Main.popModal(this._grab); }
            catch (e) { console.error('WinV: popModal failed:', e); }
        }
        this._grab = null;
        if (this._overlay && this._overlay.get_parent())
            this._overlay.get_parent().remove_child(this._overlay);
        this._overlay = null;
        this._destroyId = null;
        this._closeId = null;
    }

    destroy() {
        if (this._overlay) this.close();
    }
}
