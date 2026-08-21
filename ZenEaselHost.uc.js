// ==UserScript==
// @name           Zen Easel (host)
// @description    Opens about:easel, captures regions, and bridges the page to Zen
// @version        0.2.0
// ==/UserScript==

// The browser-window half of Zen Easel.
//
// The easel itself is a document now — about:easel, in its own tab. What stays behind in
// browser.xhtml is only what genuinely cannot live in a page: taking a snapshot of
// whatever tab you are looking at, drawing the region picker over Zen's chrome, hooking
// Zen's own screenshot UI, the toolbar button, and the global shortcut.
//
// Everything this exposes to the page goes through gZenEaselHost, and every value that
// crosses is a plain string, number or byte array. The page holds a reference to this
// window; this window never holds a reference to a page, because doing so would keep the
// page's compartment alive after its tab closed. When the host needs a page it looks one
// up in gBrowser.tabs at the moment of use.

"use strict";

(function () {
    const BASE = "chrome://sine/content/zen-easel/";

    const MODULES = [
        ["ZenEaselUtil", "modules/util.uc.js"],
        ["ZenEaselCaptureHost", "modules-host/capture-host.uc.js"],
        ["ZenEaselCaptureBackdrop", "modules-host/capture-backdrop.uc.js"],
        ["ZenEaselScreenshotHook", "modules-host/screenshot-hook.uc.js"],
        ["ZenEaselSplitResize", "modules-host/split-resize.uc.js"],
        ["ZenEaselLiveHost", "modules-host/live-host.uc.js"]
    ];

    // Sine re-runs this script on every browser window, and on every rebuild while
    // developing. Tear the previous instance down first or we leak a window-level keydown
    // listener and a CustomizableUI widget per reload.
    if (window.gZenEaselHost && typeof window.gZenEaselHost.destroy === "function") {
        try { window.gZenEaselHost.destroy(); } catch (e) { console.error("[zen-easel] destroy failed:", e); }
        try { window.ZenEaselUtil.disposePrefs(); } catch (e) { }
        for (const [globalName] of MODULES) delete window[globalName];
    }

    for (const [globalName, relative] of MODULES) {
        if (window[globalName]) continue;
        try {
            Services.scriptloader.loadSubScript(BASE + relative, window);
        } catch (e) {
            console.error(`[zen-easel] host failed to load ${relative}:`, e);
        }
    }

    const { log, prefStr, parseShortcut, matchesShortcut } = window.ZenEaselUtil;

    // The about: page is the front door. If registration failed — a Zen update changing
    // nsIAboutModule, say — the same file is still reachable at its chrome URL, so the
    // feature degrades to an uglier address bar rather than to nothing.
    const ABOUT_URL = "about:easel";
    const CHROME_URL = BASE + "page/easel.xhtml";

    function easelPageUrl(easelId) {
        let base;
        try {
            // Cheapest honest probe: if nothing is registered for about:easel, newURI
            // still succeeds but the channel would fail, so ask the registrar instead.
            base = Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
                .isContractIDRegistered("@mozilla.org/network/protocol/about;1?what=easel")
                ? ABOUT_URL : CHROME_URL;
        } catch (e) {
            base = CHROME_URL;
        }
        return easelId ? `${base}?easel=${encodeURIComponent(easelId)}` : base;
    }

    class ZenEaselHost {
        constructor() {
            this._onKeyDown = this._onKeyDown.bind(this);
            this._onUnload = this._onUnload.bind(this);

            this._shortcuts = {
                open: parseShortcut(prefStr("zen.easel.shortcut.new", "Ctrl+Shift+E")),
                capture: parseShortcut(prefStr("zen.easel.shortcut.capture", "Ctrl+Shift+2"))
            };

            this._init();
        }

        _init() {
            try {
                window.addEventListener("keydown", this._onKeyDown, true);
                window.addEventListener("unload", this._onUnload, { once: true });

                // Adds "Move to easel" to Zen's own screenshot preview. Lives here rather
                // than in the page because it has to work when no easel is open, which is
                // the usual case when taking a screenshot.
                this.screenshotHook = new window.ZenEaselScreenshotHook(this);
                this.screenshotHook.init();

                // Puts the colour that was actually behind the page into a capture,
                // instead of the white every screenshot path composites onto. Isolated
                // and pref-gated — zen.easel.capture-backdrop = off restores Firefox's
                // behaviour exactly, on both this mod's captures and Zen's own. Published
                // on the window because the process-global hook it installs looks the
                // colour up from the browser's own window at capture time; see the header
                // of background/capture-backdrop.sys.mjs.
                this.backdrop = new window.ZenEaselCaptureBackdrop();
                window.gZenEaselCaptureBackdrop = this.backdrop;
                this.backdrop.install();

                // Not an easel feature, and meant to be removable: it stops any about:
                // page in a split pane flickering while the divider is dragged. Behind the
                // "Split view" setting, and self-contained — see the header of
                // split-resize.uc.js.
                this.splitResize = new window.ZenEaselSplitResize();
                this.splitResize.install();

                // CustomizableUI is not ready at script-load time on a cold start.
                this._buttonTimer = setTimeout(() => this._createToolbarButton(), 2000);
                log("host ready");
            } catch (e) {
                // This runs during browser window startup. Anything that escapes here
                // lands in the middle of Zen bringing the window up, so it gets logged and
                // swallowed rather than allowed to derail the window.
                console.error("[zen-easel] host init failed:", e);
            }
        }

        _onUnload() {
            this.destroy({ widget: false });
        }

        _createToolbarButton() {
            try {
                CustomizableUI.createWidget({
                    id: "zen-easel-button",
                    type: "toolbarbutton",
                    label: "Zen Easel",
                    tooltiptext: "Zen Easel",
                    onCreated: node => {
                        if (node) node.addEventListener("click", () => this.openEasel());
                    }
                });
            } catch (e) {
                // Already registered by another window — the normal case for every window
                // after the first, not an error worth surfacing.
                log("widget not created:", e.message);
            }
        }

        /* ------------------------------------------------------------- the tab */

        // Does this address belong to the easel page?
        //
        // A bare startsWith would also accept about:easelfoo. Nothing can navigate there
        // today, but this is what decides whether a tab is treated as a board — and the
        // live host draws a board's websites over whatever it decides — so the test is
        // written to mean what it says rather than to be right by accident.
        _isEaselSpec(spec) {
            for (const base of [ABOUT_URL, CHROME_URL]) {
                if (!spec.startsWith(base)) continue;
                const next = spec.charAt(base.length);
                if (next === "" || next === "?" || next === "#") return true;
            }
            return false;
        }

        // Whether one tab is showing one easel — or any easel, when id is null.
        //
        // The query string is the authority because the page rewrites its own URL as the
        // board changes; a page that has not booted yet has not written it, so the
        // controller is asked as a fallback.
        _matchEaselTab(tab, easelId) {
            const browser = tab.linkedBrowser;
            if (!browser) return false;
            let spec = "";
            try { spec = browser.currentURI ? browser.currentURI.spec : ""; } catch (e) { return false; }
            if (!this._isEaselSpec(spec)) return false;
            if (!easelId) return true;
            try {
                if (new URL(spec).searchParams.get("easel") === easelId) return true;
            } catch (e) { }
            try {
                if (browser.contentWindow?.gZenEaselPage?.easelId === easelId) return true;
            } catch (e) { }
            return false;
        }

        // The tab showing this easel anywhere in the session, and the window holding it.
        //
        // Every browser window, not just this one: "one tab per easel" has to hold across
        // the session or it does not hold at all. Two windows opening the same board each
        // get their own page and their own live host, and the two documents then overwrite
        // each other on autosave — the per-process write queue serialises the writes, which
        // stops the file being torn, not the second save from discarding the first.
        //
        // `exclude` is the browser doing the asking, so a page can ask whether anyone
        // *else* holds its board without matching itself.
        _findEaselTabAnywhere(easelId, exclude = null) {
            let windows;
            try { windows = Services.wm.getEnumerator("navigator:browser"); } catch (e) { return null; }
            for (const win of windows) {
                let tabs;
                try {
                    if (win.closed || !win.gBrowser) continue;
                    tabs = win.gBrowser.tabs;
                } catch (e) { continue; }
                for (const tab of tabs) {
                    if (exclude && tab.linkedBrowser === exclude) continue;
                    if (this._matchEaselTab(tab, easelId)) return { win, tab };
                }
            }
            return null;
        }

        // Focuses a tab that may not be in this window.
        _focusEaselTab(hit) {
            if (!hit) return null;
            try {
                hit.win.gBrowser.selectedTab = hit.tab;
                hit.win.focus();
            } catch (e) {
                console.error("[zen-easel] could not focus the easel tab:", e);
            }
            return hit.tab;
        }

        // A booting page asking whether it may keep the board it has settled on.
        //
        // Two tabs on one easel is the state the whole multi-board design assumes away.
        // _easelBrowserFor takes the first tab it finds, so one board's websites are drawn
        // over the other tab; and the two pages hold separate in-memory copies of the same
        // document, so whichever autosaves second silently discards the other's edits.
        //
        // openEasel will not create that state, but openEasel is not the only way in.
        // Duplicate Tab, a restored session that already contained a duplicate, and a
        // session restore that races two windows onto the last-opened board all arrive
        // without passing through it. So the invariant is enforced where it can actually be
        // checked — by the page, once it knows which board it is on. The newcomer closes
        // and the existing tab is focused, which is what whoever asked for this board
        // wanted either way.
        claimEasel(easelId, browser) {
            if (!easelId || !browser) return true;
            const other = this._findEaselTabAnywhere(easelId, browser);
            if (!other) return true;
            log("that easel is already open in another tab; focusing it");
            this._focusEaselTab(other);
            return false;
        }

        // Finds the tab showing a given easel *in this window*, or any easel tab when id is
        // null. Cross-window callers want _findEaselTabAnywhere.
        //
        // With no id this is "the easel tab" in the loose sense the toolbar button and the
        // shortcut mean, and it answers with the most recently selected one rather than
        // whichever sits leftmost. Strip order was a fair answer while one tab held every
        // board; now that a board has a tab each it would send you to an arbitrary one,
        // which for the general "open the easel" gesture is almost never the one you were
        // last working on.
        _findEaselTab(easelId = null) {
            let best = null;
            for (const tab of gBrowser.tabs) {
                if (!this._matchEaselTab(tab, easelId)) continue;
                if (easelId) return tab;
                if (!best || (tab.lastAccessed || 0) > (best.lastAccessed || 0)) best = tab;
            }
            return best;
        }

        // Looked up fresh every time rather than cached: a cached page reference would
        // outlive its tab and keep the whole document alive.
        _pageFor(tab) {
            try {
                return tab?.linkedBrowser?.contentWindow?.gZenEaselPage ?? null;
            } catch (e) {
                return null;
            }
        }

        // One tab per easel. Opening a board that is already open focuses its tab; opening
        // one that is not gets a new tab, so boards can be reordered, split against each
        // other, and closed independently the way any other tab can.
        //
        // This used to reuse *any* easel tab and switch it in place, which is what made
        // opening a second board replace the first. That fallback existed for a reason: two
        // easel tabs used to share one store and race on index.json, and anything that
        // looked up "the easel tab" by walking gBrowser.tabs took the first it found — the
        // live-tile host among them, which would then render one board's websites over
        // another board's tab. Both are fixed. The store's write queue moved to
        // background/store.sys.mjs, a per-process singleton that serialises every write; and
        // the live host now looks tabs up by easel id (_easelBrowserFor) and keeps a layer
        // per board rather than one shared one.
        //
        // A call with no easelId still means "open the easel" in the general sense — the
        // toolbar button and Ctrl+Shift+E — so it focuses whichever board is already open
        // rather than opening a redundant second copy of the last one.
        openEasel(easelId = null) {
            const existing = this._findEaselTab(easelId);
            if (existing) {
                gBrowser.selectedTab = existing;
                return existing;
            }

            // Not in this window, but possibly in another. Checked only for a *named*
            // board, because that is the one where opening a second copy does damage — two
            // pages on one document, each overwriting the other on save. A bare "open the
            // easel" with no board open here should give this window its own tab rather
            // than dragging focus to some other window.
            if (easelId) {
                const elsewhere = this._findEaselTabAnywhere(easelId);
                if (elsewhere) return this._focusEaselTab(elsewhere);
            }

            const tab = gBrowser.addTab(easelPageUrl(easelId), {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                inBackground: false
            });
            gBrowser.selectedTab = tab;

            // The <link rel="icon"> in the page should cover this, but setting it here as
            // well is free and removes a class of "why is my tab showing a globe" that
            // depends on favicon principal checks going our way.
            // Both routes point at the one icon file, which strokes itself with
            // context-fill for the reason set out in its own header.
            try {
                gBrowser.setIcon(tab, BASE + "resources/zen-easel.svg");
            } catch (e) { }

            return tab;
        }

        // Makes a new easel and opens it.
        //
        // Distinct from openEasel(null), and the distinction is the bug this fixes. Passing
        // null means "whichever easel is already open, or the last one touched" — so a
        // caller that wanted a *fresh* board got the existing one focused instead, and
        // "New easel" in zen-library appeared to do nothing whenever an easel tab was
        // already open. It only ever looked right on a profile with no easels at all, where
        // the page's own openLast() falls through to create().
        //
        // The document is created through the background store rather than by asking the
        // page to do it, because that works in all three states without special-casing any
        // of them: no easel tab open, one open showing a different board, or one open
        // showing this one. By the time openEasel runs, the id names a file that exists.
        async createEasel(title = "Untitled Easel") {
            const { EaselStore } =
                ChromeUtils.importESModule(BASE + "background/store.sys.mjs");

            // The document exists on disk before the tab is asked for, so the tab opens
            // straight onto it — there is no switch to start and nothing to await.
            const { entry } = await EaselStore.createDocument(title);
            return this.openEasel(entry.id);
        }

        /* --------------------------------------------------------------- input */

        _onKeyDown(e) {
            // The easel owns its own keyboard now that it is a document. All this window
            // still handles is getting there, and starting a capture from a normal page.
            if (matchesShortcut(e, this._shortcuts.open)) {
                e.preventDefault();
                e.stopPropagation();
                this.openEasel();
                return;
            }
            if (matchesShortcut(e, this._shortcuts.capture)) {
                e.preventDefault();
                e.stopPropagation();
                this.captureRegion();
            }
        }

        /* ------------------------------------------------------------- capture */

        // target: an easel id to drop onto, "new" for a fresh easel, or null for whichever
        // easel is already open (or was last open).
        async captureRegion(target = null) {
            try {
                const picker = new window.ZenEaselCaptureHost();
                const result = await picker.pickRegionAndCapture();
                picker.destroy();
                if (!result) return;
                await this.openWithCapture(target, result);
            } catch (e) {
                console.error("[zen-easel] capture failed:", e);
                this.toast(e && e.message ? e.message : "Capture failed");
            }
        }

        // The whole viewport, with no region picker in the way. Same destination handling
        // as captureRegion — the only difference is what gets photographed.
        async captureFullWindow(target = null) {
            try {
                const picker = new window.ZenEaselCaptureHost();
                const result = await picker.captureFullWindow();
                picker.destroy();
                if (!result) return;
                await this.openWithCapture(target, result);
            } catch (e) {
                console.error("[zen-easel] full-window capture failed:", e);
                this.toast(e && e.message ? e.message : "Capture failed");
            }
        }

        async openWithCapture(target, capture) {
            // "new" makes its document first and gets a tab of its own. It used to be
            // openEasel(null) followed by page.createNew(), which focused whatever board
            // was already open and then replaced it — so asking a capture for a *fresh*
            // easel took away the one you were looking at.
            const tab = target === "new"
                ? await this.createEasel()
                : this.openEasel(target || null);

            const page = await this._waitForPage(tab);
            if (!page) {
                this.toast("The easel did not open in time to place that capture");
                return;
            }

            // No switch to wait on any more, and that removes a race rather than ignoring
            // it. This used to await an in-place easel switch, because openEasel could only
            // *start* one: picking a board other than the one already open dropped the
            // capture onto the old board and then swapped the board out from under it,
            // taking the capture along. A board now has its own tab, so the tab this
            // resolved to is already showing the board that was asked for, and the only
            // thing worth waiting for is its page — which _waitForPage above did.
            try {
                await page.addCapture(capture);
            } catch (e) {
                console.error("[zen-easel] could not place the capture:", e);
                this.toast(e && e.message ? e.message : "Could not place the screenshot");
            }
        }

        // A freshly opened tab has no document yet. Polling a handful of frames is
        // simpler and more robust here than listening for a load event on a browser whose
        // remoteness may flip as the chrome URL resolves.
        async _waitForPage(tab, attempts = 60) {
            for (let i = 0; i < attempts; i++) {
                const page = this._pageFor(tab);
                if (page) return page;
                await new Promise(resolve => window.setTimeout(resolve, 50));
            }
            return null;
        }

        /* -------------------------------------------------- services for the page */

        // Re-validated here rather than trusted: the host must not assume its caller
        // checked anything, even when the only caller is our own page.
        openUrl(url) {
            const { safeExternalUrl } =
                ChromeUtils.importESModule(BASE + "background/validate.sys.mjs");
            const spec = safeExternalUrl(url);
            if (!spec) return;
            try {
                // openWebLinkIn rather than addTab + selectedTab, which is what this used
                // to be. Selecting a tab and *focusing* it are two different things, and
                // hand-rolling the first only looked sufficient because outside a split
                // view the two coincide: the deck swaps and focus follows the one visible
                // browser. In a split, focus is held by a particular pane's <browser> and
                // stays there — the tab was created and selected, and the caret and the
                // keyboard were still in the easel. openLinkIn ends by focusing the browser
                // it loaded into, which is the step that was missing.
                //
                // It also resolves the target window and honours forceForeground, and it
                // defaults the triggering principal to exactly the null principal built
                // here before — deliberately not the system principal, which is what would
                // let javascript:, data:, file: and chrome: load with privilege from a
                // string that originates in a file on disk. Passed explicitly so that
                // intent stays legible; openWebLinkIn throws on a system principal anyway.
                openWebLinkIn(spec, "tab", {
                    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({})
                });
            } catch (e) {
                console.error("[zen-easel] could not open", spec, e);
            }
        }

        /* ------------------------------------------------------- live web cards */

        // Live tiles are <browser> elements and cannot exist inside about:easel — see the
        // header of modules-host/live-host.uc.js for what was tried and why none of it
        // works. The page owns which cards are live and where they are; this owns the
        // elements. Everything crossing is a plain number or string.
        get live() {
            if (!this._live && window.ZenEaselLiveHost) {
                this._live = new window.ZenEaselLiveHost();
            }
            return this._live || null;
        }

        // Every per-tile call names its board as well as its object. The host asserts the
        // pair before acting, which is what makes "a page showing one easel can never reach
        // into another's tiles" structural rather than a matter of the page getting its
        // bookkeeping right. It matters more than it looks: tiles now outlive the page.
        liveMount(easelId, objectId, url, geometry, options) {
            const live = this.live;
            return live
                ? live.mount(easelId, objectId, url, geometry, options)
                : Promise.resolve(false);
        }

        // Answered for ZenEaselLiveParent when a tile's child actor announces itself.
        // Deliberately reached through the same gZenEaselHost surface as everything
        // else, so the actor needs no handle on the live host itself.
        liveConfigFor(browser) { return this.live?.configFor(browser) ?? null; }

        // A page opening a board asks what is already running on it, and is told rather than
        // starting again. Synchronous: the answer is needed before the first paint.
        liveAttach(easelId, reveal) { return this.live?.attach(easelId, reveal) ?? []; }
        liveDetach(easelId) { this.live?.detach(easelId); }
        liveSetBoardPainting(easelId, painting) { this.live?.setBoardPainting(easelId, painting); }

        liveLayout(easelId, entries) { this.live?.layoutAll(easelId, entries); }
        // The page's own toolbar, topbar and panels, as rectangles to be cut out of this
        // board's tile layer — the layer sits above the page's whole content area, so
        // without this a live card simply covers them. See live-host's clipChrome.
        liveClipChrome(easelId, rects) { return this.live?.clipChrome(easelId, rects) ?? false; }
        // A running web tile's own pixels, so a card that is not running has something to
        // show besides its URL. Resolves to { bytes } or null. See live-host's
        // snapshotTile.
        liveSnapshotTile(easelId, objectId) {
            return this.live ? this.live.snapshotTile(easelId, objectId) : Promise.resolve(null);
        }
        liveUnmount(easelId, objectId) { this.live?.unmountFor(easelId, objectId); }
        liveUnmountBoard(easelId) { this.live?.unmountBoard(easelId); }
        liveActivate(easelId, objectId) { this.live?.activate(easelId, objectId); }
        liveDeactivate() { this.live?.deactivate(); }
        liveCount() { return this.live?.count() ?? { total: 0 }; }
        liveList(easelId) { return this.live?.list(easelId) ?? []; }
        liveStopAll() { this.live?.stopAll(); }
        // Two separate reasons a tile stops painting, kept apart across the seam because the
        // host treats them differently — see _applyTileState.
        liveSetTileOffscreen(easelId, objectId, off) { this.live?.setTileOffscreen(easelId, objectId, off); }
        liveSetTileHidden(easelId, objectId, hidden) { this.live?.setTileHidden(easelId, objectId, hidden); }
        liveSetTileMuted(easelId, objectId, muted) { this.live?.setTileMuted(easelId, objectId, muted); }

        // The floating card bar. Drawn on this side because a live tile is a <browser> above
        // the easel's document and would bury anything the page painted; hit-tested on the
        // page's side, against the same geometry it lays the bar out from. `spec` is null to
        // take it down. At most one exists per window — one pointer, one hover.
        liveShowChrome(easelId, spec) { this.live?.showChrome(easelId, spec); }

        // Saves an exported board. The page renders the pixels and the window writes the
        // file: a file picker is chrome UI, and keeping the one filesystem write on this
        // side means the page never needs a path at all — it hands over bytes and a
        // suggested name, nothing more.
        //
        // Returns the path written, or null if the user cancelled.
        async savePicture(bytes, suggestedName, format = "png") {
            const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
            const label = format === "jpeg" ? "JPEG Image" : "PNG Image";

            picker.init(window.browsingContext, "Export easel", Ci.nsIFilePicker.modeSave);
            picker.appendFilter(label, format === "jpeg" ? "*.jpg" : "*.png");
            picker.defaultString = suggestedName;
            picker.defaultExtension = format === "jpeg" ? "jpg" : "png";

            const result = await new Promise(resolve => picker.open(resolve));
            if (result === Ci.nsIFilePicker.returnCancel || !picker.file) return null;

            // Re-created in this global: a typed array from the page's compartment is not
            // something to hand to IOUtils directly.
            await IOUtils.write(picker.file.path, new Uint8Array(bytes));
            return picker.file.path;
        }

        // What the browser already knows about a URL, with no network request: if it is
        // open in a tab, its title and favicon. This is what a link card is built from
        // instead of fetching the page and parsing og: tags.
        describeUrl(url) {
            try {
                for (const tab of gBrowser.tabs) {
                    const browser = tab.linkedBrowser;
                    if (!browser || !browser.currentURI) continue;
                    if (browser.currentURI.spec !== url) continue;
                    return { title: tab.label || "", favicon: this.localFavicon(tab) };
                }
            } catch (e) { }
            return { title: "", favicon: "" };
        }

        // Only local favicon URLs are kept. A remote https icon would mean the easel
        // reaches out to the network every time it renders, which is exactly what
        // "local-only" is supposed to rule out. page-icon: and data: are both served from
        // the local cache — and the page's own CSP refuses anything else regardless.
        localFavicon(tab) {
            try {
                const icon = gBrowser.getIcon(tab || gBrowser.selectedTab);
                if (!icon) return "";
                return /^(page-icon:|data:|chrome:|moz-)/.test(icon) ? icon : "";
            } catch (e) {
                return "";
            }
        }

        toast(message) {
            try {
                const box = gBrowser.getNotificationBox();
                box.appendNotification("zen-easel-toast", {
                    label: `Zen Easel: ${message}`,
                    priority: box.PRIORITY_INFO_MEDIUM
                }, []);
            } catch (e) {
                console.error("[zen-easel]", message, e);
            }
        }

        // widget:false is the window-closing path. The toolbar button is registered once
        // for the whole application, so destroying it because one window closed would take
        // the button away from every other open window.
        destroy({ widget = true } = {}) {
            window.removeEventListener("keydown", this._onKeyDown, true);
            window.removeEventListener("unload", this._onUnload);
            if (this.screenshotHook) {
                this.screenshotHook.destroy();
                this.screenshotHook = null;
            }
            // Only this window's half goes away. The screenshot hook it installed is
            // shared with every other window and stays — it is inert without a window to
            // ask for a colour. See destroy() in capture-backdrop.uc.js.
            if (this.backdrop) {
                try { this.backdrop.destroy(); } catch (e) { }
                if (window.gZenEaselCaptureBackdrop === this.backdrop) {
                    delete window.gZenEaselCaptureBackdrop;
                }
                this.backdrop = null;
            }
            // Drops the splitter listener and unpins anything a drag left frozen, so a
            // reload mid-gesture cannot strand a pane at the size it was frozen at.
            if (this.splitResize) {
                try { this.splitResize.destroy(); } catch (e) { }
                this.splitResize = null;
            }
            // Tiles are elements in this window; they do not get cleaned up by the page
            // going away, so they have to be torn down with the host that owns them.
            if (this._live) {
                try { this._live.destroy(); } catch (e) { }
                this._live = null;
            }
            if (this._buttonTimer) clearTimeout(this._buttonTimer);
            if (widget) {
                try { CustomizableUI.destroyWidget("zen-easel-button"); } catch (e) { }
            } else {
                // Window closing: the pref observer belongs to this window's copy of the
                // script and would otherwise outlive it.
                window.ZenEaselUtil.disposePrefs();
            }
        }
    }

    window.gZenEaselHost = new ZenEaselHost();
})();
