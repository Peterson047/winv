// Confirmation dialog built on the shell's ModalDialog. Used for "Clear all".
//
// ModalDialog manages its own modal grab + lightbox, so we don't need to.

import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const ConfirmDialog = GObject.registerClass(
class ConfirmDialog extends ModalDialog.ModalDialog {
    _init(title, desc, okLabel, cancelLabel, callback) {
        super._init();

        const messageBox = new St.BoxLayout({ vertical: true });
        this.contentLayout.add_child(messageBox);

        messageBox.add_child(new St.Label({
            style: 'font-weight: 700',
            x_align: Clutter.ActorAlign.CENTER,
            text: title,
        }));
        messageBox.add_child(new St.Label({
            style: 'padding-top: 12px',
            x_align: Clutter.ActorAlign.CENTER,
            text: desc,
        }));

        this.setButtons([
            {
                label: cancelLabel,
                action: () => this.close(),
                key: Clutter.KEY_Escape,
            },
            {
                label: okLabel,
                action: () => { this.close(); callback(); },
            },
        ]);
    }
});

// Tiny manager so only one confirm dialog is ever on screen.
export class DialogManager {
    #open = null;

    open(title, message, okLabel, cancelLabel, callback) {
        if (this.#open) return;
        const dlg = new ConfirmDialog(title, message, okLabel, cancelLabel, callback);
        this.#open = dlg;
        dlg.connect('closed', () => {
            dlg.destroy();
            this.#open = null;
        });
        dlg.open();
    }

    destroy() {
        // Null the reference BEFORE destroying so the async 'closed' handler
        // (emitted after the fade animation) becomes a no-op instead of calling
        // destroy() on an already-disposed dialog ("object has been disposed").
        if (this.#open) {
            const dlg = this.#open;
            this.#open = null;
            dlg.destroy();
        }
    }
}
