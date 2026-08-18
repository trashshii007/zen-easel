// Zen Easel — Zen screenshot integration.
//
// Puts "Move to easel" on Zen's own screenshot UI, in the two places a mod can reach.
// Zen has three screenshot surfaces and they are not equally reachable:
//
//   1. The buttons panel — "Save visible page" / "Save full page" — is a MozXULElement
//      in the chrome document with an open shadow root. Reachable: the element class is
//      defined per-window, so patching its connectedCallback catches every instance.
//   2. The preview dialog, shown after saving a visible or full page, is a Lit element
//      in a tab dialog. Reachable via the document it loads.
//   3. The bar that appears under a dragged region (Copy / Download) is anonymous
//      content injected into the *page* by ScreenshotsOverlayChild, in the content
//      process. NOT reachable from chrome — there is no handle to another component's
//      anonymous content.
//
// So region captures are handled by handing off instead: picking an easel from surface
// 1 dismisses Zen's overlay and starts this mod's own region picker, which is chrome-side
// and already lands captures on easels.

"use strict";

(function () {
    if (window.ZenEaselScreenshotHook) return;

    const PREVIEW_URL = "chrome://browser/content/screenshots/screenshots-preview.html";
    const SCREENSHOTS_UTILS = "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs";

    // Zen's overlay closes asynchronously — exit() messages the content process. Our
    // region picker has to wait for that, or the two overlays briefly overlap and the
    // dying one can swallow the first click.
    const HANDOFF_DELAY_MS = 180;

    class ZenEaselScreenshotHook {
        // Takes the controller, not the overlay element: this has to work when no easel
        // is open, which is the normal case when taking a screenshot.
        constructor(controller) {
            this.controller = controller;
            this.log = window.ZenEaselUtil.log;
            this._topics = [];
            this._destroyed = false;
            this._unpatch = null;
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
            this._patchButtonsPanel();
        }

        destroy() {
            this._destroyed = true;
            for (const topic of this._topics) {
                try { Services.obs.removeObserver(this, topic); } catch (e) { }
            }
            this._topics = [];
            if (this._unpatch) {
                this._unpatch();
                this._unpatch = null;
            }
        }

        /* ------------------------------------------- surface 1: buttons panel */

        // The <screenshots-buttons> class is defined per chrome window by the subscript
        // loader, so patching its prototype here affects only this window and catches
        // every instance without having to watch for the panel being created.
        async _patchButtonsPanel() {
            let ctor;
            try {
                ctor = await window.customElements.whenDefined("screenshots-buttons");
            } catch (e) {
                return;   // screenshots never used in this window
            }
            if (this._destroyed || !ctor || ctor.prototype._zenEaselPatched) return;

            const proto = ctor.prototype;
            const original = proto.connectedCallback;
            const hook = this;

            proto._zenEaselPatched = true;
            proto.connectedCallback = function () {
                original.apply(this, arguments);
                try {
                    hook._addMoveButton(this);
                } catch (e) {
                    // Never let this break Zen's own screenshot UI.
                    console.error("[zen-easel] could not add the easel button:", e);
                }
            };

            this._unpatch = () => {
                proto.connectedCallback = original;
                delete proto._zenEaselPatched;
            };

            // The panel may already be open when the patch lands.
            const live = document.querySelector("screenshots-buttons");
            if (live) {
                try { this._addMoveButton(live); } catch (e) { console.error(e); }
            }
            this.log("patched the screenshots buttons panel");
        }

        _addMoveButton(element) {
            const group = element.shadowRoot && element.shadowRoot.querySelector("moz-button-group");
            if (!group || group.querySelector("#zen-easel-move")) return;

            const doc = element.ownerDocument;

            // The menu lives at the document root rather than inside this panel, so it
            // outlives the panel being dismissed without a pick. Clear any left over
            // from a previous screenshot, or the next click would only toggle it away.
            const stale = doc.getElementById("zen-easel-menu");
            if (stale) stale.remove();

            // Two entries, mirroring the two things Arc's capture offers: pick a region, or
            // take the window as it stands. Both open the same easel menu; they differ only
            // in what happens once a destination has been chosen.
            const add = (id, label, mode) => {
                const button = doc.createElement("button");
                button.id = id;
                // Same classes the built-in buttons use, so it inherits their styling
                // rather than imitating it.
                button.className = "screenshot-button footer-button";
                button.textContent = label;
                button.addEventListener("click", event => {
                    // The panel's own click handler switches on event.target and would
                    // otherwise see an unrecognised button.
                    event.stopPropagation();
                    // Caught, not left dangling. _openMenu is async and reads the
                    // easel index off disk; an unhandled rejection here makes the
                    // button look simply dead, with nothing in the console to say
                    // why — which is exactly how a broken store presents itself.
                    this._openMenu(doc, element.shadowRoot, button,
                        easelId => this._handOff(easelId, mode))
                        .catch(e => this._menuFailed(e));
                });
                group.appendChild(button);
            };

            add("zen-easel-move", "Move to easel", "region");
            add("zen-easel-move-window", "Whole window to easel", "fullWindow");
        }

        // Dismisses Zen's screenshot UI and starts this mod's region picker, which is
        // chrome-side and drops straight onto the chosen easel. The region bar Zen shows
        // for a dragged selection cannot be extended from here (see the header), so the
        // capability is provided rather than the exact button.
        async _handOff(easelId, mode = "region") {
            const browser = gBrowser.selectedBrowser;
            this.log("handing off to the easel region picker, target:", easelId);

            let exited = false;
            try {
                const { ScreenshotsUtils } = ChromeUtils.importESModule(SCREENSHOTS_UTILS);
                // exit() is the one call that closes all three of Zen's surfaces —
                // dialog, panel and the in-page overlay.
                ScreenshotsUtils.exit(browser);
                exited = true;
            } catch (e) {
                console.error("[zen-easel] could not close Zen's screenshot UI:", e);
            }

            // Belt and braces: if exit() was unavailable or partial, at least take the
            // panel down so it is not left floating over our own picker.
            const panel = document.querySelector(".screenshotsPagePanel");
            if (panel && !panel.hidden) panel.hidden = true;
            this.log("Zen screenshot UI closed via exit():", exited);

            // Zen's overlay lives in the content process, so exit() is asynchronous
            // from here. Starting our picker immediately would let the dying overlay
            // swallow the first click.
            await new Promise(resolve => setTimeout(resolve, HANDOFF_DELAY_MS));
            if (this._destroyed) return;
            // A full-window shot needs the delay just as much: exit() is still tearing the
            // overlay down in the content process, and it would otherwise be in the picture.
            if (mode === "fullWindow") await this.controller.captureFullWindow(easelId);
            else await this.controller.captureRegion(easelId);
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
            button.setAttribute("label", "Move to easel");
            button.setAttribute("iconSrc", "chrome://sine/content/zen-easel/resources/zen-easel.svg");
            button.addEventListener("click", event => {
                event.stopPropagation();
                this._openMenu(doc, preview.shadowRoot, button, id => this._moveTo(preview, id))
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
                favicon: this._faviconFor(browser)
            };
        }

        /* ------------------------------------------------------- shared menu */

        // One menu for both surfaces. Styles are set as element properties rather than
        // through a stylesheet: the preview dialog's CSP is `default-src chrome:`, which
        // blocks an injected <style>, and doing it the same way in both places keeps
        // them from drifting apart.
        async _openMenu(doc, container, anchor, onPick) {
            // Searched for in the whole document, because that is where it is put — see
            // the note on the append below. Looking only inside `container` meant a menu
            // that had been left behind was never found, so the toggle never noticed it
            // and a stale one could sit invisibly forever.
            const existing = doc.getElementById("zen-easel-menu");
            if (existing) {
                existing.remove();
                return;
            }

            // Straight from the background store rather than through the page's store
            // client, which does not exist in this window — and which would anyway mean
            // this menu could only be built while an easel happened to be open.
            const { EaselStore } =
                ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/store.sys.mjs");
            const easels = await EaselStore.listEasels();
            if (this._destroyed) return;

            const menu = doc.createElement("div");
            menu.id = "zen-easel-menu";

            // One teardown path, so picking an item removes the document listener too
            // rather than leaving it registered until the next outside click.
            let dismiss = null;
            const close = () => {
                menu.remove();
                if (dismiss) doc.removeEventListener("pointerdown", dismiss, true);
            };

            Object.assign(menu.style, {
                position: "fixed",
                // Above Zen's screenshot panel, which is itself high in the stack. The
                // old value of 10 was chosen against the preview dialog, where nothing
                // competes; in the browser window it is well below the panel the menu
                // has to sit on top of.
                zIndex: "2147483647",
                minWidth: "220px",
                maxHeight: "320px",
                overflowY: "auto",
                padding: "4px",
                borderRadius: "8px",
                border: "1px solid var(--border-color, rgba(128,128,128,0.35))",
                background: "var(--background-color-box, Field)",
                color: "var(--text-color, FieldText)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                font: "message-box",
                fontSize: "13px"
            });

            const addRow = (label, detail, target) => {
                const item = doc.createElement("button");
                Object.assign(item.style, {
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: "12px", width: "100%", padding: "7px 9px",
                    border: "none", borderRadius: "5px", background: "transparent",
                    color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer"
                });
                item.addEventListener("mouseenter", () => {
                    item.style.background = "var(--button-background-color-hover, rgba(128,128,128,0.18))";
                });
                item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });

                const name = doc.createElement("span");
                name.textContent = label;
                Object.assign(name.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
                item.appendChild(name);

                if (detail) {
                    const hint = doc.createElement("span");
                    hint.textContent = detail;
                    Object.assign(hint.style, { flex: "none", opacity: "0.6", fontSize: "11px" });
                    item.appendChild(hint);
                }

                item.addEventListener("click", event => {
                    event.stopPropagation();
                    close();
                    // Deliberately not awaited: the caller opens overlays and captures,
                    // and a rejection here would otherwise be an invisible unhandled
                    // promise rather than something the console shows.
                    Promise.resolve(onPick(target)).catch(err =>
                        console.error("[zen-easel] move to easel failed:", err));
                });
                menu.appendChild(item);
            };

            for (const easel of easels.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
                addRow(easel.title || "Untitled Easel", this._when(easel.updatedAt), easel.id);
            }

            if (easels.length) {
                const rule = doc.createElement("div");
                Object.assign(rule.style, {
                    height: "1px", margin: "4px 3px",
                    background: "var(--border-color, rgba(128,128,128,0.3))"
                });
                menu.appendChild(rule);
            }

            // Always offered: with no easels yet this is the only entry, and it is also
            // the fastest way to start a fresh board from something you just captured.
            addRow("New easel…", null, "new");

            // Appended to the document root, not into the surface's shadow root.
            //
            // `position: fixed` is only relative to the viewport while no ancestor
            // establishes a containing block for it, and it is still clipped by an
            // ancestor's `overflow: hidden`. Zen's screenshots panel is a small rounded
            // box that does both, so a menu parented inside it was laid out — with real
            // dimensions, and no error anywhere — and then clipped away to nothing. The
            // button looked dead because the menu was genuinely there and genuinely
            // invisible.
            //
            // At the document root there is nothing above it to clip or re-anchor it.
            // The capture overlay in capture-host.uc.js is placed the same way, for the
            // same reason.
            (doc.documentElement || doc.body).appendChild(menu);

            const anchorRect = anchor.getBoundingClientRect();
            const view = doc.defaultView;
            const size = menu.getBoundingClientRect();
            this.log("move-to-easel menu opened:", easels.length, "easels,",
                `${Math.round(size.width)}x${Math.round(size.height)}`);

            // Clamp on both axes. The panel sits at the top-right of the content area,
            // so a menu placed at the anchor's left edge runs off the side of the
            // window — which is exactly what happened when maximised.
            const left = Math.min(
                Math.max(8, anchorRect.left),
                Math.max(8, view.innerWidth - size.width - 8)
            );
            const below = anchorRect.bottom + 6;
            const top = below + size.height > view.innerHeight
                ? Math.max(8, anchorRect.top - size.height - 6)
                : below;

            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;

            // composedPath, not event.target. The menu lives inside a shadow root, so
            // at document level the target is retargeted to the shadow HOST — making a
            // contains() check false for our own items, dismissing the menu on
            // pointerdown and killing the click before it could ever fire.
            dismiss = event => {
                const path = event.composedPath();
                if (path.includes(menu) || path.includes(anchor)) return;
                close();
            };
            doc.addEventListener("pointerdown", dismiss, true);
        }

        // The easel list could not be read, so there is no menu to show. Said out
        // loud: the alternative is a button that does nothing for a reason only a
        // console nobody opened would have recorded.
        _menuFailed(error) {
            console.error("[zen-easel] could not list easels for the move menu:", error);
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

        // Only local favicon URLs are kept, for the same reason as in capture.uc.js: a
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
