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
        ["ZenEaselScreenshotHook", "modules-host/screenshot-hook.uc.js"],
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

        // Finds the tab showing a given easel, or any easel tab when id is null.
        _findEaselTab(easelId = null) {
            for (const tab of gBrowser.tabs) {
                const browser = tab.linkedBrowser;
                if (!browser) continue;
                let spec = "";
                try { spec = browser.currentURI ? browser.currentURI.spec : ""; } catch (e) { continue; }
                if (!spec.startsWith(ABOUT_URL) && !spec.startsWith(CHROME_URL)) continue;
                if (!easelId) return tab;

                // The page rewrites its own URL as the open easel changes, so the query
                // string is the authority — but a page that has not booted yet has not
                // written it, so fall back to asking the controller.
                try {
                    if (new URL(spec).searchParams.get("easel") === easelId) return tab;
                } catch (e) { }
                try {
                    if (browser.contentWindow?.gZenEaselPage?.easelId === easelId) return tab;
                } catch (e) { }
            }
            return null;
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

        // One easel open in one tab at a time. Opening one that is already open focuses
        // it instead of standing up a second copy that would race the first on the same
        // file.
        //
        // The fallback is unconditional, and that is the fix for a real bug: it used to
        // be `(easelId ? null : this._findEaselTab())`, so asking for a *specific* easel
        // while a tab showed a *different* one found no match and opened a second easel
        // tab. Two tabs then shared one store and raced on index.json — and worse,
        // everything that looks an easel tab up by walking gBrowser.tabs takes the first
        // it finds, including the live-tile host, which would then render a board's
        // websites over the wrong tab. Reusing the tab and switching it is what the
        // "one easel at a time" invariant was supposed to mean all along.
        openEasel(easelId = null) {
            // Any switch this starts is recorded rather than fired and forgotten, so a
            // caller that is about to *do* something to the easel can wait for the right
            // one to be open. See openWithCapture, and the note there.
            this._switching = null;

            const existing = this._findEaselTab(easelId) || this._findEaselTab();
            if (existing) {
                gBrowser.selectedTab = existing;
                if (easelId) {
                    const page = this._pageFor(existing);
                    if (page) {
                        this._switching = page.switchTo(easelId)
                            .catch(e => console.error("[zen-easel]", e));
                    }
                }
                return existing;
            }

            const tab = gBrowser.addTab(easelPageUrl(easelId), {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                inBackground: false
            });
            gBrowser.selectedTab = tab;

            // The <link rel="icon"> in the page should cover this, but setting it here as
            // well is free and removes a class of "why is my tab showing a globe" that
            // depends on favicon principal checks going our way.
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

            const { entry } = await EaselStore.createDocument(title);
            const tab = this.openEasel(entry.id);

            // openEasel can only *start* the switch when a page is already up. Awaiting it
            // means a caller that wants to act on the new board — or just wants to know the
            // click finished — is not racing the read off disk.
            if (this._switching) {
                try { await this._switching; } finally { this._switching = null; }
            }
            return tab;
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
            const tab = this.openEasel(target && target !== "new" ? target : null);
            const page = await this._waitForPage(tab);
            if (!page) {
                this.toast("The easel did not open in time to place that capture");
                return;
            }

            try {
                if (target === "new") await page.createNew();

                // Waited for, and this is the whole of "Move to easel stopped working
                // after I deleted an easel".
                //
                // Switching easels is asynchronous — it reads the document off disk and
                // hands the canvas a new one. openEasel could only start it. So picking
                // an easel other than the one already open dropped the capture onto the
                // *old* board and then replaced that board with the new one a moment
                // later, taking the capture with it.
                //
                // It looked like a change in behaviour after a deletion because until
                // then the open tab usually already showed the easel being picked, and
                // switchTo returns immediately in that case — there was no window for
                // the race to happen in. Deleting one changed which easel was open, and
                // opened the window.
                else if (this._switching) await this._switching;

                await page.addCapture(capture);
            } catch (e) {
                console.error("[zen-easel] could not place the capture:", e);
                this.toast(e && e.message ? e.message : "Could not place the screenshot");
            } finally {
                this._switching = null;
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
                gBrowser.selectedTab = gBrowser.addTab(spec, {
                    // Deliberately not the system principal. A system triggering principal
                    // is what would let javascript:, data:, file: and chrome: load with
                    // privilege from a string that originates in a file on disk.
                    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
                    inBackground: false
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

        liveMount(objectId, url, geometry, options) {
            const live = this.live;
            return live ? live.mount(objectId, url, geometry, options) : Promise.resolve(false);
        }

        // Answered for ZenEaselLiveParent when a tile's child actor announces itself.
        // Deliberately reached through the same gZenEaselHost surface as everything
        // else, so the actor needs no handle on the live host itself.
        liveConfigFor(browser) { return this.live?.configFor(browser) ?? null; }

        liveLayout(entries) { this.live?.layoutAll(entries); }
        liveUnmount(objectId) { this.live?.unmount(objectId); }
        liveUnmountAll() { this.live?.unmountAll(); }
        liveActivate(objectId) { this.live?.activate(objectId); }
        liveDeactivate() { this.live?.deactivate(); }
        liveSetTileVisible(objectId, visible) { this.live?.setTileVisible(objectId, visible); }

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
