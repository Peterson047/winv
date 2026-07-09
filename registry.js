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
    #bytes;       // Uint8Array
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
        let bytes;

        if (ClipboardEntry.isTextMimetype(mimetype)) {
            bytes = new TextEncoder().encode(jsonEntry.contents);
        } else {
            // image: contents is the absolute path to the blob
            if (!GLib.file_test(jsonEntry.contents, FileTest.EXISTS)) return null;
            const file = Gio.file_new_for_path(jsonEntry.contents);
            bytes = await new Promise((resolve, reject) =>
                file.load_contents_async(null, (obj, res) => {
                    const [ok, contents] = obj.load_contents_finish(res);
                    if (ok) resolve(contents);
                    else reject(new Error('WinV: failed reading image blob'));
                }));
        }

        const entry = new ClipboardEntry(mimetype, bytes, favorite);
        if (jsonEntry.tag) entry.setTag(jsonEntry.tag);
        if (jsonEntry.timestamp) entry.#timestamp = jsonEntry.timestamp;
        return entry;
    }

    constructor(mimetype, bytes, favorite = false) {
        this.#mimetype = mimetype;
        // Store a copy so the caller's buffer mutations can't corrupt us.
        this.#bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this.#favorite = favorite;
        this.#timestamp = Date.now();
    }

    mimetype() { return this.#mimetype; }
    asBytes() { return GLib.Bytes.new(this.#bytes); }
    isFavorite() { return this.#favorite; }
    set favorite(v) { this.#favorite = !!v; }
    isText() { return ClipboardEntry.isTextMimetype(this.#mimetype); }
    isImage() { return this.#mimetype.startsWith('image/'); }
    getTag() { return this.#tag; }
    setTag(tag) { this.#tag = tag || null; }
    getTimestamp() { return this.#timestamp || 0; }
    setTimestamp(ts) { this.#timestamp = ts; }

    // Human-readable text (for search + row preview).
    getStringValue() {
        if (this.isImage()) return `[Image ${this.asBytes().hash()}]`;
        return new TextDecoder().decode(this.#bytes);
    }

    // Content hash for dedup (SHA256 hex). Stable across runs.
    hash() {
        return GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, this.asBytes());
    }

    equals(other) {
        return other && this.hash() === other.hash();
    }
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
            GLib.mkdir_with_parents(this.CACHE_DIR, parseInt('0775', 8));
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
        const file = Gio.file_new_for_path(path);
        await new Promise((resolve, reject) =>
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    const stream = obj.replace_finish(res);
                    stream.write_bytes_async(entry.asBytes(), GLib.PRIORITY_DEFAULT, null,
                        (w_obj, w_res) => {
                            w_obj.write_bytes_finish(w_res);
                            stream.close(null);
                            resolve();
                        });
                }));
    }

    async deleteEntryFile(entry) {
        if (!entry.isImage()) return;
        const path = this.imageFilePath(entry);
        if (!GLib.file_test(path, FileTest.EXISTS)) return;
        try {
            const file = Gio.file_new_for_path(path);
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
        const file = Gio.file_new_for_path(this.REGISTRY_PATH);
        return new Promise(resolve =>
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    const stream = obj.replace_finish(res);
                    stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null,
                        (w_obj, w_res) => {
                            w_obj.write_bytes_finish(w_res);
                            stream.close(null);
                            resolve();
                        });
                }));
    }

    async read() {
        if (!GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS)) return [];
        const file = Gio.file_new_for_path(this.REGISTRY_PATH);
        const [ok, contents] = await new Promise(resolve =>
            file.load_contents_async(null, (obj, res) =>
                resolve(obj.load_contents_finish(res))));
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

        const entries = (await Promise.all(registry.map(ClipboardEntry.fromJSON)))
            .filter(e => e !== null);

        // Enforce history-size, never dropping favorites.
        const maxSize = this.settings.get_int('history-size');
        let nonFavorite = entries.filter(e => !e.isFavorite());
        while (nonFavorite.length > maxSize) {
            const oldest = nonFavorite.shift();
            const idx = entries.indexOf(oldest);
            if (idx >= 0) entries.splice(idx, 1);
            nonFavorite = entries.filter(e => !e.isFavorite());
        }
        return entries;
    }

    async clearCacheFolder() {
        try {
            const folder = Gio.file_new_for_path(this.CACHE_DIR);
            const enumerator = folder.enumerate_children('', 1, null);
            let file;
            while ((file = enumerator.iterate(null)[2]) !== null)
                file.delete(null);
        } catch (e) {
            console.error('WinV clearCacheFolder:', e);
        }
    }
}
