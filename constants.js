// Centralized constants & GSettings key names for WinV.
// Keep every pref key string here so prefs.js and extension.js never drift apart.

export const SCHEMA_ID = 'org.gnome.shell.extensions.winv';

export const Prefs = {
    // keybindings
    CLIPBOARD_KEYBINDING:  'clipboard-keybinding',
    EMOJI_KEYBINDING:      'emoji-keybinding',
    ENABLE_KEYBINDINGS:    'enable-keybindings',
    // behaviour
    HISTORY_SIZE:          'history-size',
    CACHE_IMAGES:          'cache-images',
    PASTE_ON_SELECT:       'paste-on-select',
    MOVE_ITEM_FIRST:       'move-item-first',
    CONFIRM_CLEAR:         'confirm-clear',
    STRIP_TEXT:            'strip-text',
    OPEN_AT_CURSOR:        'open-at-cursor',
};

// Clipboard mimetypes probed in order; first non-empty wins.
// Mirrors the proven order used by Clipboard Indicator on GNOME 50.
export const CLIPBOARD_MIMETYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
    'image/gif',
    'image/png',
    'image/jpg',
    'image/jpeg',
    'image/webp',
    'image/svg+xml',
    'text/html',
];

// Map GNOME legacy text mimetypes to the canonical one we store.
export const MIMETYPE_NORMALIZE = {
    'UTF8_STRING': 'text/plain;charset=utf-8',
};

export const CLIPBOARD_TYPE_STR = 'CLIPBOARD'; // for St.ClipboardType.CLIPBOARD

// GNOME's native schema that owns toggle-message-tray ('<Super>v' by default).
// We free up any of our clipboard shortcut that collides with it so our popup
// actually wins the Super+V grab, and restore the original value on disable.
export const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
export const MESSAGE_TRAY_KEY = 'toggle-message-tray';

// UI sizing (logical px); final styling lives in stylesheet.css.
// UI sizing (logical px); final styling lives in stylesheet.css.
// Compact, like the Windows 11 flyout (~300px wide).
export const POPUP_WIDTH = 320;
export const POPUP_MAX_HEIGHT = 440;
export const ROW_PREVIEW_CHARS = 48;
export const EMOJI_GRID_COLUMNS = 7;
