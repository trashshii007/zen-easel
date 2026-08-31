// Zen Easel — taking the picture.
//
// The browser-window half of what used to be capture.uc.js. It no longer selects anything:
// this file used to draw its own region picker over Zen's chrome, and that picker is gone.
// Zen's screenshot overlay now carries an "Easel" button and hands the selection here, so
// there is one capture UI in the browser rather than two — and it is the one with element
// highlighting and resize handles.
//
// What remains is the part that was always worth keeping: turning a region into pixels, and
// recording enough about the page that the card made from it can later be shown live.
//
// Pixels come from WindowGlobalParent.drawSnapshot — the same privileged path Firefox
// Screenshots uses — asked for an explicit document-space rect and tiled. The older code
// snapshotted the viewport and cropped, which was sound only because its own picker could
// not select anything off-screen. Zen's can: a drag that reaches the edge of the window
// scrolls the page under it.
//
// Everything handed back to the page is plain data — a byte array, numbers and strings.

"use strict";

(function () {
    if (window.ZenEaselCaptureHost) return;

    // What Firefox composites a snapshot onto, and what this falls back to whenever the
    // capture backdrop has nothing to say.
    const WHITE = "rgb(255,255,255)";

    // Both taken from ScreenshotsUtils, which exports them for the same purpose. The first
    // is the largest rect drawSnapshot will accept in one call, which is why a document-space
    // capture has to be tiled; the second is the largest surface Gecko will produce at all.
    // Kept as literals rather than imported: this file must keep working if a Zen update
    // renames the export, and being a few hundred pixels conservative costs nothing.
    const MAX_SNAPSHOT_DIMENSION = 1024;
    const MAX_CAPTURE_DIMENSION = 32766;

    class ZenEaselCaptureHost {
        constructor() {
            this.log = window.ZenEaselUtil.log;
        }

        /* ------------------------------------------------ captures from Zen's overlay */

        // A capture from a region Zen's own screenshot overlay selected.
        //
        // Worth knowing if the old picker is ever resurrected from git: this replaced a
        // captureRegion/_captureLayout pair that took its rect in *chrome* CSS pixels, where
        // the mod's picker drew it over the browser element, and divided out page zoom on the
        // way in. Zen's region arrives in *content* CSS pixels, relative to the document and
        // already zoom-corrected. The two are not interchangeable, and getting it wrong is
        // invisible: both corrections are no-ops at 100% zoom, which is the version anyone
        // testing would look at first.
        //
        // `payload` is what ZenEaselScreenshotChild sends: { region, scrollMinX, scrollMinY }.
        async captureContentRegion(browser, payload) {
            const windowGlobal = browser && browser.browsingContext &&
                browser.browsingContext.currentWindowGlobal;
            if (!windowGlobal) throw new Error("this page cannot be captured");

            const region = payload && payload.region;
            if (!region || !(region.width > 0) || !(region.height > 0)) {
                throw new Error("nothing was selected to capture");
            }

            // The whole reason this path does not simply call ScreenshotsUtils.createCanvas,
            // which hardcodes white in two places and would quietly undo the
            // transparent-page fix.
            let backdrop = null;
            try {
                backdrop = window.gZenEaselCaptureBackdrop
                    ? window.gZenEaselCaptureBackdrop.resolve(browser) : null;
            } catch (e) {
                console.error("[zen-easel] could not resolve a capture backdrop:", e);
            }

            let canvas;
            try {
                canvas = await this._snapshotPageRect(windowGlobal, region, backdrop || WHITE);
            } catch (e) {
                if (!backdrop) throw new Error("this page refused to be captured");
                console.warn("[zen-easel] the capture backdrop was refused, " +
                    "retrying on white:", e);
                canvas = await this._snapshotPageRect(windowGlobal, region, WHITE);
            }

            const blob = await canvas.convertToBlob({ type: "image/png" });
            const bytes = new Uint8Array(await blob.arrayBuffer());

            return {
                bytes,
                width: canvas.width,
                height: canvas.height,
                url: browser.currentURI ? browser.currentURI.spec : "",
                title: this._tabTitle(),
                favicon: window.gZenEaselHost ? window.gZenEaselHost.localFavicon() : "",
                // Which container the page was open in. A card shows the site as you were
                // seeing it, and *which* of your sessions you were seeing it with is part of
                // that: a shot taken in a container tab reproduced in the default one is a
                // different account, or no account at all, which is how a live card of a
                // signed-in page came back signed out.
                userContextId: ZenEaselCaptureHost._userContextIdOf(browser),
                capture: await this._contentCaptureLayout(browser, region, payload)
            };
        }

        // The container a browser is in, as a plain number. Read from the browsing context
        // rather than the attribute: the attribute is absent for the default container and
        // present as a string otherwise, and the origin attributes are what the cookie jar
        // is actually keyed on.
        //
        // Static because the other capture path — screenshot-hook's preview dialog — has to
        // record the same thing and has no reason to stand a picker up to ask.
        static _userContextIdOf(browser) {
            try {
                const id = browser?.browsingContext?.originAttributes?.userContextId;
                return Number.isInteger(id) && id > 0 ? id : 0;
            } catch (e) {
                return 0;
            }
        }

        // drawSnapshot with an explicit document-space rect, tiled.
        //
        // The old picker asked for `null` — the viewport — and cropped what came back, which
        // was sound only because it drew its rect over the visible browser and so could not
        // select anything off-screen. Zen's overlay can: scrollIfByEdge scrolls the page
        // when a drag reaches its edge, so a selection may sit partly or entirely outside the
        // current viewport by the time it is finished. Cropping a viewport bitmap for one of
        // those returns whatever happens to be at those coordinates now — silently, with a
        // picture that looks like a successful capture of the wrong thing.
        //
        // The tiling and the flooring below follow ScreenshotsUtils.createCanvas rather than
        // being re-derived: drawSnapshot refuses a rect past MAX_SNAPSHOT_DIMENSION, and
        // computing destination offsets any other way leaves seams between the tiles.
        async _snapshotPageRect(windowGlobal, region, backdrop) {
            const dpr = region.devicePixelRatio || 1;

            const left = Math.round(region.left);
            const top = Math.round(region.top);
            let right = Math.round(region.right);
            let bottom = Math.round(region.bottom);

            // Gecko will not produce a surface past this, and a refusal here reads as "the
            // page refused to be captured" rather than as the size problem it is. The limit
            // is in *device* pixels — cropScreenshotRectIfNeeded multiplies by the ratio
            // before comparing — so it has to be divided back out before it can clamp a
            // rect in CSS pixels. Clamping the CSS value directly is a no-op at ratio 1 and
            // lets through twice the allowed surface at ratio 2, which is an ordinary
            // Windows display.
            const limit = Math.max(1, Math.floor(MAX_CAPTURE_DIMENSION / dpr));
            right = Math.min(right, left + limit);
            bottom = Math.min(bottom, top + limit);

            const width = Math.max(1, right - left);
            const height = Math.max(1, bottom - top);

            const canvas = new OffscreenCanvas(
                Math.floor(width * dpr), Math.floor(height * dpr));
            const context = canvas.getContext("2d");

            // Fill first, for the same reason Firefox does: rounding can leave device pixel
            // rows the renderer never covers, and transparent is not what a capture means.
            context.fillStyle = backdrop;
            context.fillRect(0, 0, canvas.width, canvas.height);

            for (let x = left; x < right; x += MAX_SNAPSHOT_DIMENSION) {
                for (let y = top; y < bottom; y += MAX_SNAPSHOT_DIMENSION) {
                    const tileW = Math.min(MAX_SNAPSHOT_DIMENSION, right - x);
                    const tileH = Math.min(MAX_SNAPSHOT_DIMENSION, bottom - y);

                    const bitmap = await windowGlobal.drawSnapshot(
                        new DOMRect(x, y, tileW, tileH), dpr, backdrop);
                    if (!bitmap) throw new Error("nothing was rendered to capture");

                    context.drawImage(
                        bitmap,
                        Math.floor((x - left) * dpr), Math.floor((y - top) * dpr),
                        Math.floor(tileW * dpr), Math.floor(tileH * dpr));
                    bitmap.close();
                }
            }

            return canvas;
        }

        // The live-card geometry for a content-space region.
        //
        // Deliberately not the old _captureLayout with an extra argument — see the note on
        // captureContentRegion above. That one subtracted the browser's position and divided
        // by fullZoom because its input was in chrome pixels; both corrections are wrong for
        // a content-space region, and neither would be visible at 100% zoom.
        async _contentCaptureLayout(browser, region, payload, type = "partialPage") {
            try {
                // `measured` rather than `viewport`: the result carries a viewport *field*
                // of its own now — the scrollbar-inclusive box — and viewport.viewport
                // reads like a typo.
                const measured = await this.measureViewport(browser);
                if (!measured) return null;

                // Zen normalises page coordinates by subtracting scrollMinX/scrollMinY
                // (getCoordinatesFromEvent), while webContentOffset is the raw win.scrollX/Y
                // the measurement actor reports. The two agree on ordinary pages and differ
                // on RTL and negative-origin ones, so the region goes back into the raw space
                // before being differenced against the offset.
                const pageX = Math.round(region.left + (payload.scrollMinX || 0));
                const pageY = Math.round(region.top + (payload.scrollMinY || 0));

                const frame = {
                    x: Math.round(pageX - measured.webContentOffset.x),
                    y: Math.round(pageY - measured.webContentOffset.y),
                    w: Math.round(region.width),
                    h: Math.round(region.height)
                };

                // A selection made while the page edge-scrolled can end up outside the
                // viewport it is being expressed against. The tile restores the recorded
                // scroll offset and then crops at this rectangle, so an out-of-range one does
                // not fail — it confidently shows the wrong part of the site. Declining the
                // geometry means the card simply never offers to go live, which is the same
                // honest answer measureViewport gives for an inner-scrolling page.
                const size = measured.webContentSize;
                if (frame.x < 0 || frame.y < 0 ||
                    frame.x + frame.w > size.w || frame.y + frame.h > size.h) {
                    console.warn("[zen-easel] this selection reaches outside the viewport, " +
                        "so its scroll position cannot be reproduced; this capture will not " +
                        "be live-capable");
                    return null;
                }

                return {
                    type,
                    webContentSize: measured.webContentSize,
                    // The scrollbar-inclusive box, carried through so a live tile lays the
                    // page out against the viewport it was captured in rather than one a
                    // gutter narrower. Null on a measurement taken before it existed.
                    viewport: measured.viewport || null,
                    webContentOffset: measured.webContentOffset,
                    frameRelativeToViewport: frame
                };
            } catch (e) {
                console.warn("[zen-easel] could not work out the capture layout:", e);
                return null;
            }
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

        _tabTitle() {
            try {
                return gBrowser.selectedTab.label || "";
            } catch (e) {
                return "";
            }
        }

        // Nothing to tear down since the picker left — this held an overlay element and a
        // pending selection promise. Kept because every caller pairs construction with it in
        // a finally block, and because a capture host acquiring state again is likelier than
        // all of those call sites remembering to add the call back.
        destroy() { }
    }

    window.ZenEaselCaptureHost = ZenEaselCaptureHost;
})();
