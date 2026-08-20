// Zen Easel — the page's view of the store.
//
// The disk is owned by background/store.sys.mjs, a per-process singleton. This is the
// per-page half: it holds the open document, the blob: URL cache for assets (blob URLs
// belong to a window, so they cannot live in the background module), and the debounce
// that keeps a pan gesture from serialising the document sixty times a second.
//
// The split exists because a tab cannot promise to finish writing. pagehide cannot
// await, so the last save has to be handed to something that outlives the page — and
// once the queue is over there, two easel tabs can no longer race on index.json either.
//
// The public surface is unchanged from the version that owned its own files, so the
// canvas, renderer and switcher call it exactly as before.

"use strict";

(function () {
    if (window.ZenEaselStore) return;

    const { EaselStore } =
        ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/store.sys.mjs");

    const DOC_VERSION = 1;

    // Asset names are constrained to these five extensions by validate.sys.mjs, so the
    // map is total over what can actually be on disk and the fallback is unreachable
    // rather than a guess.
    const MIME_TYPES = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        avif: "image/avif"
    };

    const MIME_BY_EXTENSION = name => {
        const extension = String(name || "").split(".").pop().toLowerCase();
        return MIME_TYPES[extension] || "application/octet-stream";
    };

    // Rasterising the board is the most expensive thing here, so a thumbnail is refreshed
    // at most this often. A stale-by-a-minute tile in the library is not a problem; a
    // re-render on every save would be.
    const THUMBNAIL_INTERVAL_MS = 60_000;

    // The most objects a document will be opened with. See _hydrate. Far above anything a
    // board reaches by being drawn on — this exists so a corrupted file degrades instead of
    // wedging the page.
    const MAX_OBJECTS = 20_000;

    class ZenEaselStore {
        constructor(host) {
            this.host = host;
            this.log = (window.ZenEaselUtil && window.ZenEaselUtil.log) || (() => { });

            this._doc = null;
            this._saveTimer = null;
            this._destroyed = false;

            // asset name -> blob: URL. Blob URLs, not file:// — this profile path
            // contains a space and parentheses, and every file:// URL built from it is
            // a quoting bug waiting to happen.
            this._assetUrls = new Map();
            this._assetLoads = new Set();

            // Set by the canvas so a late-arriving image can trigger a repaint.
            this.onAssetLoaded = null;

            // Last time a thumbnail was rasterised, per easel id.
            this._thumbAt = new Map();
        }

        async init() {
            await EaselStore.init();
            this.log("store ready");
        }

        /* ------------------------------------------------------------ documents */

        listEasels() {
            // Synchronous by contract — the switcher renders from it during a click.
            // Kept warm by refreshList(); a caller that needs it current awaits that.
            return this._easels || [];
        }

        async refreshList() {
            this._easels = await EaselStore.listEasels();
            return this._easels;
        }

        get current() { return this._doc; }

        async openLast() {
            await this.refreshList();

            const wanted = await EaselStore.getLastOpened();
            if (wanted && this._easels.some(e => e.id === wanted)) {
                const doc = await this.open(wanted);
                if (doc) return doc;
            }
            const first = this._easels[0];
            if (first) {
                const doc = await this.open(first.id);
                if (doc) return doc;
            }
            return this.create("Untitled Easel");
        }

        async open(id) {
            await this.flush();
            this._releaseAssets();

            const json = await EaselStore.readDocument(id);
            if (!json) {
                await this.refreshList();
                return null;
            }

            let raw;
            try {
                raw = JSON.parse(json);
            } catch (e) {
                console.error(`[zen-easel] easel ${id} is not valid JSON:`, e);
                return null;
            }

            this._doc = this._hydrate(id, raw);
            await EaselStore.setLastOpened(id);
            await this.refreshList();
            return this._doc;
        }

        // Parsed in this global, so the document the canvas mutates belongs to the page
        // and nothing of the background module's leaks into it.
        _hydrate(id, raw) {
            const Objects = window.ZenEaselObjects;

            // A truncated document must never be written back, and that is the whole reason
            // this is a flag rather than just a slice. _handOff serialises doc.objects; a
            // board opened with the first 20 000 of 50 000 objects would, on the very next
            // autosave, overwrite the file with the 20 000 — turning a display limit into
            // permanent data loss. So the board opens read-only and the file is left alone.
            const truncated = Array.isArray(raw.objects) && raw.objects.length > MAX_OBJECTS;
            if (truncated) {
                console.error(
                    `[zen-easel] easel ${id} holds ${raw.objects.length} objects; ` +
                    `opening the first ${MAX_OBJECTS}, read-only`
                );
                // Deferred: the toast goes through the chrome window, which is not
                // necessarily reachable yet during boot.
                window.setTimeout(() => this.host.toast(
                    `This board has more objects than the easel can draw, so it has opened ` +
                    `read-only showing the first ${MAX_OBJECTS}. Nothing will be saved over the file.`
                ), 0);
            }

            // The palette resolves colour keys for the whole module, so it has to be in
            // force before anything paints — hydrate is the one place that runs for every
            // way a document can be opened.
            const palette = Objects.setPalette(raw.palette);
            return {
                id,
                // Read by markDirty() and _handOff(). Absent on every normal document.
                readOnly: truncated,
                title: typeof raw.title === "string" ? raw.title : "Untitled Easel",
                createdAt: raw.createdAt || Date.now(),
                updatedAt: raw.updatedAt || Date.now(),
                palette,
                // undefined means "this board has never had a heading, give it one".
                // Any string — including one pointing at an object that has since been
                // deleted — means the question has already been settled for this easel.
                titleObjectId: typeof raw.titleObjectId === "string" ? raw.titleObjectId : undefined,
                // Arc's CanvasMode. Only the two known values survive, so a hand-edited
                // or half-written field can never leave a board unopenable — anything
                // else, including a board saved before the field existed, opens on the
                // default. A board explicitly saved as "fixed" keeps its fixed page.
                canvasMode: raw.canvasMode === "fixed"
                    ? "fixed"
                    : raw.canvasMode === "verticallyScrolling"
                        ? "verticallyScrolling"
                        : Objects.DEFAULT_CANVAS_MODE,
                lastLaidOutAtCanvasWidth:
                    typeof raw.lastLaidOutAtCanvasWidth === "number" &&
                    raw.lastLaidOutAtCanvasWidth > 0 ? raw.lastLaidOutAtCanvasWidth : null,
                // Goes through resolveBackground rather than a membership test, so a
                // board saved under a key that has since been renamed — "sage", now
                // "transparent" — moves across instead of reverting to the default.
                background: Objects.resolveBackground(raw.background),
                viewport: this._sanitizeViewport(raw.viewport),
                // Capped. sanitize() bounds what any single object may contain, but not how
                // many there are, and the count is what the paint loop and the hit test are
                // linear in. A hand-edited or half-written document with a runaway object
                // list used to make the page unresponsive on open with no way back to it;
                // now the board opens with the first MAX_OBJECTS and says so.
                objects: Array.isArray(raw.objects)
                    ? raw.objects.slice(0, MAX_OBJECTS).map(o => Objects.sanitize(o)).filter(Boolean)
                    : []
            };
        }

        _sanitizeViewport(v) {
            const ok = n => typeof n === "number" && Number.isFinite(n);
            if (!v || !ok(v.panX) || !ok(v.panY) || !ok(v.zoom)) return { panX: 0, panY: 0, zoom: 1 };
            return { panX: v.panX, panY: v.panY, zoom: Math.min(4, Math.max(0.1, v.zoom)) };
        }

        async create(title = "Untitled Easel") {
            await this.flush();
            this._releaseAssets();

            const { entry, json } = await EaselStore.createDocument(title);
            this._doc = this._hydrate(entry.id, JSON.parse(json));
            await this.refreshList();
            return this._doc;
        }

        async rename(id, title) {
            await EaselStore.renameEasel(id, title);
            if (this._doc && this._doc.id === id) {
                this._doc.title = title;
                this.markDirty();
            }
            await this.refreshList();
        }

        async remove(id) {
            if (this._doc && this._doc.id === id) {
                // Cancel the pending save first, or the debounce fires after the delete
                // and resurrects the file we just removed.
                this._cancelPendingSave();
                this._releaseAssets();
                this._doc = null;
            }
            await EaselStore.removeEasel(id);
            await this.refreshList();
        }

        /* --------------------------------------------------------------- saving */

        // Runs on every mutation, which includes every frame of a pan or zoom. The
        // debounce is here rather than in the background module specifically so that
        // JSON.stringify happens once per settled gesture instead of once per frame.
        markDirty() {
            // A board that was truncated on load is showing less than the file holds, so
            // saving it would delete the difference. See _hydrate.
            if (this._destroyed || !this._doc || this._doc.readOnly) return;
            this._doc.updatedAt = Date.now();

            if (this._saveTimer) return;
            const delay = Math.max(0, window.ZenEaselUtil.prefs["autosave-ms"]);
            this._saveTimer = window.setTimeout(() => {
                this._saveTimer = null;
                this._handOff();
            }, delay);
        }

        _cancelPendingSave() {
            if (this._saveTimer) {
                window.clearTimeout(this._saveTimer);
                this._saveTimer = null;
            }
        }

        // Serialises the document and hands it to the background queue. Synchronous on
        // purpose: pagehide cannot await, and this is the last thing that runs there.
        _handOff() {
            // The backstop for readOnly. markDirty() already declines to schedule a save,
            // but flush() and handOffForUnload() call this directly.
            if (!this._doc || this._doc.readOnly) return;
            const doc = this._doc;
            EaselStore.queueSave(doc.id, JSON.stringify({
                version: DOC_VERSION,
                id: doc.id,
                title: doc.title,
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt,
                palette: doc.palette || window.ZenEaselObjects.DEFAULT_PALETTE,
                // JSON.stringify drops undefined, so a board that has never had a heading
                // has no key at all on disk — which is exactly the state _hydrate reads
                // back as "give this one a heading".
                titleObjectId: doc.titleObjectId,
                canvasMode: doc.canvasMode || window.ZenEaselObjects.DEFAULT_CANVAS_MODE,
                lastLaidOutAtCanvasWidth: doc.lastLaidOutAtCanvasWidth || null,
                documentHeightAsFactorOfWidth: doc.documentHeightAsFactorOfWidth || null,
                background: doc.background || window.ZenEaselObjects.DEFAULT_BACKGROUND,
                viewport: doc.viewport,
                objects: doc.objects
            }), {
                title: doc.title,
                updatedAt: doc.updatedAt,
                objectCount: doc.objects.length
            });
        }

        // Resolves once this page's work is on disk.
        async flush() {
            this._cancelPendingSave();
            this._handOff();
            // Forced: every caller of flush() is finishing with a board — switching away
            // from it, or closing it — which is exactly when its tile should be current.
            await this.writeThumbnail({ force: true });
            await EaselStore.flush();
        }

        /* ------------------------------------------------------------ thumbnails */

        // The library shows a grid of boards, and a thumbnail identifies one far faster
        // than its title does — which is the whole reason Arc has EaselPreviewThumbnail.
        //
        // Deliberately not on markDirty: that fires 500ms after every stroke, and
        // rasterising the board per stroke would be the most expensive thing the mod does.
        // It runs on flush and on page hide instead, rate-limited, so the cost lands when
        // the work is already finished.
        async writeThumbnail({ force = false } = {}) {
            const doc = this._doc;
            // readOnly: the board on screen is a partial view of the file, so a thumbnail
            // rasterised from it would misrepresent the easel in the library.
            if (!doc || this._destroyed || doc.readOnly) return;

            const renderer = this.host.renderer;
            if (!renderer || typeof renderer.snapshot !== "function") return;

            const last = this._thumbAt.get(doc.id) || 0;
            if (!force && Date.now() - last < THUMBNAIL_INTERVAL_MS) return;
            this._thumbAt.set(doc.id, Date.now());

            try {
                // A library tile is a small opaque card, so a board with no colour of
                // its own — theme, or transparent — gets white rather than a
                // see-through thumbnail that would pick up whatever is behind it.
                const fill = window.ZenEaselObjects.backgroundFill(doc.background);
                const bytes = await renderer.snapshot(doc.objects, {
                    // 4/3, matching the card in zen-library's easels.css. Twice the CSS
                    // size so the tile stays sharp on a HiDPI display.
                    maxWidth: 640,
                    maxHeight: 480,
                    padding: 24,
                    background: fill || "#FFFFFF"
                });
                if (bytes) await EaselStore.writeThumbnail(doc.id, bytes);
            } catch (e) {
                // A board with no thumbnail is a placeholder tile, not a broken easel.
                this.log("could not write a thumbnail:", e.message);
            }
        }

        // The tab is going away and there is no time to await anything. Handing the
        // document to the background queue is enough: its shutdown blocker owns the
        // guarantee from here, whether the browser is quitting or just closing a tab.
        handOffForUnload() {
            this._cancelPendingSave();
            this._handOff();
        }

        /* --------------------------------------------------------------- assets */

        async saveAsset(bytes, extension = "png") {
            if (!this._doc) throw new Error("no easel open");
            return EaselStore.saveAsset(this._doc.id, bytes, extension);
        }

        // Synchronous by design: renderers run during layout and cannot await. A miss
        // returns null, starts the read, and repaints when it lands.
        resolveAsset(name) {
            if (!name) return null;
            if (this._assetUrls.has(name)) return this._assetUrls.get(name);
            if (!this._assetLoads.has(name)) {
                this._assetLoads.add(name);
                this._loadAsset(name).catch(e => console.error(`[zen-easel] asset ${name} failed:`, e));
            }
            return null;
        }

        async _loadAsset(name) {
            if (!this._doc) return;
            const easelId = this._doc.id;
            try {
                const bytes = await EaselStore.readAsset(easelId, name);
                // The easel may have been switched while this read was in flight;
                // caching the blob against the new document would show the wrong image.
                if (this._destroyed || !this._doc || this._doc.id !== easelId) return;
                // Copied into this global rather than held as-is: the Blob keeps the
                // backing buffer alive, and it should be this window's.
                //
                // With a type, not bare. An untyped Blob leaves the consumer sniffing,
                // which happens to work for a still image and is a poor thing to depend
                // on for an animated one — the decoder is being asked to commit to a
                // format before it has decided what it is looking at.
                const url = URL.createObjectURL(
                    new Blob([new Uint8Array(bytes)], { type: MIME_BY_EXTENSION(name) })
                );
                this._assetUrls.set(name, url);
                if (this.onAssetLoaded) this.onAssetLoaded(name);
            } finally {
                this._assetLoads.delete(name);
            }
        }

        // Blob URLs are held by the window until explicitly revoked, so an easel with
        // many captures would leak its whole image set on every switch.
        _releaseAssets() {
            for (const url of this._assetUrls.values()) {
                try { URL.revokeObjectURL(url); } catch (e) { }
            }
            this._assetUrls.clear();
            this._assetLoads.clear();
        }

        collectGarbage() {
            return EaselStore.collectGarbage();
        }

        destroy() {
            this._destroyed = true;
            this.handOffForUnload();
            this._releaseAssets();
        }
    }

    // Lists easels without constructing a store. zen-library uses this, and it works
    // with none of the easel mod's window scripts loaded.
    ZenEaselStore.readIndex = function readIndex() {
        return EaselStore.listEasels();
    };

    window.ZenEaselStore = ZenEaselStore;
})();
