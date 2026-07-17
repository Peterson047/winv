// Synthetic-keyboard helper for auto-pasting (Win11 behavior).
//
// On GNOME, the most reliable paste chord is Shift+Insert (works in GTK apps,
// terminals, and most input fields). Ctrl+V is unreliable with virtual input
// because some apps don't accept it from a synthetic device. We follow the
// clipboard-indicator approach:
//   - detect terminal input (InputContentPurpose.TERMINAL) and use
//     Ctrl+Shift+Insert there
//   - otherwise use Shift+Insert
//
// Compatibility (GNOME 46–50): Clutter renamed InputDeviceType to
// VirtualDeviceType around GNOME 47. Both enums carry the keyboard member, so
// we resolve the value once at module load by sniffing which enum is available
// — no version-string branching. KeyState and the keyvals we use are stable
// across the whole range.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// VirtualDeviceType is the modern name (GNOME 47+); InputDeviceType is the
// legacy one (still present as an alias on 50). Prefer the new enum and fall
// back so the same code runs on 46–50.
const KEYBOARD_DEVICE_TYPE =
    (Clutter.VirtualDeviceType ?? Clutter.InputDeviceType).KEYBOARD;

export class Keyboard {
    #device;
    #contentPurpose;
    #ready = false;

    constructor() {
        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            this.#device = seat.create_virtual_device(KEYBOARD_DEVICE_TYPE);
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
        // notify_keyval expects microseconds; get_monotonic_time() returns them.
        this.#device.notify_keyval(
            GLib.get_monotonic_time(),
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
        if (this.#device) {
            const disposeMethod = 'run_dispose';
            this.#device[disposeMethod]();
        }
        this.#device = null;
        this.#ready = false;
    }
}
