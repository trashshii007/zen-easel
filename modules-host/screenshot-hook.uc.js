// Zen Easel — Zen screenshot integration.
//
// Puts "Easel" on Zen's screenshot UI, after the capture rather than before it: drag a
// region, then choose where it goes. Zen has three screenshot surfaces and this reaches
// two of them, which between them cover every way a capture can be made:
//
//   1. The region bar — Copy / Download, under a dragged selection — is anonymous content
//      injected into the *page* by ScreenshotsOverlayChild, in the content process. Not
//      reachable from chrome, so it is reached from inside that process instead, by the
//      ZenEaselScreenshot actor. See actors/ZenEaselScreenshotChild.sys.mjs.
//   2. The preview dialog, shown after "Save visible page" / "Save full page", is a Lit
//      element in a tab dialog — parent process, open shadow root. Reachable directly.
//
//   3. The pre-capture buttons panel used to carry two buttons of ours and no longer does.
//      Both routes it offered now arrive by way of surface 2, and the panel was where the
//      "sometimes the buttons are missing" bug lived: ScreenshotsUtils.openPanel treats
//      that panel as a per-window singleton it only ever re-shows, so a <screenshots-buttons>
//      connectedCallback patch runs once per window and loses a microtask race against
//      createPanel every time. What made it work at all was a single unretried catch-up
//      query. There is nothing to race here — the button is built as part of the overlay's
//      own markup, every time the overlay is built.
//
// Nothing in this file re-captures. The region the user dragged is encoded from the
// selection Zen already has, so there is no second overlay and no hand-off delay.

"use strict";

(function () {
    if (window.ZenEaselScreenshotHook) return;

    const BASE = "chrome://sine/content/zen-easel/";
    const PREVIEW_URL = "chrome://browser/content/screenshots/screenshots-preview.html";
    const SCREENSHOTS_UTILS = "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs";

    const MENU_ID = "zen-easel-send-to";
    // The same glyph the easel's own tab carries, and the one the region bar's button
    // redraws inline in actors/ZenEaselScreenshotChild.sys.mjs.
    const ICON = BASE + "resources/zen-easel-board.svg";

    // How many easels the menu offers before the rest move behind "See all easels…".
    // Arc showed two; three fits the same shape without making the common case a submenu.
    const RECENT_COUNT = 3;

    // Chrome CSS px below the anchor button, clearing the bar's own padding and border.
    const MENU_GAP = 14;

    // Wakes the content process's copy of the actor, which patches ScreenshotsOverlay on
    // first contact. Free after that: the child stays alive for the document's lifetime and
    // ensurePatched() returns immediately once the prototype carries its flag.
    //
    // The retry is the same repair capture-host does around its own actor, and for the same
    // reason: getActor throws when the registration this process holds predates the actor
    // definition, which is the normal state of affairs after editing the mod without
    // restarting. Re-registering goes through actors.sys.mjs — asking the registry would
    // only reinstall whatever stale copy it is holding.
    function prime(browser) {
        const windowGlobal = browser.browsingContext.currentWindowGlobal;
        // Checked rather than left to throw, so a tab caught mid-navigation cannot send the
        // repair below down a process-wide unregister/re-register of the actor. There is
        // nothing stale about the registration in that case; there is simply nobody to ask.
        if (!windowGlobal) return;
        try {
            windowGlobal.getActor("ZenEaselScreenshot")
                .sendAsyncMessage("ZenEaselScreenshot:Prime");
            return;
        } catch (e) {
            console.warn("[zen-easel] the screenshot actor did not answer, re-registering " +
                "it and trying once more:", e);
        }

        const { ensureActor } = ChromeUtils.importESModule(BASE + "background/actors.sys.mjs");
        if (!ensureActor("ZenEaselScreenshot")) return;

        windowGlobal.getActor("ZenEaselScreenshot")
            .sendAsyncMessage("ZenEaselScreenshot:Prime");
    }

    class ZenEaselScreenshotHook {
        // Takes the controller, not the overlay element: this has to work when no easel is
        // open, which is the normal case when taking a screenshot.
        constructor(controller) {
            this.controller = controller;
            this.log = window.ZenEaselUtil.log;
            this._topics = [];
            this._destroyed = false;
            this._menu = null;
            this._menuOpen = false;
            // Both topics can fire for the same document, and the dialog is reopened on
            // every screenshot, so attachment is deduplicated per document.
            this._seen = new WeakSet();
        }

        init() {
            // Two topics on purpose. chrome-document-loaded is the precise one, but it
            // fires late enough in the load that a future Gecko could reorder it;
            // document-element-inserted is noisier but fires for every document without
            // exception. Both are filtered on documentURI immediately, so the cost of
            // the redundant one is a string comparison per document created.
            for (const topic of ["chrome-document-loaded", "document-element-inserted"]) {
                try {
                    Services.obs.addObserver(this, topic);
                    this._topics.push(topic);
                } catch (e) {
                    console.error(`[zen-easel] could not observe ${topic}:`, e);
                }
            }
            // Registered from here as well as from registry.sys.mjs at boot, for the reason
            // set out in actors.sys.mjs: the registry is a background module whose top level
            // never runs again, so a process that started before this actor existed is
            // holding a registration that does not include it — and nothing in the registry
            // can fix that, because the registry is the stale thing. This file is re-run on
            // every window and every reload, so it can.
            try {
                const { ensureActor } = ChromeUtils.importESModule(BASE + "background/actors.sys.mjs");
                ensureActor("ZenEaselScreenshot");
            } catch (e) {
                console.error("[zen-easel] could not register the screenshot actor:", e);
            }

            this._installPrimePatch();
        }

        destroy() {
            this._destroyed = true;
            for (const topic of this._topics) {
                try { Services.obs.removeObserver(this, topic); } catch (e) { }
            }
            this._topics = [];

            // The menu is this window's, so it goes with this window. The prime patch below
            // is emphatically *not* undone here — see its header.
            if (this._menu) {
                try { this._menu.remove(); } catch (e) { }
                this._menu = null;
            }
        }

        /* ------------------------------------------------------------- priming */

        // Makes sure the content process has patched its ScreenshotsOverlay before Zen
        // builds one, by hanging a prime message off the one call that always precedes it.
        //
        // showPanelAndOverlay is the sole sender of Screenshots:ShowOverlay, for both the
        // first open and a retry. Our message and theirs ride the same PWindowGlobal and are
        // delivered in order, so the patch is always in place first.
        //
        // INSTALL ONCE, RESTORE NEVER. ScreenshotsUtils is a *process* singleton, while this
        // runs from a *per-window* script whose destroy() fires on every window close and
        // every Sine reload. An unpatch on teardown would therefore let one window closing
        // silently disarm every other window still open — which is exactly the failure this
        // rewrite exists to remove. Idempotency is handled here, at install time, by keeping
        // the original on the object and re-wrapping it: a reload replaces the patch, and a
        // second window finds the work already done.
        _installPrimePatch() {
            let ScreenshotsUtils;
            try {
                ({ ScreenshotsUtils } = ChromeUtils.importESModule(SCREENSHOTS_UTILS));
            } catch (e) {
                console.error("[zen-easel] Zen's screenshot component could not be found, " +
                    "so captures cannot be sent to an easel:", e);
                return;
            }

            const original = ScreenshotsUtils._zenEaselOriginalShowPanel ||
                ScreenshotsUtils.showPanelAndOverlay;
            ScreenshotsUtils._zenEaselOriginalShowPanel = original;

            ScreenshotsUtils.showPanelAndOverlay = function (browser, data) {
                try {
                    prime(browser);
                } catch (e) {
                    // A page whose process refuses the actor still gets Zen's own screenshot
                    // UI, minus our button. Never let this throw into Zen's call.
                    console.warn("[zen-easel] could not prime the screenshot actor " +
                        "for this page:", e);
                }
                return original.call(this, browser, data);
            };

            this.log("primed Zen's screenshot overlay");
        }

        /* ---------------------------------------------- surface 1: the region bar */

        // Called by ZenEaselScreenshotParent when the button on Zen's region bar is clicked.
        // `payload` is what the child sent: { region, scrollMinX, scrollMinY, anchor }.
        async onRegionPick(browser, payload) {
            let easelId;
            try {
                easelId = await this._openMenu({ screen: this._screenPoint(payload.anchor) });
            } catch (e) {
                this._menuFailed(e);
                return;
            }
            if (!easelId || this._destroyed) return;

            try {
                const { ScreenshotsUtils } = ChromeUtils.importESModule(SCREENSHOTS_UTILS);

                try { ScreenshotsUtils.closePanel(browser); } catch (e) { }

                // The overlay has to go before the shutter, not after. drawSnapshot paints
                // anonymous content like any other content, so the selection border, the
                // corner handles and the size readout land inside the picture if the overlay
                // is still up — which is exactly what happened before this call existed.
                //
                // Zen's own Copy tears the overlay down synchronously as it queues its
                // capture message. This mod cannot: the overlay has to survive while the menu
                // is open, or the user would be choosing a destination for a selection they
                // can no longer see. So it comes down here, after the pick, and this is a
                // sendQuery rather than a sendAsyncMessage so the capture below cannot start
                // until the teardown has actually finished.
                await this._endOverlay(browser);

                const picker = new window.ZenEaselCaptureHost();
                let capture;
                try {
                    capture = await picker.captureContentRegion(browser, payload);
                } finally {
                    picker.destroy();
                    // exit() is the one call that closes all three of Zen's surfaces, and it
                    // has to run even when the capture threw. The overlay is already down by
                    // then, but ScreenshotsUtils still counts a screenshot as in progress, so
                    // the next Ctrl+Shift+2 would cancel that phantom instead of starting a
                    // new one — a failed capture would cost the shortcut its next press.
                    try { ScreenshotsUtils.exit(browser); } catch (e) { }
                }

                await this.controller.openWithCapture(easelId, capture);
            } catch (e) {
                console.error("[zen-easel] could not send the screenshot to an easel:", e);
                this.controller.toast(e && e.message ? e.message : "Could not send that capture");
            }
        }

        // Asks the content process to dismiss Zen's overlay, and waits for it.
        //
        // A failure here is worth continuing past: the capture still succeeds, it just has
        // the overlay's handles drawn into it. A picture with furniture in it beats no
        // picture and an error the user cannot act on.
        async _endOverlay(browser) {
            try {
                await browser.browsingContext.currentWindowGlobal
                    .getActor("ZenEaselScreenshot")
                    .sendQuery("ZenEaselScreenshot:EndOverlay");
            } catch (e) {
                console.warn("[zen-easel] could not dismiss Zen's overlay before capturing, " +
                    "so its handles may appear in the image:", e);
            }
        }

        // Another window's CSS pixels into this one's, by way of device pixels.
        //
        // A position reported by another document is in *that* document's CSS pixels, and
        // page zoom is folded into its devicePixelRatio — so the two are not the same size
        // and cannot simply be added to a chrome coordinate. Device pixels are the one unit
        // both agree on. This is also what makes the menu land correctly on a second monitor
        // running at a different scale.
        //
        // `anchor` is { left, bottom, devicePixelRatio } in the source window's screen space.
        _screenPoint(anchor) {
            const ratio = (anchor.devicePixelRatio || 1) / (window.devicePixelRatio || 1);
            return { x: anchor.left * ratio, y: anchor.bottom * ratio };
        }

        // The same thing for an element we can reach directly.
        //
        // Used for the preview dialog's button, which is emphatically not in this window's
        // document — it is inside a <browser> in a TabDialogBox — so openPopup(element) is
        // not available to anchor against. Going through screen coordinates works the same
        // way for both surfaces and does not depend on how the dialog happens to be nested.
        _screenPointOf(element) {
            const view = element.ownerDocument.defaultView;
            const rect = element.getBoundingClientRect();
            return this._screenPoint({
                left: view.mozInnerScreenX + rect.left,
                bottom: view.mozInnerScreenY + rect.bottom,
                devicePixelRatio: view.devicePixelRatio
            });
        }

        /* ------------------------------------------ surface 2: preview dialog */

        observe(subject) {
            const doc = subject;
            try {
                if (!doc || !doc.documentURI || !doc.documentURI.startsWith(PREVIEW_URL)) return;
                if (this._seen.has(doc)) return;
                // The observer service is global, so every open window is notified.
                // Only the window that actually owns this dialog should act.
                const owner = doc.defaultView &&
                    doc.defaultView.browsingContext &&
                    doc.defaultView.browsingContext.topChromeWindow;
                if (owner !== window) return;

                this._seen.add(doc);
                this._attachPreview(doc).catch(e => console.error("[zen-easel] screenshot hook failed:", e));
            } catch (e) {
                console.error("[zen-easel] screenshot hook failed:", e);
            }
        }

        async _attachPreview(doc) {
            const view = doc.defaultView;
            await view.customElements.whenDefined("screenshots-preview");

            const preview = doc.querySelector("screenshots-preview");
            if (!preview) return;
            // MozLitElement renders asynchronously; the button row does not exist until
            // the first update has settled.
            if (preview.updateComplete) await preview.updateComplete;

            const row = preview.shadowRoot && preview.shadowRoot.querySelector(".preview-buttons");
            if (!row || row.querySelector("#zen-easel-move")) return;

            const button = doc.createElement("moz-button");
            button.id = "zen-easel-move";
            button.setAttribute("label", "Easel");
            button.setAttribute("iconSrc", ICON);
            button.addEventListener("click", event => {
                // The dialog's own handler switches on the button, and would otherwise see
                // one it does not recognise.
                event.stopPropagation();
                this._openMenu({ screen: this._screenPointOf(button) })
                    .then(easelId => easelId && this._moveTo(preview, easelId))
                    .catch(e => this._menuFailed(e));
            });

            // Before Copy, so the primary Download button keeps its position at the end.
            row.insertBefore(button, row.querySelector("#copy") || null);
            this.log("attached to the screenshot preview");
        }

        async _moveTo(preview, easelId) {
            const image = preview.previewImg;
            const browser = preview.openerBrowser;
            if (!image || !browser) return;

            try {
                const capture = await this._encode(image, browser);
                // Close the dialog before opening the easel, or the tab dialog keeps the
                // content area covered and the overlay appears behind it.
                preview.close();
                await this.controller.openWithCapture(easelId, capture);
            } catch (e) {
                console.error("[zen-easel] could not move the screenshot:", e);
            }
        }

        // Re-encodes the already-loaded preview image rather than reading its blob: URL,
        // which belongs to ScreenshotsUtils' global rather than ours. Both documents are
        // system-principal, so drawing across them does not taint the canvas.
        //
        // The backdrop is already in these pixels rather than being applied here: this image
        // was composited by ScreenshotsUtils.createCanvas, which background/capture-backdrop
        // .sys.mjs replaces with a copy that uses the themed colour. So re-encoding preserves
        // it, and there is nothing for this path to do about the backdrop itself.
        async _encode(image, browser) {
            if (!image.complete || !image.naturalWidth) {
                await new Promise((resolve, reject) => {
                    image.addEventListener("load", resolve, { once: true });
                    image.addEventListener("error", reject, { once: true });
                });
            }

            const width = image.naturalWidth;
            const height = image.naturalHeight;
            const canvas = new OffscreenCanvas(width, height);
            canvas.getContext("2d").drawImage(image, 0, 0);

            const blob = await canvas.convertToBlob({ type: "image/png" });
            const bytes = new Uint8Array(await blob.arrayBuffer());

            return {
                bytes, width, height,
                url: browser.currentURI ? browser.currentURI.spec : "",
                title: this._titleFor(browser),
                favicon: this._faviconFor(browser),
                // The same shape captureContentRegion builds, container included. A shot
                // moved here from Zen's screenshot UI is as much "the site as I was seeing
                // it" as one dragged out with the region picker, and omitting this left
                // exactly one path that still reproduced a container tab's card in the
                // default container.
                userContextId: window.ZenEaselCaptureHost._userContextIdOf(browser),
                capture: await this._previewLayout(browser, width, height)
            };
        }

        // Live-card geometry for a capture that came out of the preview dialog.
        //
        // The dialog does not say whether it is showing a visible-page or a full-page shot,
        // so it is inferred from the size: a visible-page capture is the viewport, and its
        // crop is therefore the whole viewport at no offset. A full-page one is taller than
        // the viewport and cannot be reproduced by scrolling to a single position, so it gets
        // no geometry and the card simply never offers to go live.
        //
        // Without this the answer was "no geometry, ever" — every screenshot moved from this
        // dialog produced a card that could not go live, for no reason a user could see.
        async _previewLayout(browser, width, height) {
            try {
                const picker = new window.ZenEaselCaptureHost();
                // `measured` rather than `viewport`: the result carries a viewport *field*
                // of its own now — the scrollbar-inclusive box — and viewport.viewport
                // reads like a typo.
                let measured;
                try {
                    measured = await picker.measureViewport(browser);
                } finally {
                    picker.destroy();
                }
                if (!measured) return null;

                const dpr = (window.devicePixelRatio || 1) * (browser.fullZoom || 1);
                const { w, h } = measured.webContentSize;

                // Generous tolerance: the capture is rounded to device pixels and the
                // measured box excludes the scrollbar gutter, so exact equality never holds.
                const near = (a, b) => Math.abs(a - b) <= Math.max(4, b * 0.02);
                if (!near(width / dpr, w) || !near(height / dpr, h)) return null;

                return {
                    type: "visiblePage",
                    webContentSize: measured.webContentSize,
                    // Carried through like the rest. The frame below is built from the
                    // scrollbar-*exclusive* box, which stays the right origin and size for
                    // the crop whichever box the tile is laid out in.
                    viewport: measured.viewport || null,
                    webContentOffset: measured.webContentOffset,
                    frameRelativeToViewport: { x: 0, y: 0, w, h }
                };
            } catch (e) {
                console.warn("[zen-easel] could not work out the preview capture layout:", e);
                return null;
            }
        }

        /* ------------------------------------------------------- the shared menu */

        // One menu for both surfaces, and a native one.
        //
        // This replaces a hand-built <div> that had to solve three problems no XUL popup
        // has: it was clipped away to nothing when parented inside Zen's screenshots panel
        // (position:fixed plus overflow:hidden), it had to dismiss itself on composedPath
        // because a shadow root retargeted its own clicks, and it could not use a stylesheet
        // at all, because the preview dialog's CSP is `default-src chrome:`. A menupopup is
        // an OS-level widget: nothing can clip it, it dismisses and keyboard-navigates
        // itself, it flips when it would run off a screen edge, and Zen themes it.
        //
        // Resolves with the chosen target — an easel id, or "new" — or null if the menu was
        // dismissed without a pick.
        async _openMenu(where) {
            const popup = this._ensureMenu();
            if (!popup) throw new Error("this window has no popup set to put the menu in");

            // One menu at a time, and this is a guard rather than tidiness. The region-bar
            // route is driven by a message from the content process, which can send as many
            // as it likes; a second one arriving while the menu is up would refill the popup
            // under the pointer and leave two promises waiting on the same popuphidden, so
            // one pick would start two captures of the same region.
            if (this._menuOpen) return null;
            this._menuOpen = true;

            try {
                // Straight from the background store rather than through the page's store
                // client, which does not exist in this window — and which would anyway mean
                // this menu could only be built while an easel happened to be open.
                const { EaselStore } = ChromeUtils.importESModule(BASE + "background/store.sys.mjs");
                const easels = await EaselStore.listEasels();
                if (this._destroyed) return null;

                // Rebuilt on every open rather than once. The easel list changes underneath
                // it — a board renamed, one created by the last capture — and a menu
                // assembled at init would show whatever was true then. Built here, before the
                // popup is shown, because the list has to be awaited and popupshowing cannot
                // wait.
                this._fill(popup, easels);
                this.log("send-to-easel menu:", easels.length, "easels");

                return await new Promise(resolve => {
                    let picked = null;

                    const onCommand = event => {
                        picked = event.target.getAttribute("value") || null;
                    };
                    // Only the outer popup's own hide ends this. A submenu closing fires
                    // popuphidden too, and it bubbles.
                    const onHidden = event => {
                        if (event.target !== popup) return;
                        popup.removeEventListener("command", onCommand);
                        popup.removeEventListener("popuphidden", onHidden);
                        resolve(picked);
                    };

                    popup.addEventListener("command", onCommand);
                    popup.addEventListener("popuphidden", onHidden);

                    // At a screen position rather than anchored to an element, because
                    // neither surface's button is in this document — one is anonymous content
                    // in a content process, the other is inside a tab dialog's browser. The
                    // popup flips itself when it would run off an edge, so the point is a
                    // preference rather than a demand.
                    popup.openPopupAtScreen(where.screen.x, where.screen.y + MENU_GAP, false);
                });
            } finally {
                this._menuOpen = false;
            }
        }

        _ensureMenu() {
            if (this._menu && this._menu.isConnected) return this._menu;

            const host = document.getElementById("mainPopupSet");
            if (!host) return null;

            // A previous instance of this script may have left one behind: Sine re-runs
            // window scripts on every rebuild, and only a clean destroy() removes ours.
            const stale = document.getElementById(MENU_ID);
            if (stale) stale.remove();

            const popup = document.createXULElement("menupopup");
            popup.id = MENU_ID;
            host.appendChild(popup);

            this._menu = popup;
            return popup;
        }

        _fill(popup, easels) {
            while (popup.firstChild) popup.firstChild.remove();

            // Recents first — nearest the pointer — and listEasels() returns them newest-first.
            const recent = easels.slice(0, RECENT_COUNT);
            for (const easel of recent) popup.appendChild(this._easelItem(easel));

            if (recent.length) popup.appendChild(document.createXULElement("menuseparator"));

            // Always present: with no easels yet it is the only entry.
            popup.appendChild(this._item("New Easel", null, "new"));

            const rest = easels.slice(RECENT_COUNT);
            if (!rest.length) return;

            const more = document.createXULElement("menu");
            more.setAttribute("label", "See all easels…");
            const submenu = document.createXULElement("menupopup");
            for (const easel of rest) submenu.appendChild(this._easelItem(easel));
            more.appendChild(submenu);
            popup.appendChild(more);
        }

        _easelItem(easel) {
            return this._item(easel.title || "Untitled Easel", this._when(easel.updatedAt), easel.id);
        }

        // acceltext is what gives the row its right-aligned "2m ago" without a custom
        // binding — the same slot a keyboard shortcut would use.
        _item(label, hint, target) {
            const item = document.createXULElement("menuitem");
            item.setAttribute("class", "menuitem-iconic");
            item.setAttribute("label", label);
            item.setAttribute("image", ICON);
            item.setAttribute("value", target);
            if (hint) item.setAttribute("acceltext", hint);
            return item;
        }

        // The easel list could not be read, so there is no menu to show. Said out
        // loud: the alternative is a button that does nothing for a reason only a
        // console nobody opened would have recorded.
        _menuFailed(error) {
            console.error("[zen-easel] could not list easels for the send-to menu:", error);
            this.controller.toast("Could not read your easels — see the Browser Console");
        }

        _when(timestamp) {
            if (!timestamp) return "";
            const delta = Date.now() - timestamp;
            const minute = 60000, hour = 3600000, day = 86400000;
            if (delta < minute) return "just now";
            if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
            if (delta < day) return `${Math.floor(delta / hour)}h ago`;
            if (delta < day * 7) return `${Math.floor(delta / day)}d ago`;
            return new Date(timestamp).toLocaleDateString();
        }

        /* ------------------------------------------------------------ browser */

        _titleFor(browser) {
            try {
                const tab = gBrowser.getTabForBrowser(browser);
                return (tab && tab.label) || browser.contentTitle || "";
            } catch (e) {
                return "";
            }
        }

        // Only local favicon URLs are kept, for the same reason as in capture-host.uc.js: a
        // remote icon would make the easel reach out to the network on every render.
        _faviconFor(browser) {
            try {
                const tab = gBrowser.getTabForBrowser(browser);
                const icon = tab && gBrowser.getIcon(tab);
                if (!icon) return "";
                return /^(page-icon:|data:|chrome:|moz-)/.test(icon) ? icon : "";
            } catch (e) {
                return "";
            }
        }
    }

    window.ZenEaselScreenshotHook = ZenEaselScreenshotHook;
})();
