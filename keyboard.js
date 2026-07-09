// Synthetic-keyboard helper for auto-pasting (Win11 behavior).
//
// We create a Clutter virtual keyboard device and drive Ctrl+V into whatever
// window had focus before the popup grabbed it. This is the same approach the
// clipboard-indicator extension uses on GNOME 50 (Clutter.get_default_backend()
// .get_default_seat().create_virtual_device).
//
// The full sequence used by the popup when "paste-on-select" is on:
//   1. remember current clipboard
//   2. set clipboard to the chosen item
//   3. close the popup (releases the modal grab, restores focus to the app)
//   4. emit Ctrl down -> V down -> V up -> Ctrl up

import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Keyboard {
    #device;
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
    }

    get ready() { return this.#ready; }

    #notify(keyval, state) {
        this.#device.notify_keyval(Clutter.get_current_event_time(), keyval, state);
    }

    press(keyval) { this.#notify(keyval, Clutter.KeyState.PRESSED); }
    release(keyval) { this.#notify(keyval, Clutter.KeyState.RELEASED); }

    // Emit a Ctrl+V chord. Returns true if it could be attempted.
    paste() {
        if (!this.#ready) return false;
        const CONTROL = Clutter.KEY_Control_L;
        const V = Clutter.KEY_v;
        this.press(CONTROL);
        this.press(V);
        this.release(V);
        this.release(CONTROL);
        return true;
    }

    destroy() {
        if (this.#device) this.#device.run_dispose();
        this.#device = null;
        this.#ready = false;
    }
}
