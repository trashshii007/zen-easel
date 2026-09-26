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
    const { assetKind } =
        ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/validate.sys.mjs");

    const DOC_VERSION = 1;

    // The name every easel is created with, matching createDocument's default and the
    // canvas's DEFAULT_TITLE. A board still carrying it is one nobody has named.
    const DEFAULT_TITLE = "Untitled Easel";

    // Asset names are constrained to the extensions validate.sys.mjs accepts, so the map
    // is total over what can actually be on disk and the fallback is unreachable rather
    // than a guess. It matters more for the disk-backed kinds than it did for images: a
    // File built from a path takes its type from the OS, which on Windows has none for
    // .flac, .opus or .weba, and a typeless source is one the media element refuses.
    const MIME_TYPES = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        avif: "image/avif",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        ico: "image/x-icon",
        mp4: "video/mp4",
        m4v: "video/mp4",
        // QuickTime is the container the MP4 demuxer grew from; whether video/quicktime itself is refused is unverified, so the probe decides.
        mov: "video/mp4",
        mkv: "video/x-matroska",
        webm: "video/webm",
        ogv: "video/ogg",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        oga: "audio/ogg",
        opus: "audio/ogg",
        flac: "audio/flac",
        m4a: "audio/mp4",
        aac: "audio/aac",
        weba: "audio/webm",
        pdf: "application/pdf"
    };

    const MIME_BY_EXTENSION = name => {
        const extension = String(name || "").split(".").pop().toLowerCase();
        return MIME_TYPES[extension] || "application/octet-stream";
    };

    // Rasterising the board is the most expensive thing here, so a thumbnail is refreshed
    // at most this often. A stale-by-a-minute tile in the library is not a problem; a
    // re-render on every save would be.
    const THUMBNAIL_INTERVAL_MS = 60_000;

    // How old an unused file must be before an in-session sweep deletes it: an ingest places its object within ms of the file landing (import stamps mtime after the copy).
    const IN_SESSION_GRACE_MS = 10_000;

    // The most objects a document will be opened with. See _hydrate. Far above anything a
    // board reaches by being drawn on — this exists so a corrupted file degrades instead of
    // wedging the page.
    const MAX_OBJECTS = 20_000;

    class ZenEaselStore {
        // The type a disk-backed File is given for an asset name — shared with the ingest probe so the two agree.
        static mimeFor(name) { return MIME_BY_EXTENSION(name); }

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

            // Asset names a sweep was told it may move to the trash, and those being moved into place (from the trash, or from another board by a paste).
            this._parkable = new Set();
            this._held = new Map();   // name -> holds outstanding

            // Set by the canvas so a late-arriving image can trigger a repaint.
            this.onAssetLoaded = null;

            // Last time a thumbnail was rasterised, per easel id.
            this._thumbAt = new Map();

            // A glance satellite is writing this board; this page's copy is stale and
            // must not reach disk. See freezeWrites / reloadFromDisk.
            this._frozen = false;

            // What the open board looked like when it was created, or null once it holds
            // anything of its own. See isPristine.
            this._pristine = null;
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
            await this._letGoOfDocument();
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

            // Colours are hex now. A board written before that stores keys, and this is which of Arc's two palettes they meant —
            // defaulted rather than passed raw, or a file with no palette field at all would resolve every key to black.
            const legacyPalette = raw.palette === "chill" ? "chill" : "vibrant";

            // A file holding nothing at all is a board that was created and never written
            // to: no objects, no heading yet, and still called what it was created as.
            // Read from raw rather than from the document below because the canvas adds a
            // heading the moment it opens one of these — by the time anything asks, the
            // board is no longer literally empty. See isPristine.
            const bornEmpty = (!Array.isArray(raw.objects) || raw.objects.length === 0)
                && raw.titleObjectId === undefined
                && raw.title === DEFAULT_TITLE;

            const doc = {
                id,
                // Read by markDirty() and _handOff(). Absent on every normal document.
                readOnly: truncated,
                title: typeof raw.title === "string" ? raw.title : "Untitled Easel",
                createdAt: raw.createdAt || Date.now(),
                updatedAt: raw.updatedAt || Date.now(),
                // Capped on the way in as well as on the way out: a hand-edited file could otherwise put thousands of swatches
                // into the picker, the same reason MAX_OBJECTS and MAX_TEXT_LENGTH exist.
                recentColors: Array.isArray(raw.recentColors)
                    ? raw.recentColors.map(c => Objects.normalizeColor(c))
                        .filter(Boolean).slice(0, Objects.RECENT_LIMIT)
                    : [],
                // undefined means "this board has never had a heading, give it one".
                // Any string — including one pointing at an object that has since been
                // deleted — means the question has already been settled for this easel.
                titleObjectId: typeof raw.titleObjectId === "string" ? raw.titleObjectId : undefined,
                // Only the two known values survive, so a hand-edited or half-written
                // field can never leave a board unopenable — anything else, including a
                // board saved before the field existed, opens on the default. "fixed" is
                // the retired 3600-unit sheet: it opens as infinite, the one mode that can
                // show a page wider than the window without cutting anything off.
                canvasMode: raw.canvasMode === "infinite" || raw.canvasMode === "fixed"
                    ? "infinite"
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
                    ? raw.objects.slice(0, MAX_OBJECTS)
                        .map(o => Objects.sanitize(o, legacyPalette)).filter(Boolean)
                    : []
            };

            // Snapshotted rather than compared against the defaults so the check cannot
            // drift if those ever change: what counts as untouched is what this board
            // arrived as, not what a board created today would arrive as.
            this._pristine = bornEmpty
                ? { background: doc.background, canvasMode: doc.canvasMode }
                : null;

            return doc;
        }

        _sanitizeViewport(v) {
            const ok = n => typeof n === "number" && Number.isFinite(n);
            if (!v || !ok(v.panX) || !ok(v.panY) || !ok(v.zoom)) return { panX: 0, panY: 0, zoom: 1 };
            return { panX: v.panX, panY: v.panY, zoom: Math.min(4, Math.max(0.1, v.zoom)) };
        }

        async create(title = DEFAULT_TITLE) {
            await this._letGoOfDocument();
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

        // A board that was created and never used. Every easel exists on disk from the
        // moment its id does — createDocument writes the file and the index entry before
        // any page sees it — so opening one and closing the tab used to leave an
        // "Untitled Easel" behind in the library that nobody asked for.
        //
        // The heading does not count against it. The canvas gives every new board one
        // (see _ensureTitleHeading), so a board with nothing on it is not empty by the
        // time this is asked: it holds exactly the heading, still reading the name the
        // easel was created with. A named board is never pristine — typing a name into
        // "New easel" is already an act worth keeping — and neither is one whose
        // background or page mode was changed.
        isPristine() {
            const doc = this._doc;
            const born = this._pristine;
            if (!doc || !born) return false;
            if (doc.title !== DEFAULT_TITLE) return false;
            if (doc.background !== born.background || doc.canvasMode !== born.canvasMode) return false;
            if (doc.objects.length === 0) return true;
            if (doc.objects.length > 1) return false;

            const [only] = doc.objects;
            return only.id === doc.titleObjectId && only.type === "text"
                && only.text.content === DEFAULT_TITLE;
        }

        // Takes an untouched board back off disk. Returns the delete so a caller that can
        // wait may, or null when there is nothing to take back.
        //
        // The document is dropped here rather than left in place: markDirty and _handOff
        // both refuse without one, so a stray save arriving after the delete cannot write
        // the file back with no index entry pointing at it.
        _discardIfPristine() {
            // Frozen means this copy is stale, and another view means it is not ours to delete.
            if (this._frozen) return null;
            if (!this.isPristine()) return null;
            if (this._hasOtherView()) return null;
            const id = this._doc.id;
            this._cancelPendingSave();
            this._pristine = null;
            this._doc = null;
            return EaselStore.removeEasel(id).catch(
                e => console.error(`[zen-easel] could not discard the empty easel ${id}:`, e));
        }

        // Synchronous because pagehide asks; unreachable answers "yes", since it only gates a delete.
        _hasOtherView() {
            const id = this._doc?.id;
            if (!id) return false;
            try {
                const bridge = this.host?.bridge;
                if (!bridge || typeof bridge.hasOtherViewOf !== "function") return true;
                return bridge.hasOtherViewOf(id, window.browsingContext?.embedderElement ?? null);
            } catch (e) {
                return true;
            }
        }

        // This page is finished with the board it holds: either its work goes to disk, or
        // — if nothing was ever put on it — the board itself goes away.
        async _letGoOfDocument() {
            const discarded = this._discardIfPristine();
            if (discarded) {
                await discarded;
                return;
            }
            const id = this._doc?.id;
            await this.flush();
            // The object clipboard outlives a board switch, so what it holds is kept.
            this._sweepOnLetGo(id, this.host?.canvas?.clipboardAssets?.() ?? []);
        }

        // While the board is open, after a save: a file the board and the object clipboard no
        // longer name leaves the board's asset directory. If undo or redo could bring its
        // object back it moves to the board's trash (and back again, via restoreFromTrash);
        // otherwise it is deleted, once IN_SESSION_GRACE_MS old so a file an ingest is still
        // placing is never taken, with a retry when a skipped file is old enough. Runs on the
        // first save of a board and after that only when either set shrank, so an ordinary
        // save costs two set comparisons.
        _sweepIfReleased(force = false) {
            const id = this._doc?.id;
            const canvas = this.host?.canvas;
            if (!id || typeof canvas?.retainedAssets !== "function") return;
            const live = new Set(canvas.liveAssets());
            const retained = new Set(canvas.retainedAssets());
            const before = this._sweepState;
            this._sweepState = { id, live, retained };
            const shrank = (from, to) => [...from].some(name => !to.has(name));
            const changed = force || !before || before.id !== id ||
                shrank(before.live, live) || shrank(before.retained, retained);
            if (!changed || this._frozen || this._hasOtherView()) return;
            const park = [...retained].filter(name => !live.has(name));
            for (const name of park) this._parkable.add(name);
            EaselStore.sweepEasel(id, [...live], { graceMs: IN_SESSION_GRACE_MS, park })
                .then(retryIn => {
                    if (!(retryIn > 0) || this._destroyed || this._doc?.id !== id) return;
                    this._cancelSweepRetry();
                    this._sweepRetry = window.setTimeout(() => {
                        this._sweepRetry = null;
                        if (!this._destroyed && this._doc?.id === id) this._sweepIfReleased(true);
                    }, retryIn + 250);
                })
                .catch(e => console.error(`[zen-easel] could not clear unused files of ${id}:`, e));
        }

        // Called by the canvas after an undo or redo with the board's asset names. Any a sweep
        // may have moved to the trash are held back from loading — a load of a missing file
        // is remembered as a failure — until they are back in place, then repainted.
        // A name that is back in place leaves _parkable, so later undos do not re-read it; a
        // sweep that parks it again puts it back.
        restoreFromTrash(names) {
            const id = this._doc?.id;
            if (!id) return;
            const wanted = names.filter(name => this._parkable.has(name));
            this._holdLoads(id, wanted, () => EaselStore.restoreFromTrash(id, wanted).then(present => {
                if (this._doc?.id !== id) return;
                for (const name of present) this._parkable.delete(name);
            }), "could not restore from the trash:");
        }

        // A paste of objects copied on another board: their files are copied into this one
        // under the same names, and held back from loading until they are there.
        adoptAssets(fromId, names) {
            const id = this._doc?.id;
            if (!id || !fromId || fromId === id) return;
            this._holdLoads(id, names, () => EaselStore.copyAssets(fromId, id, names),
                "could not copy the pasted files:");
        }

        // Holds `names` back from resolveAsset while `work` moves them into place — a load of
        // a missing file is remembered as a failure — then repaints.
        _holdLoads(id, names, work, failure) {
            if (!names.length) return;
            for (const name of names) {
                this._held.set(name, (this._held.get(name) || 0) + 1);
                const url = this._assetUrls.get(name);
                if (url) { try { URL.revokeObjectURL(url); } catch (e) { } }
                this._assetUrls.delete(name);
            }
            work()
                .catch(e => console.error(`[zen-easel] ${failure}`, e))
                .finally(() => {
                    for (const name of names) {
                        const left = (this._held.get(name) || 1) - 1;
                        if (left > 0) this._held.set(name, left);
                        else this._held.delete(name);
                    }
                    if (!this._destroyed && this._doc?.id === id && this.onAssetLoaded) this.onAssetLoaded();
                });
        }

        _cancelSweepRetry() {
            if (this._sweepRetry) {
                window.clearTimeout(this._sweepRetry);
                this._sweepRetry = null;
            }
        }

        // Deletes the files this board no longer names, now that the page is finished with
        // it and its undo history is gone. Not for a frozen copy, which is not the writer,
        // nor while another view — a glance satellite with its own undo — is open; those
        // fall back to the daily sweep.
        _sweepOnLetGo(id, keep) {
            this._cancelSweepRetry();
            this._parkable.clear();
            if (!id || this._frozen || this._hasOtherView()) return;
            EaselStore.sweepEasel(id, keep)
                .catch(e => console.error(`[zen-easel] could not clear unused files of ${id}:`, e));
        }

        // Another view of this board — a glance satellite — has taken over as its writer.
        // The page stays loaded, as a pinned tab usually does, but everything that reaches
        // disk is gated on this until reloadFromDisk lifts it.
        freezeWrites() {
            this._frozen = true;
            this._cancelPendingSave();
        }

        // After the satellite has flushed. The file is the truth and this in-memory copy is
        // not, so there is deliberately no flush on the way in — that would write the stale
        // board straight back over it.
        //
        // The thaw is the last step rather than the first. Unfreezing before the read means
        // a mutation arriving during it schedules a save of the copy that is about to be
        // discarded, and the 500ms debounce is long enough for that save to land after the
        // new document is in place. A read that fails leaves the page frozen, which is the
        // safe end of that trade: a board that will not save until its tab is reloaded,
        // rather than one that overwrites the file with what it had before.
        async reloadFromDisk() {
            this._cancelPendingSave();
            const id = this._doc?.id;
            if (!id) return null;

            const json = await EaselStore.readDocument(id);
            if (!json) {
                await this.refreshList();
                // Off the index means deleted, not unreadable: thaw, or the tab can never save again.
                if (!this._easels.some(e => e.id === id)) {
                    this._releaseAssets();
                    this._doc = null;
                    this._pristine = null;
                    this._frozen = false;
                }
                return null;
            }

            let raw;
            try {
                raw = JSON.parse(json);
            } catch (e) {
                console.error(`[zen-easel] easel ${id} is not valid JSON:`, e);
                return null;
            }

            // Released only now that there is a document to replace this one with: a
            // failure above leaves the board painting from the blob URLs it already has.
            this._releaseAssets();
            this._doc = this._hydrate(id, raw);
            this._frozen = false;
            await this.refreshList();
            return this._doc;
        }

        // The same board written by somebody else while this page was not looking.
        //
        // freezeWrites / reloadFromDisk is the arranged handover, and it is driven from the
        // chrome window: it needs the original's tab to be found, its page to be reachable,
        // and the satellite's close to be noticed. In another workspace none of those are
        // certain — the pin may be discarded when the freeze goes out, the overlay may end
        // in a way that fires nothing — and a page that missed the handover holds a copy
        // older than the file and overwrites it on the next stroke.
        //
        // So the page settles it without being told. Every write puts its updatedAt in the
        // index, so a copy that is behind the index is a copy that has been overtaken.
        // Called when the board comes back into view, which is before it can be edited.
        async refreshIfStale() {
            if (this._destroyed || !this._doc) return null;
            // A save of our own is still pending, so this copy is the newer one — the
            // index is only behind because the debounce has not fired yet.
            if (this._saveTimer) return null;

            const entries = await EaselStore.listEasels();
            const entry = entries.find(e => e.id === this._doc.id);
            if (!entry || !(entry.updatedAt > (this._doc.updatedAt || 0))) return null;

            // Frozen for the duration of the read for the reason reloadFromDisk thaws
            // last: a mutation arriving mid-read must not schedule a save of the copy
            // that is about to be discarded.
            //
            // Put back on the way out, which is the opposite of what the arranged handover
            // wants and correct for the same reason. reloadFromDisk leaves a failed read
            // frozen deliberately: there a satellite has taken over as the board's writer,
            // so refusing to write is the safe end of the trade. Nothing has taken over
            // here — this runs unprompted on a tab switch — so a missing file or a bad
            // parse would strand a board the user is looking at with saving silently off
            // and nothing on screen to say so.
            const wasFrozen = this._frozen;
            this._frozen = true;
            let doc = null;
            try {
                doc = await this.reloadFromDisk();
            } catch (e) {
                this._frozen = wasFrozen;
                throw e;
            }
            // Not when the board went away: reloadFromDisk thawed deliberately there.
            if (!doc && this._doc) this._frozen = wasFrozen;
            return doc;
        }

        // Runs on every mutation, which includes every frame of a pan or zoom. The
        // debounce is here rather than in the background module specifically so that
        // JSON.stringify happens once per settled gesture instead of once per frame.
        markDirty() {
            // A board that was truncated on load is showing less than the file holds, so
            // saving it would delete the difference. See _hydrate.
            if (this._destroyed || this._frozen || !this._doc || this._doc.readOnly) return;
            this._doc.updatedAt = Date.now();

            if (this._saveTimer) return;
            const delay = Math.max(0, window.ZenEaselUtil.prefs["autosave-ms"]);
            this._saveTimer = window.setTimeout(() => {
                this._saveTimer = null;
                this._handOff();
                this._sweepIfReleased();
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
            if (this._frozen || !this._doc || this._doc.readOnly) return;
            // An untouched board is left exactly as it was created. Writing the heading
            // out would be harmless in itself, but it is what the file is read back
            // against: save it once and reopening the board finds objects on disk and
            // stops seeing it as one nobody has used. See isPristine.
            if (this.isPristine()) return;
            const doc = this._doc;
            EaselStore.queueSave(doc.id, JSON.stringify({
                version: DOC_VERSION,
                id: doc.id,
                title: doc.title,
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt,
                recentColors: doc.recentColors || [],
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
            if (this._frozen) return;
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
            if (!doc || this._destroyed || this._frozen || doc.readOnly) return;

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
        handOffForUnload({ persisted = false } = {}) {
            this._cancelPendingSave();
            if (this._frozen) return;
            // A board nobody put anything on does not outlive its tab. Not on a persisted
            // hide: that page is only being put away and comes back out of the session
            // history still showing this board, so there is nothing to be finished with.
            if (!persisted && this._discardIfPristine()) return;
            this._handOff();
            // A persisted hide comes back with its undo history, so its files are left alone.
            // The clipboard dies with the page, so nothing needs keeping.
            if (!persisted) this._sweepOnLetGo(this._doc?.id, []);
        }

        /* --------------------------------------------------------------- assets */

        // `easelId` pins the board the file is filed under to the one the caller started
        // on, so a board switch during the caller's own awaits cannot split an object from
        // its file. Defaults to the open board.
        async saveAsset(bytes, extension = "png", easelId = this._doc?.id) {
            if (!easelId) throw new Error("no easel open");
            return EaselStore.saveAsset(easelId, bytes, extension);
        }

        // A file already on disk, copied in rather than read: see EaselStore.importAsset.
        async importAsset(sourcePath, extension, easelId = this._doc?.id) {
            if (!easelId) throw new Error("no easel open");
            return EaselStore.importAsset(easelId, sourcePath, extension);
        }

        // Synchronous by design: renderers run during layout and cannot await. A miss
        // returns null, starts the read, and repaints when it lands.
        //
        // A failed load is remembered as null for the life of the document rather than
        // retried: the caller asks on every paint, and a file that is gone — swept, or a
        // board copied without its assets directory — would otherwise be reopened per
        // frame. That was tolerable for an <img>; a <video> rebuilt sixty times a second
        // is not.
        resolveAsset(name) {
            if (!name || this._held.has(name)) return null;
            if (this._assetUrls.has(name)) return this._assetUrls.get(name);
            if (!this._assetLoads.has(name)) {
                this._assetLoads.add(name);
                this._loadAsset(name).catch(e => {
                    console.error(`[zen-easel] asset ${name} failed:`, e);
                    if (!this._assetUrls.has(name)) this._assetUrls.set(name, null);
                });
            }
            return null;
        }

        // A linked media object's original, served the same way an attached one is — a
        // disk-backed File, never read into memory — and cached under a key no asset name
        // can take (asset names have no colon). Keyed by the stored path, which sanitize has
        // already normalised, so the per-frame lookup is a map hit; validated again on load.
        resolveLinked(path) {
            if (!path) return null;
            const key = `linked:${path}`;
            if (this._assetUrls.has(key)) return this._assetUrls.get(key);
            if (!this._assetLoads.has(key)) {
                const safe = window.ZenEaselObjects.safeLocalPath(path);
                if (!safe) {
                    this._assetUrls.set(key, null);
                    return null;
                }
                this._assetLoads.add(key);
                const easelId = this._doc?.id;
                File.createFromFileName(safe, { type: MIME_BY_EXTENSION(safe) }).then(file => {
                    if (this._destroyed || this._doc?.id !== easelId) return;
                    this._assetUrls.set(key, URL.createObjectURL(file));
                    if (this.onAssetLoaded) this.onAssetLoaded(key);
                }).catch(e => {
                    this.log(`linked file ${safe} is unavailable:`, e?.message || e);
                    if (!this._assetUrls.has(key)) this._assetUrls.set(key, null);
                    if (this.onAssetLoaded) this.onAssetLoaded(key);
                }).finally(() => this._assetLoads.delete(key));
            }
            return null;
        }

        // Whether a media object's file is known to be missing, so the canvas paints it.
        mediaFailed(obj) {
            const media = obj && obj.media;
            if (!media) return false;
            const key = media.path ? `linked:${media.path}` : media.asset;
            return this._assetUrls.has(key) && this._assetUrls.get(key) === null;
        }

        async _loadAsset(name) {
            if (!this._doc) return;
            const easelId = this._doc.id;
            try {
                const type = MIME_BY_EXTENSION(name);
                let source;
                if (assetKind(name) === "image") {
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
                    source = new Blob([new Uint8Array(bytes)], { type });
                } else {
                    // Video and audio are never read into memory. A File built on the
                    // path is disk-backed, and the object URL made from it streams — which
                    // is what keeps a board with a few hundred megabytes of video from
                    // holding a few hundred megabytes of this window's heap. The type is
                    // passed for the reason at MIME_TYPES.
                    const path = await EaselStore.assetPath(easelId, name);
                    if (this._destroyed || !this._doc || this._doc.id !== easelId) return;
                    source = await File.createFromFileName(path, { type });
                    if (this._destroyed || !this._doc || this._doc.id !== easelId) return;
                }
                const url = URL.createObjectURL(source);
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
                if (!url) continue;   // a remembered failure has nothing to revoke
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
            this._cancelSweepRetry();
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
