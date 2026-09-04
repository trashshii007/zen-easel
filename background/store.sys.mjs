// Zen Easel — the store that owns the disk.
//
// Everything lives as plain files inside the Zen profile. No Firebase, no network,
// nothing that leaves the machine:
//
//   <root>/index.json             { easels: [{ id, title, createdAt, updatedAt, lastOpenedAt }], lastOpened }
//   <root>/easels/<id>.json       one document: objects + saved viewport
//   <root>/easels/<id>.thumb.png  card thumbnail for the library
//   <root>/assets/<id>/<uuid>.png captures and dropped images
//
// where <root> defaults to zen-easels/ inside the profile.
//
// Why this is a background module rather than part of the page: when the easel was an
// overlay, close() was guaranteed to run and could await the final write. A tab has no
// such guarantee — pagehide cannot await, and closing a tab mid-write would drop it. So
// the write queue and the shutdown blocker live here, outliving any page: pagehide only
// has to enqueue. It also means two easel tabs cannot race each other on index.json,
// and that zen-library can list easels without the easel mod's window scripts being
// loaded at all.
//
// The page boundary is plain data only. Documents cross as JSON strings, parsed and
// stringified in whichever global is going to use them, so neither side ends up holding
// an object belonging to the other.

import {
    isSafeId,
    isSafeAssetName,
    safeExtension
} from "chrome://sine/content/zen-easel/background/validate.sys.mjs";

// A system module is not a window: it has no timers of its own, and the DOM globals a
// window script takes for granted are simply absent here. Both of these have to be
// imported explicitly.
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const INDEX_VERSION = 1;

// How long an unreferenced asset is left alone before the sweep will delete it. Without
// this the sweep would race object creation: saveAsset writes the file, then the object
// referencing it is added to the document, and a sweep landing between the two would
// delete a file that is about to be used.
const ASSET_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_AUTOSAVE_MS = 500;

function prefStr(name, fallback) {
    try { return Services.prefs.getStringPref(name, fallback); } catch { return fallback; }
}

function prefInt(name, fallback) {
    try { return Services.prefs.getIntPref(name, fallback); } catch { return fallback; }
}

// Services.uuid rather than crypto.randomUUID: WebCrypto is a window global and is not
// dependable in a system module. generateUUID returns the braced form, which the id
// pattern in validate.sys.mjs rejects, so the braces come off.
function uuid() {
    try {
        return Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
    } catch (e) {
        return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
}

class EaselStoreImpl {
    constructor() {
        this._root = null;
        this._index = null;
        this._initPromise = null;

        // id -> { json, title, updatedAt }. One pending write per easel, latest wins:
        // an easel saved three times inside the debounce window is written once.
        this._pending = new Map();
        this._saveTimer = null;
        this._writing = Promise.resolve();
        this._blockerAdded = false;

        // Deletes in flight; flush() waits on these the way it drains _pending.
        this._deletes = new Set();
    }

    /* ---------------------------------------------------------------- paths */

    get root() {
        if (this._root) return this._root;
        const configured = prefStr("zen.easel.storage-dir", "").trim();
        this._root = configured || PathUtils.join(PathUtils.profileDir, "zen-easels");
        return this._root;
    }

    // Every path built from a caller-supplied string is validated at the point of
    // construction rather than at the call sites. The page sanitizer rejects bad names
    // too, but ids also arrive from index.json and lastOpened, which it never sees — and
    // PathUtils.join offers no traversal guarantee worth leaning on.
    _easelPath(id) {
        if (!isSafeId(id)) throw new Error(`unsafe easel id: ${id}`);
        return PathUtils.join(this.root, "easels", `${id}.json`);
    }

    _thumbPath(id) {
        if (!isSafeId(id)) throw new Error(`unsafe easel id: ${id}`);
        return PathUtils.join(this.root, "easels", `${id}.thumb.png`);
    }

    _assetDir(easelId) {
        if (!isSafeId(easelId)) throw new Error(`unsafe easel id: ${easelId}`);
        return PathUtils.join(this.root, "assets", easelId);
    }

    _assetPath(easelId, name) {
        if (!isSafeAssetName(name)) throw new Error(`unsafe asset name: ${name}`);
        return PathUtils.join(this._assetDir(easelId), name);
    }

    _indexPath() { return PathUtils.join(this.root, "index.json"); }

    /* ----------------------------------------------------------------- init */

    // Idempotent and safe to call from every page and from zen-library concurrently;
    // they all await the same promise.
    //
    // A *failed* init is deliberately not cached. Caching the promise unconditionally
    // meant one transient error — a locked profile directory, a disk hiccup during
    // startup — poisoned every later call for the lifetime of the process, and every
    // feature that reads the easel list went permanently dead with no way back but a
    // restart. Clearing it on rejection makes the next caller try again.
    init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            await IOUtils.makeDirectory(this.root, { createAncestors: true, ignoreExisting: true });
            await IOUtils.makeDirectory(PathUtils.join(this.root, "easels"), { createAncestors: true, ignoreExisting: true });
            await IOUtils.makeDirectory(PathUtils.join(this.root, "assets"), { createAncestors: true, ignoreExisting: true });

            this._index = await this._readIndexFile();

            // One blocker for the process, registered once. The overlay version had to
            // generate a unique name per store instance because opening and closing the
            // overlay built a new one each time and AsyncShutdown rejects duplicate
            // names; a singleton has no such problem.
            if (!this._blockerAdded) {
                try {
                    IOUtils.profileBeforeChange.addBlocker(
                        "Zen Easel: flush pending easels",
                        () => this.flush()
                    );
                    this._blockerAdded = true;
                } catch (e) {
                    console.error("[zen-easel] could not register shutdown blocker:", e);
                }
            }
        })().catch(e => {
            this._initPromise = null;
            throw e;
        });
        return this._initPromise;
    }

    async _readIndexFile() {
        const fallback = { version: INDEX_VERSION, easels: [], lastOpened: null, lastSweep: 0 };
        const path = this._indexPath();
        if (!(await IOUtils.exists(path))) return fallback;

        try {
            const data = await IOUtils.readJSON(path);
            if (!data || !Array.isArray(data.easels)) throw new Error("malformed index");
            return {
                version: data.version || INDEX_VERSION,
                // Filtering on isSafeId rather than typeof keeps an entry that could not
                // be opened without throwing out of every list we hand out.
                easels: data.easels.filter(e => e && isSafeId(e.id)),
                lastOpened: isSafeId(data.lastOpened) ? data.lastOpened : null,
                lastSweep: typeof data.lastSweep === "number" ? data.lastSweep : 0
            };
        } catch (e) {
            // Never let a bad index brick the feature. Keep the original next to the new
            // one so nothing is silently thrown away.
            console.error("[zen-easel] index unreadable, starting a fresh one:", e);
            try {
                await IOUtils.copy(path, `${path}.corrupt-${Date.now()}`, { noOverwrite: true });
            } catch (copyError) {
                console.error("[zen-easel] could not preserve the bad index:", copyError);
            }
            return fallback;
        }
    }

    /* ------------------------------------------------------------- the index */

    // Plain data, newest first. This is what zen-library renders from, and it works
    // whether or not any easel page is open.
    async listEasels() {
        await this.init();
        return this._index.easels
            .map(e => ({
                id: e.id,
                title: typeof e.title === "string" ? e.title : "Untitled Easel",
                createdAt: e.createdAt || 0,
                updatedAt: e.updatedAt || 0,
                lastOpenedAt: e.lastOpenedAt || 0,
                objectCount: typeof e.objectCount === "number" ? e.objectCount : 0
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async getLastOpened() {
        await this.init();
        return this._index.lastOpened;
    }

    // Called on every switch to an easel tab, not just on open, so the cheap paths matter:
    // an id we do not have an entry for is not "the last easel opened" — pointing
    // lastOpened at it would only send the next openLast() at a file that is not there —
    // and re-selecting the board that is already lastOpened writes nothing.
    async setLastOpened(id) {
        await this.init();
        if (!isSafeId(id)) return;
        const entry = this._index.easels.find(e => e.id === id);
        if (!entry) return;
        // Recency among boards only changes when lastOpened changes (A → B). Stamp
        // lastOpenedAt once on an older entry that predates the field, so a profile
        // upgraded into this version does not sort every board as never-opened.
        if (this._index.lastOpened === id) {
            if (!entry.lastOpenedAt) {
                entry.lastOpenedAt = Date.now();
                await this._writeIndex();
            }
            return;
        }
        this._index.lastOpened = id;
        entry.lastOpenedAt = Date.now();
        await this._writeIndex();
    }

    // Through the same promise chain the document writes use, for the reason _drain
    // gives: two overlapping writeJSON calls to index.json race on index.json.tmp and can
    // leave the real file missing. Every caller outside _drain comes in here — setLastOpened
    // now fires on tab switches, so landing one on top of an in-flight autosave is not the
    // theoretical case it was when only open() called it.
    _writeIndex() {
        const run = () => this._writeIndexNow();
        this._writing = this._writing.then(run, run);
        return this._writing;
    }

    async _writeIndexNow() {
        const path = this._indexPath();
        await IOUtils.writeJSON(path, this._index, { tmpPath: `${path}.tmp` });
    }

    /* ---------------------------------------------------------- documents */

    // Returns the document as a JSON string for the caller to parse in its own global,
    // or null when it is gone. A missing file drops the index entry, so the switcher
    // stops offering an easel that cannot be opened.
    async readDocument(id) {
        await this.init();
        if (!isSafeId(id)) {
            console.error("[zen-easel] refusing to read easel with unsafe id:", id);
            await this._forgetEasel(id);
            return null;
        }

        // Anything queued for this easel is newer than what is on disk.
        await this.flush();

        const path = this._easelPath(id);
        if (!(await IOUtils.exists(path))) {
            await this._forgetEasel(id);
            return null;
        }

        try {
            return await IOUtils.readUTF8(path);
        } catch (e) {
            console.error(`[zen-easel] could not read easel ${id}:`, e);
            return null;
        }
    }

    async _forgetEasel(id) {
        const before = this._index.easels.length;
        this._index.easels = this._index.easels.filter(e => e.id !== id);
        if (this._index.lastOpened === id) this._index.lastOpened = null;
        if (before !== this._index.easels.length || this._index.lastOpened === null) {
            await this._writeIndex();
        }
    }

    // Creates an empty easel and returns its index entry. The page builds the document
    // body itself; all this has to guarantee is that the id exists and the file is there.
    async createDocument(title = "Untitled Easel") {
        await this.init();
        const now = Date.now();
        const id = uuid();
        const entry = { id, title, createdAt: now, updatedAt: now, lastOpenedAt: now, objectCount: 0 };

        const body = {
            version: INDEX_VERSION,
            id, title, createdAt: now, updatedAt: now,
            // These two are the page's DEFAULT_BACKGROUND and DEFAULT_CANVAS_MODE
            // (modules/objects.uc.js), repeated as literals because this is a
            // per-process background module and that one is per window. "theme" is the
            // board with no colour of its own, so a new easel comes up matching Zen's
            // light or dark scheme; "verticallyScrolling" is the board that fits the
            // window rather than the fixed 3600-unit sheet. Written explicitly rather
            // than left out so a new document reads the same as an established one.
            background: "theme",
            canvasMode: "verticallyScrolling",
            viewport: { panX: 0, panY: 0, zoom: 1 },
            objects: []
        };
        // titleObjectId is deliberately absent rather than null. The page creates the
        // heading, because it needs the canvas geometry and text metrics to place and
        // measure it — and leaving the field undefined makes creating one and migrating an
        // older board the same code path.

        const path = this._easelPath(id);
        await IOUtils.writeJSON(path, body, { tmpPath: `${path}.tmp` });

        this._index.easels.push(entry);
        this._index.lastOpened = id;
        await this._writeIndex();

        return { entry, json: JSON.stringify(body) };
    }

    async renameEasel(id, title) {
        await this.init();
        if (!isSafeId(id)) return;
        const entry = this._index.easels.find(e => e.id === id);
        if (entry) entry.title = title;

        // A rename while a save is queued must not be overwritten by the older title.
        const pending = this._pending.get(id);
        if (pending) pending.title = title;

        await this._writeIndex();
    }

    // Tracked so the shutdown blocker waits for it: a pagehide delete during quit races profileBeforeChange.
    removeEasel(id) {
        const done = this._removeEasel(id);
        this._deletes.add(done);
        const forget = () => this._deletes.delete(done);
        done.then(forget, forget);
        return done;
    }

    async _removeEasel(id) {
        await this.init();
        if (!isSafeId(id)) return;

        // Drop the queued write first, or the debounce fires after the delete and
        // resurrects the file we just removed.
        this._pending.delete(id);

        this._index.easels = this._index.easels.filter(e => e.id !== id);
        if (this._index.lastOpened === id) this._index.lastOpened = null;

        // Index first: interrupted, that leaves an unreferenced file rather than a card opening onto nothing.
        await this._writeIndex();

        for (const remove of [
            () => IOUtils.remove(this._easelPath(id), { ignoreAbsent: true }),
            () => IOUtils.remove(this._thumbPath(id), { ignoreAbsent: true }),
            () => IOUtils.remove(this._assetDir(id), { recursive: true, ignoreAbsent: true })
        ]) {
            try { await remove(); } catch (e) { console.error("[zen-easel] delete:", e); }
        }
    }

    /* ---------------------------------------------------------------- saving */

    // json is the fully serialised document. Passing a string rather than the live
    // object is what keeps this module from holding a reference into a page's global,
    // which would pin that page's compartment alive after its tab closed.
    queueSave(id, json, meta = {}) {
        if (!isSafeId(id) || typeof json !== "string") return;

        const updatedAt = typeof meta.updatedAt === "number" ? meta.updatedAt : Date.now();
        this._pending.set(id, {
            json,
            title: meta.title,
            updatedAt,
            objectCount: typeof meta.objectCount === "number" ? meta.objectCount : undefined
        });

        if (this._index) {
            const entry = this._index.easels.find(e => e.id === id);
            if (entry) {
                entry.updatedAt = updatedAt;
                if (meta.title !== undefined) entry.title = meta.title;
                if (meta.objectCount !== undefined) entry.objectCount = meta.objectCount;
            }
        }

        if (this._saveTimer) return;
        const delay = Math.max(0, prefInt("zen.easel.autosave-ms", DEFAULT_AUTOSAVE_MS));
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._drain().catch(e => console.error("[zen-easel] autosave failed:", e));
        }, delay);
    }

    // Writes are serialised through a single promise chain. Two overlapping writeJSON
    // calls to the same path race on the temp file and can leave the real file missing.
    _drain() {
        const run = async () => {
            while (this._pending.size) {
                const [id, item] = this._pending.entries().next().value;
                this._pending.delete(id);
                try {
                    const path = this._easelPath(id);
                    await IOUtils.writeUTF8(path, item.json, { tmpPath: `${path}.tmp` });
                } catch (e) {
                    console.error(`[zen-easel] could not write easel ${id}:`, e);
                }
            }
            try {
                // _writeIndexNow, not _writeIndex: this already *is* the write chain, and
                // going through the wrapper would make run() await the promise it is.
                if (this._index) await this._writeIndexNow();
            } catch (e) {
                console.error("[zen-easel] could not write index:", e);
            }
        };
        this._writing = this._writing.then(run, run);
        return this._writing;
    }

    // Resolves once everything queued at the time of the call is on disk. This is what
    // the shutdown blocker awaits, and what pagehide fires and forgets.
    async flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        await this._drain();
        // allSettled: a failed delete logs where it happens, it must not take the blocker down.
        if (this._deletes.size) await Promise.allSettled([...this._deletes]);
        return this._writing;
    }

    /* ---------------------------------------------------------------- assets */

    async saveAsset(easelId, bytes, extension = "png") {
        await this.init();
        const dir = this._assetDir(easelId);
        const name = `${uuid()}.${safeExtension(extension)}`;
        await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
        const path = PathUtils.join(dir, name);
        await IOUtils.write(path, bytes, { tmpPath: `${path}.tmp` });
        return name;
    }

    // Returns raw bytes. The caller wraps them in a Blob in its own global immediately,
    // so nothing of this module's escapes into a page beyond the one array.
    async readAsset(easelId, name) {
        await this.init();
        return IOUtils.read(this._assetPath(easelId, name));
    }

    async writeThumbnail(easelId, bytes) {
        await this.init();
        const path = this._thumbPath(easelId);
        await IOUtils.write(path, bytes, { tmpPath: `${path}.tmp` });
    }

    async readThumbnail(easelId) {
        await this.init();
        const path = this._thumbPath(easelId);
        if (!(await IOUtils.exists(path))) return null;
        try {
            return await IOUtils.read(path);
        } catch (e) {
            return null;
        }
    }

    /* --------------------------------------------------------------- garbage */

    // Deleting an object, or undoing the creation of one, only ever touched the JSON —
    // the PNG behind it stayed on disk forever. So did every .tmp left by an interrupted
    // write, and every asset directory belonging to an easel whose delete crashed
    // between the index write and the remove.
    //
    // Best-effort throughout: this is housekeeping, and failing to reclaim a few
    // kilobytes must never surface to the user or interrupt what they were doing.
    async collectGarbage() {
        await this.init();

        const now = Date.now();
        if (now - (this._index.lastSweep || 0) < SWEEP_INTERVAL_MS) return;
        this._index.lastSweep = now;

        try {
            await this._sweepOrphanDirectories();
            for (const entry of this._index.easels.slice()) {
                await this._sweepEaselAssets(entry.id);
            }
            await this._writeIndex();
        } catch (e) {
            console.error("[zen-easel] asset sweep failed:", e);
        }
    }

    async _sweepOrphanDirectories() {
        const assetsRoot = PathUtils.join(this.root, "assets");
        if (!(await IOUtils.exists(assetsRoot))) return;

        const known = new Set(this._index.easels.map(e => e.id));
        const cutoff = Date.now() - ASSET_GRACE_MS;

        for (const path of await IOUtils.getChildren(assetsRoot)) {
            const name = PathUtils.filename(path);
            if (known.has(name)) continue;
            // Anything unrecognised is left alone unless it is old enough to be
            // certain: a directory created moments ago may belong to an easel whose
            // index entry has not been written yet.
            try {
                const stat = await IOUtils.stat(path);
                if (stat.lastModified >= cutoff) continue;
                await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
            } catch (e) { }
        }
    }

    async _sweepEaselAssets(easelId) {
        let dir;
        try {
            dir = this._assetDir(easelId);
        } catch (e) {
            return; // unsafe id; _sweepOrphanDirectories deals with the directory
        }
        if (!(await IOUtils.exists(dir))) return;

        let objects;
        try {
            const raw = JSON.parse(await IOUtils.readUTF8(this._easelPath(easelId)));
            objects = Array.isArray(raw.objects) ? raw.objects : [];
        } catch (e) {
            // Cannot read the document, so cannot know what it references. Deleting on
            // that basis would be destroying data to save space.
            return;
        }

        // Every field anywhere in the document that names a file in this directory. A
        // field missing from this list is not a leak — it is the opposite, and worse: the
        // sweep would see a file nothing claims and delete something still in use.
        const used = new Set();
        for (const obj of objects) {
            if (obj && obj.image && obj.image.asset) used.add(obj.image.asset);
            if (obj && obj.webcard && obj.webcard.asset) used.add(obj.webcard.asset);
            // A web tile's poster. Rewritten every time a tile is stopped, so the ones it
            // replaces are exactly what this sweep is for — but only the ones it replaces.
            if (obj && obj.webBrowser && obj.webBrowser.poster) used.add(obj.webBrowser.poster);
        }

        const cutoff = Date.now() - ASSET_GRACE_MS;
        for (const path of await IOUtils.getChildren(dir)) {
            const name = PathUtils.filename(path);
            if (used.has(name)) continue;
            try {
                const stat = await IOUtils.stat(path);
                // .tmp files from a crashed atomic write are swept on the same grace
                // period; a live one belongs to a write still in flight.
                if (stat.lastModified >= cutoff) continue;
                await IOUtils.remove(path, { ignoreAbsent: true });
            } catch (e) { }
        }
    }
}

// One instance per process, which is the whole point of this file.
export const EaselStore = new EaselStoreImpl();
