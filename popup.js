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
import { POPUP_WIDTH, POPUP_MAX_HEIGHT } from './constants.js';

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

        const w = POPUP_WIDTH;
        content.set_width(w);

        // Cap the popup height so long lists (emoji grid, big history) scroll
        // inside a St.ScrollView instead of growing to fill the whole screen.
        const maxHeight = Math.min(
            POPUP_MAX_HEIGHT,
            this._monitor.height - 2 * MARGIN,
        );
        // Setting height directly forces the inner ScrollView to activate.
        const [, natHeight] = content.get_preferred_height(w);
        const h = Math.min(natHeight, maxHeight);
        content.set_height(h);

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
        // Dismiss ONLY when the click is truly outside the popup.
        // - If the source is the overlay itself → outside (close).
        // - If the source is the content box or any descendant → inside (keep).
        // - If null (shouldn't happen with reactive content), treat as outside.
        const source = event.get_source();
        const inside = source && this._content && this._content.contains(source);
        if (!inside)
            this.emit('close-requested');
        // Always propagate so inner widgets still receive their button-press.
        return Clutter.EVENT_PROPAGATE;
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

        // Build the content BEFORE taking the modal grab, and tear down the
        // overlay if building throws — otherwise a half-built view leaves an
        // invisible fullscreen overlay capturing all input ("modal invisível").
        let content;
        try {
            content = buildContent();
        } catch (e) {
            console.error('WinV: view build failed:', e);
            global.stage.remove_child(overlay);
            overlay.destroy();
            return;
        }
        if (!(content instanceof Clutter.Actor)) {
            console.error('WinV: view factory did not return a Clutter.Actor');
            global.stage.remove_child(overlay);
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

    // Begin a drag operation. Motion/release are tracked on the overlay (which
    // is the modal-grab actor and therefore receives captured pointer events).
    // `handleActor` is the title label — used only to restore its cursor.
    beginDrag(handleActor, startX, startY) {
        if (!this._overlay) return;
        const content = this._overlay._content;
        const monitor = this._overlay._monitor;
        const overlay = this._overlay;
        let lastX = startX, lastY = startY;

        const onMotion = (_o, event) => {
            const [x, y] = event.get_coords();
            const dx = x - lastX, dy = y - lastY;
            if (dx === 0 && dy === 0) return Clutter.EVENT_PROPAGATE;
            lastX = x; lastY = y;

            let [px, py] = content.get_position();
            px += dx; py += dy;
            const w = content.width, h = content.height;
            if (px < monitor.x + MARGIN) px = monitor.x + MARGIN;
            if (py < monitor.y + MARGIN) py = monitor.y + MARGIN;
            if (px + w > monitor.x + monitor.width - MARGIN)
                px = monitor.x + monitor.width - MARGIN - w;
            if (py + h > monitor.y + monitor.height - MARGIN)
                py = monitor.y + monitor.height - MARGIN - h;
            content.set_position(px, py);
            return Clutter.EVENT_STOP;
        };

        const onRelease = () => {
            overlay.disconnect(motionId);
            overlay.disconnect(releaseId);
            if (handleActor)
                handleActor.remove_style_pseudo_class('dragging');
            return Clutter.EVENT_PROPAGATE;
        };

        const motionId = overlay.connect('motion-event', onMotion);
        const releaseId = overlay.connect('button-release-event', onRelease);
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
