// ==UserScript==
// @name           Zen Easel (host)
// @description    Opens about:easel, captures regions, and bridges the page to Zen
// ==/UserScript==

// The browser-window half of Zen Easel.
//
// The easel itself is a document now — about:easel, in its own tab. What stays behind in
// browser.xhtml is only what genuinely cannot live in a page: taking a snapshot of
// whatever tab you are looking at, hooking Zen's own screenshot UI, the toolbar button,
// and the global shortcut.
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

    function easelPageUrl(easelId, { glance = false } = {}) {
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
        if (!easelId) return base;
        let url = `${base}?easel=${encodeURIComponent(easelId)}`;
        // On the URL, not on the tab: Glance stamps zen-glance-tab *after* addTab,
        // and about:easel boots in the parent process before that write. claimEasel
        // has to recognise a satellite from the address it was opened at.
        if (glance) url += "&glance=1";
        return url;
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
                this._onTabSelect = this._onTabSelect.bind(this);
                window.addEventListener("TabSelect", this._onTabSelect);

                // Adds "Easel" to Zen's region bar and screenshot preview. Lives here rather
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

            // A glance satellite of a board that already has a tab is the one
            // permitted second view: the original is frozen so it cannot overwrite
            // the capture, and it is reloaded from disk when the glance goes away.
            // Anything else is still two writers and is refused.
            const newTab = this._tabForBrowser(browser);
            // glance=1 is on the URL we handed addTab, so it is present even when
            // this runs before Glance has stamped zen-glance-tab. The other tab is
            // the original we meant to leave in place — not a second glance.
            if (this._isGlanceSatellite(browser, newTab, easelId) &&
                other.tab && !other.tab.hasAttribute("zen-glance-tab")) {
                this._pendingGlanceEaselId = null;
                this._freezeResident(other);
                // The tab object is often still missing here — Glance has not
                // appended it yet. Remember the original and arm once we have it.
                this._pendingSatelliteResident = other;
                this._armSatellite(newTab, other);
                log("glance satellite allowed for the open easel");
                return true;
            }

            log("that easel is already open in another tab; focusing it");
            this._focusEaselTab(other);
            return false;
        }

        _isGlanceSatellite(browser, tab, easelId) {
            if (tab?.hasAttribute("zen-glance-tab") || tab?.hasAttribute("glance-id")) {
                return true;
            }
            if (this._pendingGlanceEaselId && this._pendingGlanceEaselId === easelId) {
                return true;
            }
            try {
                const spec = browser?.currentURI?.spec || "";
                return new URL(spec).searchParams.get("glance") === "1";
            } catch (e) {
                return false;
            }
        }

        _tabForBrowser(browser) {
            try {
                const win = browser.ownerGlobal;
                return win?.gBrowser?.getTabForBrowser(browser) ?? null;
            } catch (e) {
                return null;
            }
        }

        _freezeResident(hit) {
            this._markEaselStale(hit?.tab);
            try {
                const page = hit.tab.linkedBrowser?.contentWindow?.gZenEaselPage;
                if (page?.freezeWrites) {
                    page.freezeWrites();
                    return;
                }
                // The pinned tab is still running the page that booted before this
                // existed. readOnly is the same gate markDirty already honours.
                const store = page?.element?.store;
                if (store?._doc) {
                    store._cancelPendingSave?.();
                    store._doc.readOnly = true;
                }
            } catch (e) {
                console.error("[zen-easel] could not freeze the pinned easel:", e);
            }
        }

        // GlanceClose / TabClose: satellite is gone, reload the original in the
        // background. Expand keeps the overlay as a normal tab; Close dismisses it.
        _armSatellite(glanceTab, residentHit) {
            if (!glanceTab || !residentHit) return;
            this._disarmSatellite();
            const onGone = () => {
                this._completeSatellite(residentHit);
            };
            glanceTab.addEventListener("GlanceClose", onGone, { once: true });
            glanceTab.addEventListener("TabClose", onGone, { once: true });
            this._satellite = { glanceTab, residentHit, onGone };
            this._pendingSatelliteResident = null;
        }

        _disarmSatellite() {
            const armed = this._satellite;
            if (!armed) return;
            this._satellite = null;
            try { armed.glanceTab.removeEventListener("GlanceClose", armed.onGone); } catch (e) { }
            try { armed.glanceTab.removeEventListener("TabClose", armed.onGone); } catch (e) { }
        }

        async _flushSatellite(glanceTab) {
            try {
                const page = this._pageFor(glanceTab);
                if (page?.element?.store) await page.element.store.flush();
            } catch (e) {
                console.error("[zen-easel] could not flush the glance satellite:", e);
            }
            try {
                const { EaselStore } =
                    ChromeUtils.importESModule(BASE + "background/store.sys.mjs");
                await EaselStore.flush();
            } catch (e) {
                console.error("[zen-easel] could not finish the satellite write:", e);
            }
        }

        async _completeSatellite(residentHit) {
            const glanceTab = this._satellite?.glanceTab;
            this._disarmSatellite();
            await this._flushSatellite(glanceTab);
            await this._reloadResident(residentHit);
        }

        _markEaselStale(tab) {
            if (!tab) return;
            if (!this._staleEaselTabs) this._staleEaselTabs = new WeakSet();
            this._staleEaselTabs.add(tab);
        }

        _onTabSelect() {
            const tab = gBrowser.selectedTab;
            if (!this._staleEaselTabs?.has(tab)) return;
            this._reloadResident({ win: window, tab });
        }

        _easelIdForTab(tab) {
            try {
                return new URL(tab.linkedBrowser.currentURI.spec).searchParams.get("easel");
            } catch (e) {
                try {
                    return tab.linkedBrowser.contentWindow?.gZenEaselPage?.easelId ?? null;
                } catch (e2) {
                    return null;
                }
            }
        }

        // The original tab is often still running the page that booted before
        // reloadFromDisk existed. Hydrate through whatever store it has — same
        // _hydrate the page already uses — so a background board updates without
        // a full reload. TabSelect retries if this ran too early.
        async _reloadResident(hit) {
            if (!hit?.tab || hit.tab.closing) return;
            try {
                const page = hit.tab.linkedBrowser?.contentWindow?.gZenEaselPage;
                const store = page?.element?.store;
                const { EaselStore } =
                    ChromeUtils.importESModule(BASE + "background/store.sys.mjs");
                await EaselStore.flush();

                if (page?.reloadFromDisk) {
                    await page.reloadFromDisk();
                    this._staleEaselTabs?.delete(hit.tab);
                    return;
                }

                const id = store?._doc?.id || this._easelIdForTab(hit.tab);
                if (store && id && typeof store._hydrate === "function") {
                    store._cancelPendingSave?.();
                    store._frozen = false;
                    if (store._doc) store._doc.readOnly = false;
                    const json = await EaselStore.readDocument(id);
                    if (json) {
                        store._doc = store._hydrate(id, JSON.parse(json));
                        page.element.canvas?.setDocument(store._doc);
                        page.element.library?.refresh();
                        try { page.element._syncTabIdentity?.(); } catch (e) { }
                        this._staleEaselTabs?.delete(hit.tab);
                        return;
                    }
                }
            } catch (e) {
                console.error("[zen-easel] could not reload the original easel:", e);
            }
            this._markEaselStale(hit.tab);
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
                // A glance satellite is a second view of a board, not "the" easel tab.
                if (tab.hasAttribute("zen-glance-tab")) continue;
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
                gBrowser.setIcon(tab, BASE + "resources/zen-easel-board.svg");
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
                this.startCapture();
            }
        }

        // Starts Zen's own screenshot overlay, which now carries an "Easel" button on the
        // bar it shows under a dragged region. This used to open a region picker of the
        // mod's own; there is no reason to have two, and Zen's has element highlighting and
        // resize handles that this one never grew.
        //
        // Notifying the observer directly rather than calling ScreenshotsUtils.notify(), and
        // the difference is not stylistic: notify() reads window.event.currentTarget.
        // documentGlobal, which only resolves from a command handler where currentTarget is
        // the document. This runs from a keydown listener bound on the window, where
        // documentGlobal is undefined and ScreenshotsUtils.observe() then dies destructuring
        // gBrowser off it. The observer wants the window, so it is handed the window.
        //
        // "Shortcut" is the telemetry label Zen's own keybinding uses, and the topic keeps
        // notify()'s toggle behaviour: pressing it again while the overlay is up cancels.
        startCapture() {
            try {
                Services.obs.notifyObservers(window, "menuitem-screenshot", "Shortcut");
            } catch (e) {
                console.error("[zen-easel] could not start a screenshot:", e);
                this.toast("Could not start a screenshot");
            }
        }

        /* ------------------------------------------------------------- capture */

        // captureRegion and captureFullWindow used to live here, each standing up the mod's
        // own picker. Both are gone: a capture now starts in Zen's overlay and arrives
        // through screenshot-hook, which calls openWithCapture directly with a region Zen
        // already selected. What is left below is the destination handling they shared,
        // which was always the part worth keeping.

        async openWithCapture(target, capture) {
            // "new" makes its document first and gets a tab of its own. It used to be
            // openEasel(null) followed by page.createNew(), which focused whatever board
            // was already open and then replaced it — so asking a capture for a *fresh*
            // easel took away the one you were looking at.
            const tab = await this._openForCapture(target, capture);
            if (!tab) {
                this.toast("The easel did not open in time to place that capture");
                return;
            }

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
                // On disk before the user can dismiss a glance satellite. The pinned
                // original reloads from that file; a pending autosave is too late.
                try { await page.element?.flush(); } catch (e) { }
            } catch (e) {
                console.error("[zen-easel] could not place the capture:", e);
                this.toast(e && e.message ? e.message : "Could not place the screenshot");
            }
        }

        // Screenshot destinations only. Ctrl+Shift+E and the toolbar button still go
        // through openEasel / createEasel and always make a full tab — Glance is the
        // overlay you get for "I just took a picture, show me the board", not a new
        // way of opening easels in general.
        //
        // A board that already has a tab gets a *second* glance tab, not a wrap
        // of the original. The original is frozen so it cannot overwrite the
        // capture, and is reloaded from disk when the glance closes.
        async _openForCapture(target, capture) {
            if (target === "new") {
                const { EaselStore } =
                    ChromeUtils.importESModule(BASE + "background/store.sys.mjs");
                const { entry } = await EaselStore.createDocument("Untitled Easel");
                return this._openEaselForCapture(entry.id, capture);
            }
            return this._openEaselForCapture(target || null, capture);
        }

        async _openEaselForCapture(easelId, capture) {
            if (easelId) {
                const existing = this._findEaselTab(easelId);
                if (existing) {
                    if (existing === gBrowser.selectedTab) return existing;
                    if (this._shouldGlanceExisting(existing)) {
                        const glanced = await this._openEaselInGlance(easelId, capture);
                        if (glanced) {
                            const resident = this._pendingSatelliteResident ||
                                { win: window, tab: existing };
                            this._freezeResident(resident);
                            this._armSatellite(glanced, resident);
                            return glanced;
                        }
                    }
                    gBrowser.selectedTab = existing;
                    return existing;
                }
                const elsewhere = this._findEaselTabAnywhere(easelId);
                if (elsewhere) return this._focusEaselTab(elsewhere);
            }

            const glanced = await this._openEaselInGlance(easelId, capture);
            if (glanced) return glanced;

            return this.openEasel(easelId);
        }

        _shouldGlanceExisting(tab) {
            if (!tab || tab === gBrowser.selectedTab) return false;
            if (tab.hasAttribute("zen-glance-tab")) return false;
            return this._glanceIsAvailable();
        }

        // Glance is a chrome singleton with no "is one up?" getter, so the attributes
        // it stamps on its child are the honest test. openGlance itself does not
        // honour zen.glance.enabled — that pref only gates the automatic triggers —
        // so a user who turned Glance off would still get an overlay from us unless
        // we check it here.
        _glanceIsAvailable() {
            const mgr = window.gZenGlanceManager;
            if (!mgr || typeof mgr.openGlance !== "function") return false;
            try {
                if (!Services.prefs.getBoolPref("zen.glance.enabled", true)) return false;
            } catch (e) {
                return false;
            }
            try {
                for (const tab of gBrowser.tabs) {
                    if (tab.hasAttribute("zen-glance-tab")) return false;
                }
            } catch (e) {
                return false;
            }
            return true;
        }

        // Viewport-space rect of the selection, which is what Glance's arc treats as
        // clientX/Y. A full-page preview has no such rect; passing nothing would let
        // openGlance merge lastLinkClickData and animate out of whichever link was
        // last modifier-clicked, so we invent a box in the tabpanels instead.
        _glanceOrigin(capture) {
            const frame = capture && capture.capture && capture.capture.frameRelativeToViewport;
            if (frame && frame.w > 0 && frame.h > 0) {
                return {
                    clientX: frame.x,
                    clientY: frame.y,
                    width: frame.w,
                    height: frame.h
                };
            }
            try {
                const box = gBrowser.tabpanels.getBoundingClientRect();
                return {
                    clientX: box.width * 0.1,
                    clientY: box.height * 0.1,
                    width: box.width * 0.8,
                    height: box.height * 0.8
                };
            } catch (e) {
                return { clientX: 0, clientY: 0, width: 1, height: 1 };
            }
        }

        async _openEaselInGlance(easelId, capture) {
            // A missing id is openEasel(null) — "whichever board" — and Glance needs a
            // concrete URL. The toolbar already refuses to create a second copy that
            // way; so do we.
            if (!easelId || !this._glanceIsAvailable()) return null;

            this._pendingGlanceEaselId = easelId;
            let tab;
            try {
                tab = await window.gZenGlanceManager.openGlance({
                    url: easelPageUrl(easelId, { glance: true }),
                    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                    ...this._glanceOrigin(capture)
                });
            } catch (e) {
                this._pendingGlanceEaselId = null;
                console.error("[zen-easel] could not open the easel in glance:", e);
                return this._findEaselTab(easelId);
            }
            this._pendingGlanceEaselId = null;

            // openGlance no-ops and returns the current glance when one is already
            // up. That tab is someone else's, so fall back to a full tab rather than
            // dropping the capture onto it.
            if (tab && this._matchEaselTab(tab, easelId)) {
                log("opened the capture destination in glance");
                return tab;
            }
            return null;
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
        // checked anything, even when the only caller is our own page. Glance first,
        // same overlay as a capture destination — Expand stays off. A full tab is
        // only the fallback when Glance is off or already showing something else.
        openUrl(url, origin) {
            const { safeExternalUrl } =
                ChromeUtils.importESModule(BASE + "background/validate.sys.mjs");
            const spec = safeExternalUrl(url);
            if (!spec) return;
            this._openExternalInGlance(spec, origin).catch(e => {
                console.error("[zen-easel] could not open", spec, e);
                if (!this._currentGlanceTab()) this._openUrlInTab(spec);
            });
        }

        _openUrlInTab(spec) {
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

        // glance-id is stamped on the parent as well, so only zen-glance-tab
        // identifies the overlay's own tab.
        _currentGlanceTab() {
            try {
                for (const tab of gBrowser.tabs) {
                    if (tab.hasAttribute("zen-glance-tab") && !tab.closing) return tab;
                }
            } catch (e) { }
            return null;
        }

        // Where the overlay grows from, as a point rather than a box.
        //
        // A box makes Glance drawSnapshot the region behind it for its fade-in
        // preview — and on a board that region is full of live tiles, which are
        // <browser> elements in the chrome window. That snapshot fails, openGlance
        // rejects with it, and the link ends up in a plain tab. A zero-size origin
        // skips the preview entirely; the arc still plays, out of the click.
        _glanceLinkOrigin(origin) {
            let point = null;
            if (origin && typeof origin.screenX === "number") {
                try {
                    const box = gBrowser.tabpanels.getBoundingClientRect();
                    point = {
                        clientX: origin.screenX - window.mozInnerScreenX - box.left,
                        clientY: origin.screenY - window.mozInnerScreenY - box.top
                    };
                } catch (e) { }
            }
            if (!point) {
                try {
                    const box = gBrowser.tabpanels.getBoundingClientRect();
                    point = { clientX: box.width / 2, clientY: box.height / 2 };
                } catch (e) {
                    point = { clientX: 0, clientY: 0 };
                }
            }
            return { ...point, width: 0, height: 0 };
        }

        // Every way out of this says which one it took. A link that lands in a tab
        // when it should have been an overlay is otherwise indistinguishable from a
        // link that was never routed here at all.
        _fallBackToTab(spec, reason) {
            console.warn("[zen-easel] link opening in a tab instead of glance:", reason);
            this._openUrlInTab(spec);
        }

        // Same payload Glance's own tests use (GlanceTestUtils.openGlanceOnTab).
        // triggeringPrincipal is required: newer Glance hands it to addTab, and
        // without it the manager can bail out before creating the overlay.
        // width/height 0 skips the drawSnapshot preview — live tiles in the
        // chrome window make that snapshot fail.
        _glanceExternalData(spec, origin) {
            return {
                url: spec,
                ...this._glanceLinkOrigin(origin),
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
            };
        }

        // openGlance returns #currentTab immediately when it thinks a glance is
        // already up. After an easel glance is closed that map can still hold
        // the easel as parentTab with no child — selectedTab === parent, child
        // null, so every later openGlance returns null. There is no overlay
        // tab in the strip, so clearing the id is safe.
        _clearStaleGlance(mgr) {
            if (this._currentGlanceTab()) return;
            try {
                mgr.quickCloseGlance({
                    closeCurrentTab: false,
                    closeParentTab: false,
                    justAnimateParent: true,
                    clearID: true
                });
            } catch (e) { }
        }

        async _tryOpenGlance(mgr, spec, origin) {
            const data = this._glanceExternalData(spec, origin);
            try { mgr.lastLinkClickData = { clientX: data.clientX, clientY: data.clientY, width: 0, height: 0 }; } catch (e) { }
            return mgr.openGlance(data);
        }

        async _openExternalInGlance(spec, origin) {
            const mgr = window.gZenGlanceManager;
            if (!mgr || typeof mgr.openGlance !== "function") {
                this._fallBackToTab(spec, "gZenGlanceManager.openGlance is missing");
                return;
            }
            try {
                if (!Services.prefs.getBoolPref("zen.glance.enabled", true)) {
                    this._fallBackToTab(spec, "zen.glance.enabled is off");
                    return;
                }
            } catch (e) {
                this._fallBackToTab(spec, "zen.glance.enabled could not be read");
                return;
            }

            // Glance is a singleton: an easel that is itself the overlay cannot
            // nest a second one. That case is a plain tab.
            const already = this._currentGlanceTab();
            if (already) {
                this._fallBackToTab(spec, "a glance is already open on " +
                    (already.linkedBrowser?.currentURI?.spec || "an unknown page"));
                return;
            }

            this._clearStaleGlance(mgr);
            let tab = null;
            let failure = null;
            try {
                tab = await this._tryOpenGlance(mgr, spec, origin);
                if (!tab) {
                    this._clearStaleGlance(mgr);
                    tab = await this._tryOpenGlance(mgr, spec, origin);
                }
            } catch (e) {
                failure = e;
                console.error("[zen-easel] openGlance threw:", e);
            }

            if (tab && tab.hasAttribute("zen-glance-tab")) return;

            this._fallBackToTab(spec, failure
                ? "openGlance threw, see the error above"
                : `openGlance returned ${tab ? "a tab that is not a glance" : String(tab)}`);
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
            this._disarmSatellite();
            window.removeEventListener("keydown", this._onKeyDown, true);
            window.removeEventListener("unload", this._onUnload);
            if (this._onTabSelect) window.removeEventListener("TabSelect", this._onTabSelect);
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
