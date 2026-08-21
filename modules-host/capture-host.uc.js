// Zen Easel — taking the picture.
//
// The browser-window half of what used to be capture.uc.js. Region selection runs
// entirely in the chrome process: doing the selection here rather than in a content
// script means it needs no frame script, is not blocked by a page's CSP, and still works
// on about: pages and the PDF viewer where content injection is refused outright.
//
// Pixels come from WindowGlobalParent.drawSnapshot — the same privileged path Firefox
// Screenshots uses. We snapshot the whole viewport and crop locally rather than asking
// drawSnapshot for a sub-rect: a sub-rect would have to be expressed in document
// coordinates, which means knowing the content's scroll offset, which from the parent
// process means standing up a JSActor. Cropping a viewport bitmap needs none of that.
//
// Everything handed back to the page is plain data — a byte array, numbers and strings.

"use strict";

(function () {
    if (window.ZenEaselCaptureHost) return;

    // How often the hover preview may ask the page what is under the pointer. Slow enough
    // that a moving pointer costs a handful of round trips a second, fast enough that the
    // highlight does not lag behind the cursor.
    const PREVIEW_INTERVAL_MS = 60;

    // What Firefox composites a snapshot onto, and what this falls back to whenever the
    // capture backdrop has nothing to say.
    const WHITE = "rgb(255,255,255)";

    class ZenEaselCaptureHost {
        constructor() {
            this.log = window.ZenEaselUtil.log;
            this._overlay = null;
            this._cancelPick = null;
            this._previewAt = 0;
            this._previewBusy = false;
        }

        /* ----------------------------------------------------- region selection */

        // Resolves with { bytes, width, height, url, title, favicon, capture } or null if
        // the user cancelled.
        async pickRegionAndCapture() {
            const browser = gBrowser.selectedBrowser;
            if (!browser) return null;

            const region = await this.pickRegion(browser);
            if (!region) return null;

            return this.captureRegion(browser, region);
        }

        pickRegion(browser) {
            return new Promise(resolve => {
                const rect = browser.getBoundingClientRect();
                const overlay = document.createElement("div");
                overlay.className = "zen-easel-capture-overlay";
                Object.assign(overlay.style, {
                    left: `${rect.left}px`,
                    top: `${rect.top}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`
                });

                const selection = document.createElement("div");
                selection.className = "zen-easel-capture-rect";
                selection.style.display = "none";

                const hint = document.createElement("div");
                hint.className = "zen-easel-capture-hint";
                hint.textContent = "Drag a region, or click something  ·  Esc to cancel";

                overlay.append(selection, hint);
                document.documentElement.appendChild(overlay);
                this._overlay = overlay;

                let start = null;
                let done = false;

                const finish = result => {
                    if (done) return;
                    done = true;
                    cleanup();
                    resolve(result);
                };

                const cleanup = () => {
                    overlay.removeEventListener("pointerdown", onDown);
                    overlay.removeEventListener("pointermove", onMove);
                    overlay.removeEventListener("pointerup", onUp);
                    overlay.removeEventListener("contextmenu", onContextMenu);
                    window.removeEventListener("keydown", onKeyDown, true);
                    overlay.remove();
                    this._overlay = null;
                    this._cancelPick = null;
                };

                const onDown = e => {
                    if (e.button !== 0) return;
                    start = { x: e.clientX, y: e.clientY };
                    selection.style.display = "";
                    hint.style.opacity = "0";
                    // Hands the dimming over to the selection rect's outset shadow so the
                    // chosen region is seen at full brightness.
                    overlay.classList.add("is-selecting");
                    overlay.setPointerCapture(e.pointerId);
                    e.preventDefault();
                };

                const place = box => {
                    selection.style.display = "";
                    Object.assign(selection.style, {
                        left: `${box.x - rect.left}px`,
                        top: `${box.y - rect.top}px`,
                        width: `${box.w}px`,
                        height: `${box.h}px`
                    });
                };

                const onMove = e => {
                    if (!start) {
                        // Nothing is being dragged, so show what a click would take.
                        // Without this, click-to-capture is a guess.
                        this._previewElement(browser, rect, e.clientX, e.clientY, box => {
                            if (start || done) return;
                            if (box) {
                                overlay.classList.add("is-selecting");
                                hint.style.opacity = "0";
                                place(box);
                            } else {
                                overlay.classList.remove("is-selecting");
                                hint.style.opacity = "";
                                selection.style.display = "none";
                            }
                        });
                        return;
                    }
                    place(normalize(start, { x: e.clientX, y: e.clientY }, rect));
                };

                const onUp = async e => {
                    if (!start) return;
                    const box = normalize(start, { x: e.clientX, y: e.clientY }, rect);
                    // A click rather than a drag: take the element under the pointer, which
                    // is Arc's canClickToCapture. Falling back to null keeps the old
                    // behaviour for a mis-click on a page that cannot be measured.
                    if (box.w < 8 || box.h < 8) {
                        finish(await this._elementRect(browser, rect, e.clientX, e.clientY));
                        return;
                    }
                    finish(box);
                };

                const onKeyDown = e => {
                    if (e.code === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        finish(null);
                    }
                };

                const onContextMenu = e => {
                    e.preventDefault();
                    finish(null);
                };

                overlay.addEventListener("pointerdown", onDown);
                overlay.addEventListener("pointermove", onMove);
                overlay.addEventListener("pointerup", onUp);
                overlay.addEventListener("contextmenu", onContextMenu);
                window.addEventListener("keydown", onKeyDown, true);
                this._cancelPick = () => finish(null);
            });

            // Clamped to the content area so a drag that leaves the window cannot produce
            // a region outside what was actually rendered.
            function normalize(a, b, bounds) {
                const x1 = Math.max(bounds.left, Math.min(a.x, b.x));
                const y1 = Math.max(bounds.top, Math.min(a.y, b.y));
                const x2 = Math.min(bounds.right, Math.max(a.x, b.x));
                const y2 = Math.min(bounds.bottom, Math.max(a.y, b.y));
                return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
            }
        }

        /* --------------------------------------------------- click to capture */

        // Asks the page which element is under a chrome-space point, and returns its rect
        // back in chrome space. Two coordinate hops, both undoing the same page zoom: the
        // overlay sits exactly over the <browser>, so subtracting its origin and dividing
        // by fullZoom lands in the page's own CSS pixels, and the reverse comes back.
        async _elementRect(browser, browserRect, clientX, clientY) {
            try {
                const windowGlobal = browser.browsingContext?.currentWindowGlobal;
                if (!windowGlobal) return null;

                const zoom = browser.fullZoom || 1;
                const actor = windowGlobal.getActor("ZenEaselCapture");
                const found = await actor.sendQuery("ZenEaselCapture:ScoreElement", {
                    x: (clientX - browserRect.left) / zoom,
                    y: (clientY - browserRect.top) / zoom
                });
                if (!found || !(found.w > 0) || !(found.h > 0)) return null;

                const box = {
                    x: browserRect.left + found.x * zoom,
                    y: browserRect.top + found.y * zoom,
                    w: found.w * zoom,
                    h: found.h * zoom
                };

                // An element that runs off the top or bottom of the viewport would be
                // captured as whatever is on screen anyway, so clamp rather than return a
                // rect the snapshot cannot honour.
                const x1 = Math.max(browserRect.left, box.x);
                const y1 = Math.max(browserRect.top, box.y);
                const x2 = Math.min(browserRect.right, box.x + box.w);
                const y2 = Math.min(browserRect.bottom, box.y + box.h);
                if (x2 - x1 < 8 || y2 - y1 < 8) return null;

                return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
            } catch (e) {
                this.log("could not score the element under the pointer:", e.message);
                return null;
            }
        }

        // Hover preview, throttled: one query in flight at a time and at most one per
        // PREVIEW_INTERVAL_MS. A query per pointermove would be an IPC round trip per
        // mouse sample, which is a hundred a second on a fast pointer.
        _previewElement(browser, browserRect, clientX, clientY, callback) {
            const now = Date.now();
            if (this._previewBusy || now - (this._previewAt || 0) < PREVIEW_INTERVAL_MS) return;
            this._previewAt = now;
            this._previewBusy = true;

            this._elementRect(browser, browserRect, clientX, clientY)
                .then(callback)
                .catch(() => callback(null))
                .finally(() => { this._previewBusy = false; });
        }

        /* ------------------------------------------------------------ snapshot */

        // Arc's captureFullWindowButtonTapped: the whole viewport, no picker. The card it
        // produces is live-capable in exactly the same way as a dragged one — its crop is
        // simply the entire viewport, which the live layer's k = obj.w / frame.w handles
        // without knowing the difference.
        async captureFullWindow(browser = gBrowser.selectedBrowser) {
            if (!browser) return null;
            const rect = browser.getBoundingClientRect();
            return this.captureRegion(browser, {
                x: rect.left, y: rect.top, w: rect.width, h: rect.height
            }, "fullWindow");
        }

        async captureRegion(browser, region, type = "partialPage") {
            const windowGlobal = browser.browsingContext && browser.browsingContext.currentWindowGlobal;
            if (!windowGlobal) throw new Error("this page cannot be captured");

            const browserRect = browser.getBoundingClientRect();
            // Ask for enough resolution that the capture is sharp on a HiDPI display and
            // at a zoomed-in page; the true scale is measured off the result below.
            const scale = (window.devicePixelRatio || 1) * (browser.fullZoom || 1);

            // What goes behind the page. Firefox always says white here, which erases a
            // page Zen is showing through — see capture-backdrop.uc.js. Null means the
            // feature is off or has no opinion, and white is then exactly what Firefox
            // would have done.
            let backdrop = null;
            try {
                backdrop = window.gZenEaselCaptureBackdrop
                    ? window.gZenEaselCaptureBackdrop.resolve(browser) : null;
            } catch (e) {
                console.error("[zen-easel] could not resolve a capture backdrop:", e);
            }

            let bitmap;
            try {
                bitmap = await windowGlobal.drawSnapshot(null, scale, backdrop || WHITE);
            } catch (e) {
                // A backdrop Gecko will not parse must not be the reason a capture fails.
                // Retried once on white before giving up, so the worst this feature can do
                // to a capture is leave it looking the way it does today.
                if (!backdrop) throw new Error("this page refused to be captured");
                console.warn("[zen-easel] the capture backdrop was refused, " +
                    "retrying on white:", e);
                try {
                    bitmap = await windowGlobal.drawSnapshot(null, scale, WHITE);
                } catch (e2) {
                    throw new Error("this page refused to be captured");
                }
            }
            if (!bitmap) throw new Error("nothing was rendered to capture");

            // Derive the scale from what came back rather than trusting the value we asked
            // for. This self-corrects for HiDPI and page zoom instead of depending on
            // getting devicePixelRatio * fullZoom exactly right.
            const scaleX = bitmap.width / browserRect.width;
            const scaleY = bitmap.height / browserRect.height;

            const sx = Math.round((region.x - browserRect.left) * scaleX);
            const sy = Math.round((region.y - browserRect.top) * scaleY);
            const sw = Math.max(1, Math.round(region.w * scaleX));
            const sh = Math.max(1, Math.round(region.h * scaleY));

            const canvas = new OffscreenCanvas(sw, sh);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
            bitmap.close();

            const blob = await canvas.convertToBlob({ type: "image/png" });
            const bytes = new Uint8Array(await blob.arrayBuffer());

            return {
                bytes,
                width: sw,
                height: sh,
                url: browser.currentURI ? browser.currentURI.spec : "",
                title: this._tabTitle(),
                favicon: window.gZenEaselHost ? window.gZenEaselHost.localFavicon() : "",
                capture: await this._captureLayout(browser, region, browserRect, type)
            };
        }

        // What the page was, at the moment the picture was taken: the layout box it was laid
        // out in, where it was scrolled to, and whether that offset is reproducible.
        //
        // Public, and the one place the measurement actor is asked for a viewport, because
        // there are two kinds of capture that need it — the ones this file takes, and the
        // ones Zen's own screenshot UI takes and hands to screenshot-hook.uc.js. A second
        // copy of this is how one of the two silently stops being live-capable.
        //
        // Returns null when the measurement is unavailable or unusable, which simply means
        // the card built from this capture will never offer to go live. Said out loud rather
        // than logged behind the debug pref: a card that quietly comes back with no live
        // control is exactly the failure that cannot be told apart from a bug.
        async measureViewport(browser) {
            try {
                const windowGlobal = browser && browser.browsingContext &&
                    browser.browsingContext.currentWindowGlobal;
                if (!windowGlobal) {
                    console.warn("[zen-easel] no window global to measure; " +
                        "this capture will not be live-capable");
                    return null;
                }

                const viewport = await this._query(windowGlobal);
                if (!viewport) {
                    console.warn("[zen-easel] the page reported no viewport; " +
                        "this capture will not be live-capable");
                    return null;
                }

                // A site that scrolls an inner container rather than the document cannot
                // have its offset reproduced by the tile — win.scrollTo has nothing to
                // act on, so the card would come back live and confidently show the top
                // of the page instead of what was captured. Recording no capture at all
                // means the card simply never offers to go live, which is the honest
                // version of the same answer.
                if (viewport.documentScrolls === false) {
                    console.warn("[zen-easel] this page scrolls an inner container, so the " +
                        "scroll position cannot be reproduced; this capture will not be live-capable");
                    return null;
                }

                return viewport;
            } catch (e) {
                console.warn("[zen-easel] could not measure the page for a live card:", e);
                return null;
            }
        }

        // The measurement round trip, with one repair attempt behind it.
        //
        // getActor throws when the registration this process is holding does not match the
        // window being asked. Registration happens once per process, from a background
        // module whose top level never runs again, while this file is re-run on every mod
        // reload — so a registration made before the actor definition was last edited stands
        // for the rest of the browser's life, and nothing about it is visible: captures keep
        // landing on the board and simply stop being live-capable.
        //
        // Re-registering here is what closes that gap, and it has to go through
        // actors.sys.mjs rather than registry.sys.mjs: the registry is one of those cached
        // background modules, so asking *it* to re-register only reinstalls whatever it was
        // holding. See the header in actors.sys.mjs.
        //
        // Only ZenEaselCapture is repaired. It is inert and has no instances to disturb;
        // the live actor is running inside every mounted tile and is not to be touched from
        // here.
        //
        // A second failure is left to the caller, which reports it — at that point the
        // definition itself is wrong rather than merely out of date.
        async _query(windowGlobal) {
            try {
                return await windowGlobal.getActor("ZenEaselCapture")
                    .sendQuery("ZenEaselCapture:Measure");
            } catch (e) {
                console.warn("[zen-easel] the capture actor did not answer, re-registering " +
                    "it and trying once more:", e);
            }

            const { ensureActor } = ChromeUtils.importESModule(
                "chrome://sine/content/zen-easel/background/actors.sys.mjs");
            if (!ensureActor("ZenEaselCapture")) return null;

            return windowGlobal.getActor("ZenEaselCapture")
                .sendQuery("ZenEaselCapture:Measure");
        }

        // The geometry a live web card needs later: the viewport size and scroll offset at
        // capture time, plus the selected rect in viewport coordinates. Persisting the
        // rect rather than a CSS selector is what makes a live card degrade to "the wrong
        // crop" instead of "broken" when a site is redesigned — the same trade Arc makes.
        //
        // Returns null when the measurement is unavailable, which simply means this card
        // will never offer to go live.
        async _captureLayout(browser, region, browserRect, type = "partialPage") {
            try {
                const viewport = await this.measureViewport(browser);
                if (!viewport) return null;

                // The overlay is positioned over the <browser>, so the region is already
                // in the browser's own CSS pixels once the origin is subtracted. Page zoom
                // is the one scale factor still in the way.
                const zoom = browser.fullZoom || 1;

                // No correction for the scrollbar gutter here, deliberately. The child
                // reports the scrollbar-free layout box, which is narrower than the
                // <browser> — but the gutter is entirely on the trailing edge, so the
                // content's origin is still the browser rect's top-left and the crop's
                // coordinates need no shift. What the narrower box changes is the width
                // the tile lays the page out at, and that is webContentSize's job.
                return {
                    type,
                    webContentSize: viewport.webContentSize,
                    webContentOffset: viewport.webContentOffset,
                    frameRelativeToViewport: {
                        x: Math.round((region.x - browserRect.left) / zoom),
                        y: Math.round((region.y - browserRect.top) / zoom),
                        w: Math.round(region.w / zoom),
                        h: Math.round(region.h / zoom)
                    }
                };
            } catch (e) {
                console.warn("[zen-easel] could not work out the capture layout:", e);
                return null;
            }
        }

        _tabTitle() {
            try {
                return gBrowser.selectedTab.label || "";
            } catch (e) {
                return "";
            }
        }

        destroy() {
            if (this._cancelPick) this._cancelPick();
            if (this._overlay) {
                this._overlay.remove();
                this._overlay = null;
            }
        }
    }

    window.ZenEaselCaptureHost = ZenEaselCaptureHost;
})();
