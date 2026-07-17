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

function _logError(msg, err) {
    console.error(msg, err);
}

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
    static async fromJSON(jsonEntry, cacheDir) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = !!jsonEntry.favorite;
        let content;

        if (ClipboardEntry.isTextMimetype(mimetype)) {
            content = jsonEntry.contents;
            const path = jsonEntry.contents;
            if (!cacheDir || typeof path !== 'string' || !path.startsWith(cacheDir) || path.includes('..')) {
                return null;
            }
            const file = Gio.File.new_for_path(path);
            try {
                content = await new Promise((resolve, reject) =>
                    file.load_contents_async(null, (obj, res) => {
                        try {
                            const [ok, c] = obj.load_contents_finish(res);
                            if (ok) resolve(c);
                            else reject(new Error('WinV: failed reading image blob'));
                        } catch (e) {
                            reject(e);
                        }
                    }));
            } catch (e) {
                return null;
            }
        }

        const entry = new ClipboardEntry(mimetype, content, favorite);
        if (jsonEntry.tag) entry.setTag(jsonEntry.tag);
        if (jsonEntry.timestamp) entry.#timestamp = jsonEntry.timestamp;
        return entry;
    }

    constructor(mimetype, content, favorite = false) {
        this.#mimetype = mimetype;
        // Store a copy of array so the caller's buffer mutations or GBytes memory GC can't corrupt us.
        this.#content = (typeof content === 'string') 
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
// favorites. Mutates `entries` in place efficiently without quadratic splice costs.
// Returns the dropped entries so the caller can delete their image blobs.
export function trimHistory(entries, maxSize) {
    let nonFavoriteCount = 0;
    for (const e of entries) if (!e.isFavorite()) nonFavoriteCount++;
    if (nonFavoriteCount <= maxSize) return [];

    const dropped = [];
    const kept = [];
    let toDrop = nonFavoriteCount - maxSize;

    // Walk backwards so we drop the oldest non-favorites first
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (!e.isFavorite() && toDrop > 0) {
            dropped.push(e);
            toDrop--;
        } else {
            kept.push(e);
        }
    }
    
    // Kept elements were collected backwards, so reverse them and mutate original array
    kept.reverse();
    entries.length = 0;
    for (const e of kept) entries.push(e);
    
    return dropped;
}

// ---- Registry: load/save the whole history ----------------------------

export class Registry {
    constructor({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.CACHE_DIR = `${GLib.get_user_cache_dir()}/${this.uuid}`;
        this.REGISTRY_PATH = `${this.CACHE_DIR}/registry.txt`;
        this._writeLock = Promise.resolve();
    }

    // Asynchronously ensure the cache directory exists.
    async ensureDir() {
        const dir = Gio.File.new_for_path(this.CACHE_DIR);
        try {
            await new Promise((resolve, reject) => {
                dir.make_directory_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        obj.make_directory_finish(res);
                        resolve();
                    } catch (e) {
                        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                            resolve(); // directory already exists, ignore
                        } else {
                            reject(e);
                        }
                    }
                });
            });
        } catch (e) {
            // Fallback to synchronous make_directory_with_parents if async fails
            try {
                dir.make_directory_with_parents(null);
            } catch (err) {
                if (!err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    _logError('WinV ensureDir error:', err);
                }
            }
        }
    }

    imageFilePath(entry) {
        // name by hash so identical images dedupe on disk too
        return `${this.CACHE_DIR}/${entry.hash()}`;
    }

    async writeEntryFile(entry) {
        if (!entry.isImage()) return;
        await this.ensureDir();
        const path = this.imageFilePath(entry);
        const file = Gio.File.new_for_path(path);
        
        try {
            await new Promise((resolve, reject) => {
                file.create_async(Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        const stream = obj.create_finish(res);
                        stream.write_bytes_async(entry.asBytes(), GLib.PRIORITY_DEFAULT, null, (w_obj, w_res) => {
                            try {
                                w_obj.write_bytes_finish(w_res);
                                stream.close_async(GLib.PRIORITY_DEFAULT, null, (c_obj, c_res) => {
                                    try {
                                        c_obj.close_finish(c_res);
                                        resolve();
                                    } catch (e) {
                                        reject(e);
                                    }
                                });
                            } catch (e) {
                                reject(e);
                            }
                        });
                    } catch (e) {
                        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                            resolve(); // already exists, deduplicated
                        } else {
                            reject(e);
                        }
                    }
                });
            });
        } catch (e) {
            _logError('WinV writeEntryFile:', e);
        }
    }

    async deleteEntryFile(entry) {
        if (!entry.isImage()) return;
        const path = this.imageFilePath(entry);
        try {
            const file = Gio.File.new_for_path(path);
            await new Promise((resolve, reject) => {
                file.delete_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        obj.delete_finish(res);
                        resolve();
                    } catch (e) {
                        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                            resolve();
                        } else {
                            reject(e);
                        }
                    }
                });
            });
        } catch (e) {
            _logError('WinV deleteEntryFile:', e);
        }
    }

    async write(entries) {
        // Queue the write behind any currently ongoing write to prevent file corruption
        const previousLock = this._writeLock;
        let resolveLock;
        this._writeLock = new Promise(resolve => { resolveLock = resolve; });
        
        try {
            await previousLock;
            await this.ensureDir();
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
        } finally {
            resolveLock();
        }
    }

    async _writeJson(json) {
        await this.ensureDir();
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
                                    stream.close_async(GLib.PRIORITY_DEFAULT, null, (c_obj, c_res) => {
                                        try {
                                            c_obj.close_finish(c_res);
                                            resolve();
                                        } catch (e) {
                                            reject(e);
                                        }
                                    });
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
        const file = Gio.File.new_for_path(this.REGISTRY_PATH);
        let contents;
        try {
            const [ok, c] = await new Promise((resolve, reject) =>
                file.load_contents_async(null, (obj, res) => {
                    try {
                        resolve(obj.load_contents_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }));
            if (!ok) return [];
            contents = c;
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return [];
            _logError('WinV registry read failed:', e);
            return [];
        }

        const text = new TextDecoder().decode(contents);
        if (!text.trim()) return [];

        let registry;
        try {
            registry = JSON.parse(text);
        } catch (e) {
            _logError('WinV: registry.txt is corrupt, ignoring:', e);
            return [];
        }

        const entries = (await Promise.all(registry.map(async item => {
            try {
                return await ClipboardEntry.fromJSON(item, this.CACHE_DIR);
            } catch (e) {
                _logError('WinV: error loading registry entry:', e);
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
        const file = Gio.File.new_for_path(path);
        let contents;
        try {
            const [ok, c] = await new Promise((resolve, reject) =>
                file.load_contents_async(null, (obj, res) => {
                    try {
                        resolve(obj.load_contents_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }));
            if (!ok) return [];
            contents = c;
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return [];
            _logError('WinV readRecentEmojis:', e);
            return [];
        }

        try {
            const text = new TextDecoder().decode(contents);
            return JSON.parse(text);
        } catch (e) {
            _logError('WinV readRecentEmojis parsing failed:', e);
            return [];
        }
    }

    async writeRecentEmojis(emojis) {
        await this.ensureDir();
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
                                    stream.close_async(GLib.PRIORITY_DEFAULT, null, (c_obj, c_res) => {
                                        try {
                                            c_obj.close_finish(c_res);
                                            resolve();
                                        } catch (e) {
                                            reject(e);
                                        }
                                    });
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
