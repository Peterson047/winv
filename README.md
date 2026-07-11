```plaintext
WinV — Clipboard & Emoji for GNOME
```

\> Bring the Windows 11 clipboard history and emoji picker experience to GNOME.

WinV is a GNOME Shell extension that recreates the **Windows 11 "Win+V" clipboard**  
**history** and the **"Win+E" emoji picker** — including the floating, cursor-anchored  
popup, drag-to-move window, pinned items, image support, and automatic paste.

| **Clipboard history** (`Super`+`V`) | Text + images, search, pin, delete, clear |
| **Emoji picker** (`Super`+`E`) | 1500+ emojis with keyword search, categories |
| **Cursor-anchored popup** | Opens at the pointer, clamped to the monitor |
| **Draggable window** | Grab the title or search bar to reposition |
| **Automatic paste** | Selected item / emoji is pasted into the focused app |
| **Theme-aware** | Adapts to light or dark GNOME shell themes |
| **Top-bar indicator** | Quick access button with preferences menu |

## How it works

Press Super+V anywhere and a compact popup appears next to  
your cursor showing everything you've copied — most recent first. Click an item  
to copy it back (and optionally auto-paste it with a synthesized  
Ctrl+V). Pin frequently-used snippets so they survive a  
"clear all", or delete individual entries.

Press Super+E and the same window switches to the emoji tab:  
search by keyword ("heart", "thumbs up", "fire"), browse by category, and click  
to insert. Both views share one floating window with a tab switcher — exactly  
like Windows 11.

The popup can be dragged anywhere on screen by its title or search bar, and it  
dismisses when you click outside it or press Esc.

## Features in detail

### Clipboard history

*   **Text and images** — copied screenshots and images appear as thumbnails.
*   **Search** — filter the history live as you type.
*   **Pin / unpin** — starred items are kept across clears and never expire.
*   **Configurable history size** (default: 50 items).
*   **Persistence** — history survives logouts and reboots.
*   **Smart dedup** — re-copying the same content moves it to the top instead of duplicating.
*   **Whitespace trimming** option for cleaner text entries.

### Emoji picker

*   **1500+ emojis** sourced from Unicode CLDR annotations.
*   **Keyword search** across all categories.
*   **Category bar** to jump between Smileys, Animals, Food, Activities, Symbols, Flags, etc.
*   **Automatic insertion** into the focused app (with graceful fallback to copy-only).

### Window behavior

*   Opens at the **mouse cursor** (like Windows) or centered (configurable).
*   **Draggable** — grab the header title or the search field.
*   **Click-outside-to-close** and Esc to dismiss.
*   **Modal grab** — keyboard input is captured while open, then restored.

## Installation

### From source (development)

```plaintext
# 1. Clone
git clone https://github.com/Peterson047/winv.git
cd winv

# 2. Compile the GSettings schema
glib-compile-schemas schemas/

# 3. Install into your local extensions directory
cp -r . ~/.local/share/gnome-shell/extensions/winv@peterson047.github.io

# 4. Enable it
gnome-extensions enable winv@peterson047.github.io
```

Then **restart GNOME Shell** to load the extension:

*   **Wayland** (default on Ubuntu 26.04): log out and back in.
*   **X11**: press Alt+F2, type `r`, press Enter.

\> 💡 **Development tip:** For faster iteration, log into a **"GNOME on Xorg"**  
\> session from the login screen. This lets you restart the shell instantly with  
\> Alt+F2 → `r` without closing your applications.

### From extensions.gnome.org

_(Coming soon — pending review.)_ Search for "WinV" on  
[extensions.gnome.org](https://extensions.gnome.org) and click install.

### Verify it's running

```plaintext
gnome-extensions list | grep winv
gnome-extensions info winv@peterson047.github.io
```

## Configuration

Open preferences from the **top-bar indicator** (right-click → _Preferences_),  
from `gnome-extensions prefs winv@peterson047.github.io`, or via the Extensions app.

| Setting | Default | Description |
| --- | --- | --- |
| Clipboard shortcut | `Super+V` | Opens the clipboard history |
| Emoji shortcut | `Super+E` | Opens the emoji picker |
| History size | 50 | Maximum items kept (pinned items excluded) |
| Store images | On | Include copied images in history |
| Auto-paste | On | Simulate Ctrl+V after selecting an item |
| Move reused to top | On | Re-copying moves the item to position 1 |
| Confirm on clear | On | Ask before clearing history |
| Trim whitespace | On | Strip leading/trailing whitespace from text |
| Open at cursor | On | Position popup at the pointer (vs. centered) |

## Compatibility

| GNOME Shell | Status |
| --- | --- |
| **50** | ✅ Primary target (Ubuntu 26.04 LTS) |
| 49, 48, 47, 46 | ⚠️ Should work (ESM APIs are compatible); not yet tested |

The extension uses the modern **ESM module system** (`import` syntax) introduced  
in GNOME 45. It targets GNOME 50 and is expected to be compatible with the  
46–50 range; broader version tagging will follow testing.

**Requirements:**

*   GNOME Shell 46 or newer
*   `gjs` 1.78+
*   `Noto Color Emoji` font (pre-installed on most distros for emoji rendering)

## Project structure

```plaintext
winv@peterson047.github.io/
├── metadata.json              # Extension metadata (uuid, shell-version, schema)
├── extension.js               # Entry point: enable/disable, keybindings, orchestration
├── prefs.js                   # Preferences UI (GTK4 / libadwaita)
├── stylesheet.css             # Theme-aware styling (layers on St's native classes)
├── constants.js               # Shared keys, mimetypes, sizing constants
│
├── clipboardManager.js        # Meta.Selection 'owner-changed' listener + history logic
├── registry.js                # Persistence (JSON + image blobs in ~/.cache)
├── clipboardView.js           # Clipboard tab: list, search, pin, delete, clear
├── emojiView.js               # Emoji tab: grid, categories, keyword search
├── winvView.js                # Unified window: header, tab switcher, shared search
├── panelIndicator.js          # Top-bar button (PanelMenu.Button)
├── keyboard.js                # Synthetic keyboard for auto-paste (Ctrl+V)
├── confirmDialog.js           # ModalDialog wrapper for confirmations
├── emoji.json                 # Bundled emoji + keyword data (Unicode CLDR)
│
└── schemas/
    └── org.gnome.shell.extensions.winv.gschema.xml
```

### Architecture notes

*   **No polling.** Clipboard changes are detected via `Meta.Selection::'owner-changed'`,  
    which fires exactly when an app sets the clipboard — zero CPU when idle.
*   **Single window, two tabs.** Clipboard and Emoji share one `Popup` instance;  
    `Super+V` and `Super+.` select which tab is shown.
*   **Theme-adaptive.** The popup reuses GNOME's native `.popup-menu-content`,  
    `.search-entry`, and `.popup-menu-item` classes, so it automatically matches  
    light/dark themes. `stylesheet.css` only adds Windows-style rounding and spacing.
*   **Safe lifecycle.** Everything created in `enable()` is destroyed in `disable()`  
    — no leaked actors, signals, or timeouts (required for extensions.gnome.org review).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Super+V | Open clipboard history |
| Super+E | Open emoji picker |
| Esc | Close popup |
| Click outside | Close popup |
| Drag title/search | Move popup |
| ↑ ↓ Enter | Navigate and select items |

All shortcuts are customizable in Preferences.

e

## Debugging

```plaintext
# Watch the gnome-shell journal for WinV output
journalctl -f /usr/bin/gnome-shell | grep winv
ea
# Open Looking Glass (live JS inspector + error log)
# Alt+F2 → type "lg" → Enter
```

Useful Looking Glass commands:

*   `Main.extensions['winv@peterson047.github.io']` — inspect extension state
*   Check the **Errors** tab for criticals

## Known limitations

*   **Auto-paste on Wayland** uses a Clutter virtual input device to synthesize  
    Ctrl+V. If the focused app ignores synthetic input, the  
    item is still copied to the clipboard — just press Ctrl+V manually.
*   **Emoji rendering** depends on `Noto Color Emoji` being installed. Most distros  
    ship it by default.

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like  
to change.

1.  Fork the repository
2.  Create a feature branch (`git checkout -b feature/amazing-thing`)
3.  Test on X11 for fast iteration (`Alt+F2` → `r`)
4.  Commit with clear messages
5.  Open a Pull Request

## Credits

*   Emoji keyword data adapted from  
    [emoji-selector-for-gnome](https://github.com/maoschanz/emoji-selector-for-gnome)  
    by maoschanz (GPL-3.0).
*   Clipboard detection pattern informed by  
    [clipboard-indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator)  
    by Tudmotu (GPL-2.0+).

## License

Copyright © 2026 Peterson Alves. Licensed under the  
[GNU General Public License v3.0](LICENSE).