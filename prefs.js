// WinV preferences — GTK4 / libadwaita.
// Runs in a separate process (org.gnome.Shell.Extensions), so it cannot touch
// gnome-shell globals.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { Prefs } from './constants.js';

export default class WinVPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({ title: _('WinV'), icon_name: 'edit-paste-symbolic' });

        this._buildShortcuts(page, settings);
        this._buildBehaviour(page, settings);

        window.add(page);
    }

    _buildShortcuts(page, settings) {
        const group = new Adw.PreferencesGroup({ title: _('Atalhos') });

        const enableKeys = new Adw.SwitchRow({
            title: _('Ativar atalhos'),
            subtitle: _('Liga/desliga Win+V e Win+. globalmente'),
        });
        group.add(enableKeys);

        const clipRow = this._makeShortcutRow(
            _('Abrir histórico (Win+V)'),
            _('Clique e pressione o atalho desejado'),
        );
        const clipBtn = this._makeShortcutButton(settings, Prefs.CLIPBOARD_KEYBINDING, clipRow);
        clipRow.add_suffix(clipBtn);
        group.add(clipRow);

        const emojiRow = this._makeShortcutRow(
            _('Abrir emojis (Win+.)'),
            _('Clique e pressione o atalho desejado'),
        );
        const emojiBtn = this._makeShortcutButton(settings, Prefs.EMOJI_KEYBINDING, emojiRow);
        emojiRow.add_suffix(emojiBtn);
        group.add(emojiRow);

        page.add(group);

        settings.bind(Prefs.ENABLE_KEYBINDINGS, enableKeys, 'active', Gio.SettingsBindFlags.DEFAULT);
    }

    _makeShortcutRow(title, subtitle) {
        return new Adw.ActionRow({ title, subtitle });
    }

    // Manual key capture so the user can press Super+V (a plain accelerator
    // label can't capture a chord). Robust against modifiers-only presses.
    _makeShortcutButton(settings, prefKey, row) {
        const button = new Gtk.Button({ has_frame: false, valign: Gtk.Align.CENTER });

        const refresh = () => {
            const val = settings.get_strv(prefKey)[0];
            if (val) {
                const [ok, keyval, mods] = Gtk.accelerator_parse(val);
                if (ok) {
                    button.set_label(Gtk.accelerator_get_label(keyval, mods));
                } else {
                    button.set_label(val);
                }
            } else {
                button.set_label(_('Desativado'));
            }
        };
        refresh();

        settings.connect(`changed::${prefKey}`, refresh);

        button.connect('clicked', () => {
            button.set_label(_('Pressione o atalho…'));
            const ec = new Gtk.EventControllerKey({
                propagation_phase: Gtk.PropagationPhase.CAPTURE,
            });
            button.add_controller(ec);

            const finish = (restoreCursor = true) => {
                ec.disconnect(id);
                button.remove_controller(ec);
                if (restoreCursor) refresh();
            };

            const id = ec.connect('key-pressed', (_ec, keyval, keycode, mask) => {
                // Strip Caps/NumLock noise.
                const mods = mask & Gtk.accelerator_get_default_mod_mask();

                // Escape cancels, BackSpace clears.
                if (mods === 0) {
                    if (keyval === Gdk.KEY_Escape) { finish(true); return true; }
                    if (keyval === Gdk.KEY_BackSpace) {
                        settings.set_strv(prefKey, []);
                        finish(true);
                        return true;
                    }
                }

                // Require a real key (not modifiers alone): a valid accelerator
                // needs a non-modifier keyval. Gtk.accelerator_valid checks that.
                const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods);
                if (accel && Gtk.accelerator_valid(keyval, mods)) {
                    settings.set_strv(prefKey, [accel]);
                    finish(true);
                    return true;
                }

                // Otherwise it's a modifier alone — keep listening.
                button.set_label(_('Pressione o atalho…'));
                return true;
            });
        });
        return button;
    }

    _buildBehaviour(page, settings) {
        const group = new Adw.PreferencesGroup({ title: _('Comportamento') });

        const historySize = new Adw.SpinRow({
            title: _('Tamanho do histórico'),
            subtitle: _('Número máximo de itens guardados'),
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 500, step_increment: 5, page_increment: 25, value: 50,
            }),
        });
        group.add(historySize);

        const rows = {};
        const addSwitch = (key, title, subtitle = null) => {
            const row = new Adw.SwitchRow({ title, subtitle });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            rows[key] = row;
        };

        addSwitch(Prefs.CACHE_IMAGES, _('Guardar imagens'), _('Inclui screenshots e imagens copiadas'));
        addSwitch(Prefs.PASTE_ON_SELECT, _('Colar automaticamente'), _('Simula Ctrl+V no app focado ao selecionar um item'));
        addSwitch(Prefs.MOVE_ITEM_FIRST, _('Mover reusado para o topo'));
        addSwitch(Prefs.CONFIRM_CLEAR, _('Confirmar ao limpar tudo'));
        addSwitch(Prefs.STRIP_TEXT, _('Remover espaços do texto copiado'));
        addSwitch(Prefs.OPEN_AT_CURSOR, _('Abrir popup no cursor'), _('Desligue para abrir centralizado'));

        settings.bind(Prefs.HISTORY_SIZE, historySize, 'value', Gio.SettingsBindFlags.DEFAULT);

        page.add(group);
    }
}
