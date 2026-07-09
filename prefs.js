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

        // ---- Shortcuts group ----
        const shortcuts = new Adw.PreferencesGroup({ title: _('Atalhos') });

        const enableKeys = new Adw.SwitchRow({
            title: _('Ativar atalhos'),
            subtitle: _('Liga/desliga Win+V e Win+. globalmente'),
        });
        shortcuts.add(enableKeys);

        const clipRow = new Adw.ActionRow({
            title: _('Abrir histórico (Win+V)'),
            subtitle: _('Clique e pressione o atalho desejado'),
        });
        clipRow.add_suffix(this._makeShortcutButton(settings, Prefs.CLIPBOARD_KEYBINDING));
        clipRow.set_activatable_widget(clipRow.get_suffix());
        shortcuts.add(clipRow);

        const emojiRow = new Adw.ActionRow({
            title: _('Abrir emojis (Win+.)'),
            subtitle: _('Seletor de emojis — fase 2'),
        });
        emojiRow.add_suffix(this._makeShortcutButton(settings, Prefs.EMOJI_KEYBINDING));
        emojiRow.set_activatable_widget(emojiRow.get_suffix());
        shortcuts.add(emojiRow);

        page.add(shortcuts);

        // ---- Behaviour group ----
        const behaviour = new Adw.PreferencesGroup({ title: _('Comportamento') });

        const historySize = new Adw.SpinRow({
            title: _('Tamanho do histórico'),
            subtitle: _('Número máximo de itens guardados'),
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 500, step_increment: 5, page_increment: 25, value: 50,
            }),
        });
        behaviour.add(historySize);

        behaviour.add(new Adw.SwitchRow({
            title: _('Guardar imagens'),
            subtitle: _('Inclui screenshots e imagens copiadas'),
        }));

        behaviour.add(new Adw.SwitchRow({
            title: _('Colar automaticamente'),
            subtitle: _('Simula Ctrl+V no app focado ao selecionar um item'),
        }));

        behaviour.add(new Adw.SwitchRow({
            title: _('Mover reusado para o topo'),
        }));

        behaviour.add(new Adw.SwitchRow({
            title: _('Confirmar ao limpar tudo'),
        }));

        behaviour.add(new Adw.SwitchRow({
            title: _('Remover espaços do texto copiado'),
        }));

        behaviour.add(new Adw.SwitchRow({
            title: _('Abrir popup no cursor'),
            subtitle: _('Desligue para abrir centralizado'),
        }));

        page.add(behaviour);

        window.add(page);

        // ---- Bind rows to settings ----
        settings.bind(Prefs.ENABLE_KEYBINDINGS, enableKeys, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(Prefs.HISTORY_SIZE,       historySize, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(Prefs.CACHE_IMAGES,       behaviour.get_rows().get_item(1), 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(Prefs.PASTE_ON_SELECT,    behaviour.get_rows().get_item(2), 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(Prefs.MOVE_ITEM_FIRST,    behaviour.get_rows().get_item(3), 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(Prefs.CONFIRM_CLEAR,      behaviour.get_rows().get_item(4), 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(Prefs.STRIP_TEXT,         behaviour.get_rows().get_item(5), 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(Prefs.OPEN_AT_CURSOR,     behaviour.get_rows().get_item(6), 'active', Gio.SettingsBindFlags.DEFAULT);
    }

    // Manual key capture so the user can press Super+V (a plain accelerator
    // label can't capture a chord). Pattern verified against Clipboard Indicator.
    _makeShortcutButton(settings, prefKey) {
        const button = new Gtk.Button({ has_frame: false });

        const refresh = () => {
            const val = settings.get_strv(prefKey)[0];
            button.set_label(val ?? _('Desativado'));
        };
        refresh();

        button.connect('clicked', () => {
            button.set_label(_('Pressione o atalho…'));
            const ec = new Gtk.EventControllerKey();
            button.add_controller(ec);

            let debounce = null;
            const id = ec.connect('key-pressed', (_ec, keyval, keycode, mask) => {
                if (debounce) clearTimeout(debounce);
                mask = mask & Gtk.accelerator_get_default_mod_mask();

                if (mask === 0) {
                    if (keyval === Gdk.KEY_Escape) { refresh(); ec.disconnect(id); return Gdk.EVENT_STOP; }
                    if (keyval === Gdk.KEY_BackSpace) {
                        settings.set_strv(prefKey, []);
                        refresh(); ec.disconnect(id);
                        return Gdk.EVENT_STOP;
                    }
                }
                const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                debounce = setTimeout(() => {
                    ec.disconnect(id);
                    settings.set_strv(prefKey, [accel]);
                    refresh();
                }, 400);
                return Gdk.EVENT_STOP;
            });
        });
        return button;
    }
}
