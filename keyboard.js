// Synthetic-keyboard helper for auto-pasting (Win11 behavior).
//
// On GNOME, the most reliable paste chord is Shift+Insert (works in GTK apps,
// terminals, and most input fields). Ctrl+V is unreliable with virtual input
// because some apps don't accept it from a synthetic device. We follow the
// clipboard-indicator approach:
//   - detect terminal input (InputContentPurpose.TERMINAL) and use
//     Ctrl+Shift+Insert there
//   - otherwise use Shift+Insert

import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Keyboard {
    #device;
    #contentPurpose;
    #ready = false;

    constructor() {
        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            this.#device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            this.#ready = true;
        } catch (e) {
            console.error('WinV: could not create virtual keyboard device:', e);
            this.#ready = false;
        }

        // Track what kind of input the focused field expects, so we can pick the
        // right paste chord (terminals need Ctrl+Shift+Insert).
        try {
            Main.inputMethod.connectObject('notify::content-purpose', (method) => {
                this.#contentPurpose = method.content_purpose;
            }, this);
        } catch (e) {
            console.warn('WinV: could not track input content-purpose:', e);
        }
    }

    get ready() { return this.#ready; }

    get isTerminal() {
        return this.#contentPurpose === Clutter.InputContentPurpose.TERMINAL;
    }

    #notify(keyval, state) {
        // notify_keyval expects microseconds; get_current_event_time() returns
        // milliseconds, so multiply by 1000 (matches clipboard-indicator).
        this.#device.notify_keyval(
            Clutter.get_current_event_time() * 1000,
            keyval,
            state);
    }

    press(keyval) { this.#notify(keyval, Clutter.KeyState.PRESSED); }
    release(keyval) { this.#notify(keyval, Clutter.KeyState.RELEASED); }

    // Emit the most reliable paste chord for the current input context.
    // Returns true if attempted.
    paste() {
        if (!this.#ready) return false;
        if (this.isTerminal) {
            // Terminals use Ctrl+Shift+Insert for paste.
            this.press(Clutter.KEY_Control_L);
            this.press(Clutter.KEY_Shift_L);
            this.press(Clutter.KEY_Insert);
            this.release(Clutter.KEY_Insert);
            this.release(Clutter.KEY_Shift_L);
            this.release(Clutter.KEY_Control_L);
        } else {
            // Most GTK/Qt apps accept Shift+Insert.
            this.press(Clutter.KEY_Shift_L);
            this.press(Clutter.KEY_Insert);
            this.release(Clutter.KEY_Insert);
            this.release(Clutter.KEY_Shift_L);
        }
        return true;
    }

    destroy() {
        try { Main.inputMethod.disconnectObject(this); } catch (e) { /* already gone */ }
        if (this.#device) this.#device.run_dispose();
        this.#device = null;
        this.#ready = false;
    }
}
