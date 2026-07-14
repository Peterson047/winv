// Persistence layer for WinV.
//
// Text items are stored inline in registry.txt (JSON). Image items are stored
// as separate blob files in the cache dir, referenced by content hash — so the
// JSON stays small and image bytes never go through the string encoder.
//
// Everything is written under GLib.get_user_cache_dir()/<uuid>, i.e. inside
// $HOME, which is an EGO review requirement.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const FileQueryInfoFlags = Gio.FileQueryInfoFlags;
const FileTest = GLib.FileTest;

// ---- ClipboardEntry: one item of history ------------------------------

export class ClipboardEntry {
    #mimetype;
    #content;     // String for text, Uint8Array for image
    #favorite;
    #tag;
    #timestamp;   // epoch ms

    static isTextMimetype(mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    // Reconstruct from a JSON record (text inline, image read from disk).
    static async fromJSON(jsonEntry) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = !!jsonEntry.favorite;
        let content;

        if (ClipboardEntry.isTextMimetype(mimetype)) {
            content = jsonEntry.contents;
        } else {
            // image: contents is the absolute path to the blob
            if (!GLib.file_test(jsonEntry.contents, FileTest.EXISTS)) return null;
            const file = Gio.File.new_for_path(jsonEntry.contents);
            content = await new Promise((resolve, reject) =>
                file.load_contents_async(null, (obj, res) => {
                    const [ok, c] = obj.load_contents_finish(res);
                    if (ok) resolve(c);
                    else reject(new Error('WinV: failed reading image blob'));
                }));
        }

        const entry = new ClipboardEntry(mimetype, content, favorite);
        if (jsonEntry.tag) entry.setTag(jsonEntry.tag);
        if (jsonEntry.timestamp) entry.#timestamp = jsonEntry.timestamp;
        return entry;
    }

    constructor(mimetype, content, favorite = false) {
        this.#mimetype = mimetype;
        // Store a copy of array so the caller's buffer mutations can't corrupt us, 
        // or just keep the string if it's text.
        this.#content = (content instanceof Uint8Array || typeof content === 'string') 
            ? content : new Uint8Array(content);
        this.#favorite = favorite;
        this.#timestamp = Date.now();
        
        if (this.isText()) {
            this._stringValue = this.#content;
            this._lowerStringValue = this._stringValue.toLowerCase();
        }
    }

    mimetype() { return this.#mimetype; }
    asBytes() {
        if (this.isText()) return GLib.Bytes.new(new TextEncoder().encode(this.#content));
        return GLib.Bytes.new(this.#content);
    }
    isFavorite() { return this.#favorite; }
    set favorite(v) { this.#favorite = !!v; }
    isText() { return ClipboardEntry.isTextMimetype(this.#mimetype); }
    isImage() { return this.#mimetype.startsWith('image/'); }
    getTag() { return this.#tag; }
    setTag(tag) { this.#tag = tag || null; }
    getTimestamp() { return this.#timestamp || 0; }
    setTimestamp(ts) { this.#timestamp = ts; }

    getStringValue() {
        if (this.isText()) return this._stringValue;
        if (this._stringValue === undefined)
            this._stringValue = `[Image ${this.hash()}]`;
        return this._stringValue;
    }
    
    getLowerStringValue() {
        if (this.isText()) return this._lowerStringValue;
        return this.getStringValue().toLowerCase();
    }

    // Content hash for dedup (SHA256 hex). Stable across runs. Memoized: the
    // bytes are immutable, and hash()/equals() are called repeatedly during
    // dedup checks and searches.
    hash() {
        if (this._hash === undefined)
            this._hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, this.asBytes());
        return this._hash;
    }

    equals(other) {
        return other && this.hash() === other.hash();
    }
}

// Trim a history list to at most `maxSize` non-favorite entries, never dropping
// favorites. Single pass from the end (oldest) so it stays O(n) instead of the
// previous filter-in-while-loop O(n²). Returns the dropped entries so the caller
// can delete their image blobs. Mutates `entries` in place.
export function trimHistory(entries, maxSize) {
    const dropped = [];
    // Count current non-favorites.
    let nonFavoriteCount = 0;
    for (const e of entries) if (!e.isFavorite()) nonFavoriteCount++;
    if (nonFavoriteCount <= maxSize) return dropped;
    // Walk from the oldest (end); splice non-favorites until within budget.
    for (let i = entries.length - 1; i >= 0 && nonFavoriteCount > maxSize; i--) {
        if (entries[i].isFavorite()) continue;
        dropped.push(entries[i]);
        entries.splice(i, 1);
        nonFavoriteCount--;
    }
    return dropped;
}

// ---- Registry: load/save the whole history ----------------------------

export class Registry {
    constructor({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.CACHE_DIR = `${GLib.get_user_cache_dir()}/${this.uuid}`;
        this.REGISTRY_PATH = `${this.CACHE_DIR}/registry.txt`;
        this.BACKUP_PATH = `${this.REGISTRY_PATH}~`;
    }

    // Synchronously ensure the cache directory exists.
    ensureDir() {
        if (!GLib.file_test(this.CACHE_DIR, FileTest.EXISTS))
            GLib.mkdir_with_parents(this.CACHE_DIR, parseInt('0700', 8));
    }

    imageFilePath(entry) {
        // name by hash so identical images dedupe on disk too
        return `${this.CACHE_DIR}/${entry.hash()}`;
    }

    async writeEntryFile(entry) {
        if (!entry.isImage()) return;
        this.ensureDir();
        const path = this.imageFilePath(entry);
        if (GLib.file_test(path, FileTest.EXISTS)) return; // dedupe
        const file = Gio.File.new_for_path(path);
        await new Promise((resolve, reject) =>
            file.replace_async(null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        const stream = obj.replace_finish(res);
                        stream.write_bytes_async(entry.asBytes(), GLib.PRIORITY_DEFAULT, null,
                            (w_obj, w_res) => {
                                try {
                                    w_obj.write_bytes_finish(w_res);
                                    stream.close(null);
                                    resolve();
                                } catch (e) {
                                    reject(e);
                                }
                            });
                    } catch (e) {
                        reject(e);
                    }
                }));
    }

    async deleteEntryFile(entry) {
        if (!entry.isImage()) return;
        const path = this.imageFilePath(entry);
        if (!GLib.file_test(path, FileTest.EXISTS)) return;
        try {
            const file = Gio.File.new_for_path(path);
            await file.delete_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            console.error('WinV deleteEntryFile:', e);
        }
    }

    async write(entries) {
        this.ensureDir();
        const serializable = [];
        for (const entry of entries) {
            const item = {
                favorite: entry.isFavorite(),
                mimetype: entry.mimetype(),
                timestamp: entry.getTimestamp(),
            };
            if (entry.isText()) {
                item.contents = entry.getStringValue();
            } else if (entry.isImage()) {
                if (this.settings.get_boolean('cache-images')) {
                    await this.writeEntryFile(entry);
                    item.contents = this.imageFilePath(entry);
                } else {
                    continue; // skip images entirely if disabled
                }
            }
            if (entry.getTag()) item.tag = entry.getTag();
            serializable.push(item);
        }
        await this._writeJson(JSON.stringify(serializable));
    }

    _writeJson(json) {
        this.ensureDir();
        const bytes = new GLib.Bytes(json);
        const file = Gio.File.new_for_path(this.REGISTRY_PATH);
        return new Promise((resolve, reject) =>
            file.replace_async(null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        const stream = obj.replace_finish(res);
                        stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null,
                            (w_obj, w_res) => {
                                try {
                                    w_obj.write_bytes_finish(w_res);
                                    stream.close(null);
                                    resolve();
                                } catch (e) {
                                    reject(e);
                                }
                            });
                    } catch (e) {
                        reject(e);
                    }
                }));
    }

    async read() {
        if (!GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS)) return [];
        const file = Gio.File.new_for_path(this.REGISTRY_PATH);
        const [ok, contents] = await new Promise((resolve, reject) =>
            file.load_contents_async(null, (obj, res) => {
                try {
                    resolve(obj.load_contents_finish(res));
                } catch (e) {
                    reject(e);
                }
            }));
        if (!ok) return [];

        const text = new TextDecoder().decode(contents);
        if (!text.trim()) return [];

        let registry;
        try {
            registry = JSON.parse(text);
        } catch (e) {
            console.error('WinV: registry.txt is corrupt, ignoring:', e);
            return [];
        }

        const entries = (await Promise.all(registry.map(async item => {
            try {
                return await ClipboardEntry.fromJSON(item);
            } catch (e) {
                console.error('WinV: error loading registry entry:', e);
                return null;
            }
        }))).filter(e => e !== null);

        // Enforce history-size, never dropping favorites.
        const maxSize = this.settings.get_int('history-size');
        const dropped = trimHistory(entries, maxSize);
        for (const e of dropped) {
            if (e.isImage())
                this.deleteEntryFile(e).catch(() => {});
        }
        return entries;
    }

    async readRecentEmojis() {
        const path = `${this.CACHE_DIR}/recent_emojis.json`;
        if (!GLib.file_test(path, FileTest.EXISTS)) return [];
        const file = Gio.File.new_for_path(path);
        try {
            const [ok, contents] = await new Promise((resolve, reject) =>
                file.load_contents_async(null, (obj, res) => {
                    try {
                        resolve(obj.load_contents_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }));
            if (!ok) return [];
            const text = new TextDecoder().decode(contents);
            return JSON.parse(text);
        } catch (e) {
            console.error('WinV readRecentEmojis:', e);
            return [];
        }
    }

    async writeRecentEmojis(emojis) {
        this.ensureDir();
        const json = JSON.stringify(emojis);
        const bytes = new GLib.Bytes(json);
        const path = `${this.CACHE_DIR}/recent_emojis.json`;
        const file = Gio.File.new_for_path(path);
        return new Promise((resolve, reject) =>
            file.replace_async(null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        const stream = obj.replace_finish(res);
                        stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null,
                            (w_obj, w_res) => {
                                try {
                                    w_obj.write_bytes_finish(w_res);
                                    stream.close(null);
                                    resolve();
                                } catch (e) {
                                    reject(e);
                                }
                            });
                    } catch (e) {
                        reject(e);
                    }
                }));
    }
}
