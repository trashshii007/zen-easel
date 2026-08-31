// Zen Easel — the about:easel page controller.
//
// This is what the overlay's ZenEaselElement became. The shadow root and the module
// wiring are unchanged; what is gone is everything that existed only to fake being a
// window: _findMount, _syncRect, the ResizeObserver mirroring #tabbrowser-tabpanels, and
// the capture-phase keydown listener that had to guess whether a keystroke was meant for
// the easel or for Zen's URL bar. A document owns its own keyboard.
//
// The page reaches the browser window through window.browsingContext.topChromeWindow,
// which is the sanctioned hop — same process, same principal, so it is a direct object
// handle rather than IPC. The traffic is deliberately one-directional: the page holds
// the chrome window, the chrome window never holds the page, because a chrome-window
// reference to a page object would keep that page's compartment alive after its tab
// closed. When the chrome side needs the page it walks gBrowser.tabs and looks it up
// afresh.

"use strict";

(function () {
    // Loaded exactly once, by easel-boot.js. This script is deliberately NOT registered
    // with Sine: Sine would load it a second time on the page's "load" event, after boot
    // had already built everything, and a teardown-and-rebuild guard racing its own cold
    // start is a worse problem than the hot-reload convenience is worth. Reloading the
    // tab re-runs boot from scratch, which is the same thing and cannot race.
    if (window.gZenEaselPage) return;

    const { el, log } = window.ZenEaselUtil;

    const TOPBAR_PREF = "zen.easel.hide-topbar";

    /* ------------------------------------------------------------ the element */

    class ZenEaselElement extends HTMLElement {
        constructor() {
            super();
            this.attachShadow({ mode: "open" });
            this._initialized = false;
            this.el = el;
            this.svg = window.ZenEaselUtil.svg;
            this.log = log;
        }

        connectedCallback() {
            if (this._initialized) return;
            this._initialized = true;

            try {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = "chrome://sine/content/zen-easel/ZenEasel.css";
                this.shadowRoot.appendChild(link);

                const root = el("div", { className: "easel-root" });

                // Screen-space layers sit outside .easel-world on purpose: selection
                // handles and the marquee must not scale with the canvas.
                this.viewport = el("div", { className: "easel-viewport", tabindex: "-1" });

                // Three canvases, following the split Excalidraw uses. Separating them is
                // what stops a drag or a stroke from repainting the whole board: static
                // holds the committed scene, active holds only what is under the pointer
                // right now, overlay holds selection chrome in screen space.
                // Below the canvases on purpose. Animated images are <img> elements —
                // the only form that actually animates — and putting them here means a
                // GIF covers the board's grid while everything drawn on the canvas
                // still draws over the GIF. See modules/media-layer.uc.js.
                this.mediaLayer = el("div", { className: "easel-media-layer" });

                this.staticCanvas = el("canvas", { className: "easel-canvas easel-canvas-static" });

                // There is no live-card layer here. Tiles are <browser> elements, which a
                // system-principal document cannot host, so they are created over this tab
                // by the browser window — see modules-host/live-host.uc.js. The consequence
                // for stacking is that a live card always covers the canvas: it is not in
                // this document's z-order at all.
                this.activeCanvas = el("canvas", { className: "easel-canvas easel-canvas-active" });
                this.overlayCanvas = el("canvas", { className: "easel-canvas easel-canvas-overlay" });

                // The menu layer lives inside the viewport so that the viewport-relative
                // point the canvas reports for a right-click can be used as the menu's
                // position verbatim, with no topbar offset to keep in sync.
                this.menuLayer = el("div", { className: "easel-menu-layer" });
                this.viewport.append(
                    this.mediaLayer, this.staticCanvas, this.activeCanvas,
                    this.overlayCanvas, this.menuLayer
                );

                this.topbar = el("header", { className: "easel-topbar" });
                this.toolbar = el("nav", { className: "easel-toolbar" });

                root.append(this.topbar, this.viewport, this.toolbar);
                this.shadowRoot.appendChild(root);

                this._syncZenColors();
                this._watchTopbarPref();

                this.store = new window.ZenEaselStore(this);
                this.renderer = new window.ZenEaselRenderer(this, {
                    static: this.staticCanvas,
                    active: this.activeCanvas,
                    overlay: this.overlayCanvas
                });
                this.media = new window.ZenEaselMediaLayer(this, this.mediaLayer);
                this.textEditor = new window.ZenEaselTextEditor(this, this.viewport);
                this.textControls = new window.ZenEaselTextControls(this, this.viewport);
                this.shapeControls = new window.ZenEaselShapeControls(this, this.viewport);
                this.canvas = new window.ZenEaselCanvas(this, this.viewport);
                this.tools = new window.ZenEaselTools(this, this.toolbar, this.menuLayer);
                this.library = new window.ZenEaselLibrary(this, this.topbar);
                this.capture = new window.ZenEaselCapture(this);
                // No layer element is passed any more: live tiles are <browser> elements and
                // cannot exist in this document, so they live in the browser window and this
                // object only owns the model. See modules-host/live-host.uc.js.
                this.live = new window.ZenEaselLiveLayer(this);

                this.tools.render();
                this.library.render();

                this.viewport.focus({ preventScroll: true });

                // Before _boot: GlanceOpen can fire while the store is still opening,
                // and the listener has to already be on the tab or we miss the only
                // signal that the overlay has its real size.
                this._armGlanceSync();
                this._bootPromise = this._boot();
            } catch (e) {
                console.error("[zen-easel] failed to build the page:", e);
                this._showError(e);
            }
        }

        async _boot() {
            try {
                await this.store.init();

                // ?easel=<id> is what makes a restored tab come back to the easel it was
                // showing rather than to whichever was last touched in some other window.
                const wanted = new URLSearchParams(window.location.search).get("easel");
                let doc = (wanted && await this.store.open(wanted)) || await this.store.openLast();

                // Settled before the document is handed to the canvas, and so before
                // anything has attached tiles, refreshed the library or written a thumbnail.
                //
                // A board may only be open in one tab. Duplicate Tab and a restored session
                // both reach this point holding a board another tab already has, and two
                // pages on one document is the state the multi-board design assumes away:
                // the live host binds a board's tiles to whichever tab it finds first, and
                // whichever page autosaves second discards the other's edits.
                //
                // The chrome window is the only side that can see every tab, so it decides.
                // What to do about a refusal depends on why this page is here, and the two
                // cases genuinely differ:
                //
                //   an explicit ?easel=   somebody asked for *this* board. It is already
                //                         open, so the tab that has it is focused and this
                //                         one closes. That is what the ask meant.
                //   openLast              nobody asked for a board at all — this is the
                //                         toolbar button or the shortcut, which mean "give
                //                         me an easel". Closing would make the gesture
                //                         appear to do nothing but pull focus to another
                //                         window. A new board is the honest reading.
                doc = await this._claimOrReplace(doc, !!wanted);
                if (!doc) return;

                this.canvas.setDocument(doc);
                this.library.refresh();
                this._syncTabIdentity();

                // Boot may have finished after Glance already wrote has-finished-animation
                // (openGlance resolves at the same moment it fires GlanceOpen). The
                // listener would have set _glanceSyncPending with no document to apply
                // it to; do it now that there is one.
                if (this._glanceSyncPending || this._glanceOverlaySettled()) {
                    this._syncGlanceViewport();
                }

                // Reclaiming orphaned assets is housekeeping, not part of opening an
                // easel: it is rate-limited to once a day internally, and deferred to
                // idle so it never competes with the first paint.
                window.requestIdleCallback(() => {
                    this.store.collectGarbage().catch(e => console.error("[zen-easel] sweep failed:", e));
                }, { timeout: 10000 });
            } catch (e) {
                console.error("[zen-easel] boot failed:", e);
                this._showError(e);
            }
        }

        // Returns the document this tab may keep, or null when the tab is closing.
        //
        // Only one round of this: a board created here is brand new, so no other tab can be
        // holding it and a second claim could not fail. Recursing would be an invitation to
        // spin if that ever stopped being true.
        async _claimOrReplace(doc, explicit) {
            const browser = window.browsingContext?.embedderElement;
            if (!doc || !this.bridge || !browser) return doc;
            if (this.bridge.claimEasel(doc.id, browser)) return doc;

            if (explicit) {
                this.requestClose();
                return null;
            }
            try {
                return await this.store.create("Untitled Easel");
            } catch (e) {
                console.error("[zen-easel] could not open a second board:", e);
                this.requestClose();
                return null;
            }
        }

        // Told by whatever just showed or hid a panel of this page's own. Live tiles are
        // <browser> elements above this whole document, and the only thing keeping them off
        // the toolbar and the topbar is a hole cut in their layer where each piece of chrome
        // is — see live-layer's syncChromeClip.
        //
        // Needed because painting here is on demand: a popup opening moves nothing on the
        // board, so nothing would schedule the frame that would otherwise notice it.
        chromeChanged() {
            this.live?.syncChromeClip();
        }

        _showError(e) {
            const message = e && e.message ? e.message : String(e);
            (this.viewport || this.shadowRoot).appendChild(el("div", {
                className: "easel-error",
                textContent: `Zen Easel could not start: ${message}`
            }));
        }

        /* ------------------------------------------------------------- identity */

        // The tab's label follows document.title through the usual DOMTitleChanged path,
        // and the URL carries the easel id so session restore lands on the right board.
        // replaceState rather than assignment: navigating would reload the page.
        _syncTabIdentity() {
            const doc = this.store.current;
            if (!doc) return;

            document.title = doc.title ? `${doc.title} — Easel` : "Easel";

            const url = new URL(window.location.href);
            if (url.searchParams.get("easel") !== doc.id) {
                url.searchParams.set("easel", doc.id);
                try {
                    window.history.replaceState(null, "", url.href);
                } catch (e) {
                    // about: URIs are unusual enough that this is worth surviving; the
                    // only cost is that a restore reopens the last-touched easel instead.
                    log("could not rewrite the page URL:", e.message);
                }
            }
        }

        // Called by the switcher whenever the open document changes.
        onDocumentChanged() {
            this._syncTabIdentity();
        }

        // The heading on the board was edited, so the easel has been renamed. Fired on
        // every keystroke while typing into it, hence the cheap work only: the tab label
        // and the topbar, with the index entry riding along on the save the same edit
        // already queued.
        onTitleChanged() {
            // refresh(), not render(): render() rebuilds the topbar, which would drop the
            // switcher list and the zoom readout mid-keystroke. refresh() already routes
            // on to _syncTabIdentity through onDocumentChanged.
            if (this.library) this.library.refresh();
            else this._syncTabIdentity();
        }

        // Zen's theme lives in the browser window, not in this document, so the values the
        // easel's chrome is built from are copied across.
        //
        // The easel's panels used to be the *board's* colour at a heavier alpha, which meant
        // dragging the background slider dragged the toolbar and the menus with it — and at low
        // board alpha they flipped light/dark mid-gesture. The chrome follows Zen's workspace
        // theme instead, so it stays put whatever the board is doing. Only the board itself,
        // the grid and the canvas-painted card chrome still follow the background.
        //
        // Custom properties are read through a probe rather than off the root: getPropertyValue
        // hands back a custom property as authored, so a Zen colour written as light-dark() or
        // color-mix() would come back as a token string nothing here can parse. Resolving it as
        // a real background-color is what turns it into rgb().
        _syncZenColors() {
            const chrome = this.chromeWindow;
            if (!chrome) return;
            try {
                const rootStyle = chrome.getComputedStyle(chrome.document.documentElement);
                const copy = (from, to) => {
                    const v = rootStyle.getPropertyValue(from);
                    if (v && v.trim()) this.style.setProperty(to, v.trim());
                };
                copy("--zen-primary-color", "--easel-accent");

                // finally, because this element is in the *browser window's* document, not in
                // this page — an exception between the append and the remove would leave it
                // there, and this runs on every tab foreground, so it would be one orphan per
                // switch for the life of the window.
                const probe = chrome.document.createElement("div");
                let surface;
                try {
                    probe.style.cssText =
                        "position:fixed;top:-9999px;width:0;height:0;pointer-events:none;" +
                        "background-color:var(--zen-colors-tertiary, var(--zen-main-browser-background, Field))";
                    chrome.document.documentElement.appendChild(probe);
                    surface = chrome.getComputedStyle(probe).backgroundColor;
                } finally {
                    probe.remove();
                }

                const Objects = window.ZenEaselObjects;
                const rgb = Objects.rgbOf(surface);
                if (!rgb) return;

                this.style.setProperty("--easel-chrome-tint", rgb.join(", "));
                this.style.setProperty("--easel-chrome-solid", `rgb(${rgb.join(", ")})`);
                // Which ink the chrome takes, decided the same way the board decides its own —
                // and it has to be decided here, because light-dark() answers a question about
                // the OS scheme rather than about the surface these panels are actually wearing.
                const ink = Objects.luminanceOf(surface) > 0.45 ? "light" : "dark";
                if (this.getAttribute("data-easel-chrome-ink") === ink) return;
                this.setAttribute("data-easel-chrome-ink", ink);

                // A "Follow theme" board follows *this* switch, so a theme that moved while the
                // tab was away has to be pushed through the board as well. Absent on the first
                // call, which runs before there is a canvas to tell.
                this.canvas?._applyBackground();
                this.canvas?.invalidate();
            } catch (e) {
                log("could not read Zen's theme:", e.message);
            }
        }

        /* --------------------------------------------------------------- glance */

        // Glance is a chrome overlay, not a smaller content window. about:easel boots
        // during addTab — full tab-panels size — and Glance then restyles the wrapper
        // to 80% and often freezes the docshell for the arc animation. The canvas
        // ResizeObserver never sees that shrink, so the board keeps the dimensions it
        // measured on the first layout.
        //
        // GlanceOpen is the committed-size signal; has-finished-animation is the same
        // moment in CSS, used both as a backup if we attached too late and as the
        // "already settled" test when boot finishes after openGlance has resolved.
        _armGlanceSync() {
            this._onGlanceOpen = () => this._syncGlanceViewport();
            const browser = window.browsingContext?.embedderElement;
            const chrome = this.chromeWindow;
            if (!browser) return;

            if (chrome?.gBrowser) {
                try {
                    const tab = chrome.gBrowser.getTabForBrowser(browser);
                    if (tab) {
                        tab.addEventListener("GlanceOpen", this._onGlanceOpen);
                        this._glanceTab = tab;
                    }
                } catch (e) { }
            }

            const wrapper = browser.closest(".browserContainer");
            if (wrapper && typeof MutationObserver === "function") {
                this._glanceWrapper = wrapper;
                this._glanceWrapperObserver = new MutationObserver(() => {
                    if (this._glanceOverlaySettled()) this._syncGlanceViewport();
                });
                this._glanceWrapperObserver.observe(wrapper, {
                    attributes: true,
                    attributeFilter: ["has-finished-animation", "animate"]
                });
            }

            if (this._glanceOverlaySettled()) this._syncGlanceViewport();
        }

        _glanceOverlaySettled() {
            const wrapper = this._glanceWrapper ||
                window.browsingContext?.embedderElement?.closest(".browserContainer");
            return !!(wrapper && wrapper.hasAttribute("has-finished-animation"));
        }

        _syncGlanceViewport() {
            if (!this.canvas) return;
            if (!this.canvas.doc) {
                this._glanceSyncPending = true;
                return;
            }
            this._glanceSyncPending = false;
            this.canvas.syncToContainer();
            // Glance writes the overlay box in the same turn as GlanceOpen. An
            // in-process about: page can lag one frame behind that chrome CSS change,
            // especially if the docshell was inactive for the animation.
            if (this._glanceSyncFrame) return;
            this._glanceSyncFrame = window.requestAnimationFrame(() => {
                this._glanceSyncFrame = 0;
                this.canvas?.syncToContainer();
            });
        }

        _disarmGlanceSync() {
            if (this._glanceSyncFrame) {
                window.cancelAnimationFrame(this._glanceSyncFrame);
                this._glanceSyncFrame = 0;
            }
            if (this._glanceTab && this._onGlanceOpen) {
                try { this._glanceTab.removeEventListener("GlanceOpen", this._onGlanceOpen); } catch (e) { }
            }
            if (this._glanceWrapperObserver) {
                try { this._glanceWrapperObserver.disconnect(); } catch (e) { }
            }
            this._glanceTab = null;
            this._glanceWrapper = null;
            this._glanceWrapperObserver = null;
            this._onGlanceOpen = null;
        }

        /* --------------------------------------------------------------- topbar */

        // Read from the pref rather than util's cache: the two observers fire in no
        // particular order, so the cache may still hold the old value here.
        get topbarHidden() {
            return window.ZenEaselUtil.prefBool(TOPBAR_PREF, false);
        }

        _watchTopbarPref() {
            this._topbarObserver = { observe: () => this._syncTopbar() };
            Services.prefs.addObserver(TOPBAR_PREF, this._topbarObserver);
            this._syncTopbar();
        }

        // Hiding the bar takes the switcher with it, so the board list moves into the
        // canvas' context menu — see tools' _openEaselPanel.
        _syncTopbar() {
            const hidden = this.topbarHidden;
            if ((this.getAttribute("data-easel-topbar") === "hidden") === hidden) return;

            if (hidden) this.setAttribute("data-easel-topbar", "hidden");
            else this.removeAttribute("data-easel-topbar");

            // A popup hanging off a bar that has just gone would be left with no anchor.
            if (hidden) {
                this.library?.closeList();
                this.library?.closeCensus();
            }
            this.chromeChanged();
        }

        /* --------------------------------------------------------------- bridge */

        // May be null — during teardown, or if this document is ever loaded somewhere
        // without a chrome parent. Every caller degrades rather than throwing.
        get chromeWindow() {
            try {
                return window.browsingContext?.topChromeWindow ?? null;
            } catch (e) {
                return null;
            }
        }

        // The chrome window's half of the seam. Named for what it is rather than "host",
        // which the modules already use for this element.
        get bridge() {
            return this.chromeWindow?.gZenEaselHost ?? null;
        }

        // The overlay closed itself; a page closes its tab.
        requestClose() {
            const chrome = this.chromeWindow;
            const browser = window.browsingContext?.embedderElement;
            if (!chrome || !browser) return;
            try {
                const tab = chrome.gBrowser.getTabForBrowser(browser);
                if (tab) chrome.gBrowser.removeTab(tab);
            } catch (e) {
                console.error("[zen-easel] could not close the easel tab:", e);
            }
        }

        toast(message) {
            const bridge = this.bridge;
            if (bridge) bridge.toast(message);
            else console.error("[zen-easel]", message);
        }

        async flush() {
            if (this.store) await this.store.flush();
        }

        // A glance satellite is about to write this board. This page's copy must not
        // autosave over it, and its live layer should stop painting — the satellite
        // will attach to the same tiles.
        freezeWrites() {
            try { this.store?.freezeWrites(); } catch (e) { }
            try { this.live?.background(); } catch (e) { }
        }

        async reloadFromDisk() {
            if (!this.store) return;
            this._applyReloaded(await this.store.reloadFromDisk());
        }

        // The unprompted half of reloadFromDisk: reads only when the file has moved on
        // without this page. See store's refreshIfStale.
        async refreshIfStale() {
            if (!this.store) return;
            this._applyReloaded(await this.store.refreshIfStale());
        }

        _applyReloaded(doc) {
            if (!doc) return;
            this.canvas?.setDocument(doc);
            this.library?.refresh();
            this._syncTabIdentity();
        }

        teardown() {
            this._disarmGlanceSync();
            if (this._topbarObserver) {
                try { Services.prefs.removeObserver(TOPBAR_PREF, this._topbarObserver); } catch (e) { }
                this._topbarObserver = null;
            }
            for (const part of [
                this.live, this.media, this.textEditor, this.textControls, this.shapeControls,
                this.canvas,
                this.tools, this.library, this.capture, this.store
            ]) {
                try { part && part.destroy(); } catch (e) { console.error(e); }
            }
        }
    }

    if (!customElements.get("zen-easel")) {
        try {
            customElements.define("zen-easel", ZenEaselElement);
        } catch (e) {
            console.error("[zen-easel] could not register the page element:", e);
        }
    }

    /* ------------------------------------------------------------- controller */

    class ZenEaselPage {
        constructor() {
            this._onPageHide = this._onPageHide.bind(this);
            this._onPageShow = this._onPageShow.bind(this);
            this._onVisibility = this._onVisibility.bind(this);

            this.element = document.getElementById("zen-easel-page");
            if (!this.element) {
                console.error("[zen-easel] the page has no <zen-easel> element");
                return;
            }

            window.addEventListener("pagehide", this._onPageHide);
            window.addEventListener("pageshow", this._onPageShow);
            document.addEventListener("visibilitychange", this._onVisibility);

            // A CSP refusal is not an error anywhere else: the load is simply cancelled,
            // no error page is shown, and a live tile just stays blank forever. That is
            // exactly how frame-src being absent from this page's policy went unnoticed —
            // so the violation is reported here rather than left to be inferred.
            document.addEventListener("securitypolicyviolation", event => {
                console.error(
                    `[zen-easel] blocked by this page's CSP: ${event.effectiveDirective} ` +
                    `refused ${event.blockedURI}`
                );
                if (event.effectiveDirective.startsWith("frame-src")) {
                    this.element?.toast("This page's security policy is blocking live cards");
                }
            });
            log("page ready");
        }

        get easelId() {
            return this.element?.store?.current?.id ?? null;
        }

        // Called from the chrome window after a capture, which is why it takes plain
        // data: bytes and strings, nothing belonging to the other global.
        async addCapture(result) {
            if (!this.element) return;
            await this.element._bootPromise;
            await this.element.capture.addCaptureToDocument(result);
        }

        // The overlay has its real size. Used by the host after openGlance resolves,
        // which is after GlanceOpen — the page's own listener may already have run,
        // or boot may still have been in flight.
        async syncToContainer() {
            if (!this.element) return;
            await this.element._bootPromise;
            this.element._syncGlanceViewport();
        }

        freezeWrites() { this.element?.freezeWrites(); }

        async reloadFromDisk() {
            if (this.element) await this.element.reloadFromDisk();
        }

        async refreshIfStale() {
            if (this.element) await this.element.refreshIfStale();
        }

        // Called by ZenEaselLiveParent when a right-click lands inside a live card. The
        // coordinates arrive in screen space, which is the one frame of reference both
        // sides share without either needing to know about the tile's scale or crop.
        showLiveContextMenu(screenX, screenY) {
            const element = this.element;
            const live = element?.live;
            if (!live || !live.activeId) return;

            const obj = element.canvas.objects.find(o => o.id === live.activeId);
            if (!obj) return;

            // Step out first: the menu is the easel's, so the pointer should be too.
            live.deactivate();

            const rect = element.viewport.getBoundingClientRect();
            const point = {
                x: screenX - window.mozInnerScreenX - rect.left,
                y: screenY - window.mozInnerScreenY - rect.top
            };

            element.canvas.select([obj.id]);
            element.tools.showContextMenu(point, obj, element.canvas.toWorld(point.x, point.y));
        }

        // Escape was pressed inside a live tile. Same step-out the context menu does first,
        // on its own: the pointer goes back to the board and the card's bar comes with it.
        releaseLiveTile() {
            try { this.element?.live?.deactivate(); } catch (e) { console.error(e); }
        }

        // The host has hidden or re-shown this board's whole layer — a tab switch, a split
        // view change, the window being minimised. The canvas skips a live card's screenshot
        // on the understanding that a <browser> is covering it, so it has to hear about this
        // or the board is a set of holes for as long as the layer is down.
        onLiveBoardPainting(painting) {
            try { this.element?.live?.setHostPainting(painting); } catch (e) { console.error(e); }
        }

        // A tile settled on a page. Which page it is decides whether it is worth keeping as
        // the card's picture — an interstitial or an off-origin login wall is not — and it
        // is also the moment the tile can be asked what layout box it actually got.
        onLiveTileLanded(objectId, landedUrl, first) {
            const element = this.element;
            if (!element || !element.live) return;
            try { element.live.onLanded(objectId, landedUrl, first); } catch (e) { console.error(e); }
        }

        // The host gave up on a tile — refused, errored, timed out or its process died. The
        // page owns the model, so it has to hear about it: until it does, the canvas keeps
        // leaving a hole where the card used to be painted.
        onLiveTileLost(objectId, reason) {
            const element = this.element;
            if (!element || !element.live) return;
            element.live.forget(objectId);
            if (reason) element.toast(reason);
        }

        // pagehide is the only guaranteed notification a tab gets, and it cannot await.
        // Handing the serialised document to the background queue is synchronous, and
        // that queue's shutdown blocker owns the guarantee from there.
        _onPageHide() {
            try { this.element?.store?.handOffForUnload(); } catch (e) { console.error(e); }
            // detach, not a teardown. The tiles belong to the browser window and outlive this
            // document by design; what goes away here is the view onto them. If the tab is
            // genuinely closing rather than reloading, the host's own orphan check notices
            // within a couple of seconds and stops them.
            try { this.element?.live?.detach(); } catch (e) { console.error(e); }
        }

        // The other half of _onPageHide, which did not have one.
        //
        // detach() leaves the view with no board and _suspended set, and that is correct
        // for the case it was written for — the document is about to stop existing. But
        // pagehide also fires for a document that is only being *put away*: navigate off
        // about:easel and press Back and the same page comes out of the session history
        // with its script state intact, already visible, so no visibilitychange follows and
        // nothing else would ever re-attach. The board then renders, saves and edits
        // normally while every live control silently does nothing — _mount refuses on the
        // null easelId and sync() returns at its first line.
        //
        // Re-attaching is enough to put it right. Whatever was running was stopped on the
        // way out, so there is nothing to adopt; what this restores is the view's ability to
        // start something again. Guarded on persisted, because an ordinary first load
        // arrives here too and setDocument has already attached by then.
        _onPageShow(event) {
            if (!event.persisted) return;
            try { this.element?.live?.foreground(); } catch (e) { console.error(e); }
        }

        // Backgrounding stops the tiles *painting*. It used to stop them existing, which is
        // why a board left open in another tab came back to a set of stale screenshots — a
        // dashboard on an easel should still be a dashboard when you look at it again.
        // Covers window minimise too, which is the other thing this signal is good for.
        _onVisibility() {
            if (document.hidden) {
                try { this.element?.live?.background(); } catch (e) { console.error(e); }
                // Switching away is the moment a thumbnail is most likely to be wanted and
                // least likely to be in the way — the next thing you do may well be to open
                // the library. Unlike pagehide, the page is still alive here, so this can
                // actually finish.
                this.element?.store?.writeThumbnail({ force: true })
                    .catch(e => console.error("[zen-easel] thumbnail failed:", e));
            } else {
                // Re-attaches as well as repainting: a tab switch never runs setDocument, so
                // without this nothing would ever put the view back onto its board.
                try { this.element?.live?.foreground(); } catch (e) { console.error(e); }
                // Zen's theme may have moved while this board was away — switching workspace is
                // the usual way — and nothing in this document would otherwise say so.
                try { this.element?._syncZenColors(); } catch (e) { console.error(e); }
                // So may the file. A capture taken from another workspace is written by a
                // glance satellite over there, and this copy has to notice before it can be
                // edited — an edit would save the older board straight over the capture.
                this.element?.refreshIfStale()
                    ?.catch(e => console.error("[zen-easel] could not refresh the board:", e));
            }
        }

        destroy() {
            window.removeEventListener("pagehide", this._onPageHide);
            window.removeEventListener("pageshow", this._onPageShow);
            document.removeEventListener("visibilitychange", this._onVisibility);
            try { this.element?.teardown(); } catch (e) { console.error(e); }
        }
    }

    // Called by easel-boot.js once the DOM has an element to bind to.
    window.ZenEaselPageInit = function ZenEaselPageInit() {
        if (window.gZenEaselPage) return window.gZenEaselPage;
        window.gZenEaselPage = new ZenEaselPage();
        return window.gZenEaselPage;
    };
})();
