// Zen Easel — the capture backdrop, parent-process half.
//
// Why any of this exists
// ----------------------
// Three ordinary things line up and produce a screenshot that looks half-erased:
//
//   1. Zen makes the content view transparent. With
//      browser.tabs.allow_transparent_browser set, tabbrowser.js puts transparent="true"
//      on every <browser>, which tells Gecko not to paint the default white canvas behind
//      a page. What shows through instead is the Zen window.
//   2. A styling extension — Zen Internet is the one this was written for — makes the
//      page's own background transparent so that window is visible: its per-site
//      "Transparency" rules are literally
//      `html, body, #root, … { background-color: transparent !important }`.
//   3. Every screenshot path composites onto white. In Firefox's ScreenshotsUtils,
//      createCanvas fills the canvas with rgb(255,255,255) and then asks
//      drawSnapshot for the pixels with the same colour behind them.
//
// A snapshot has no browser window behind it — nothing is there at all. So light text that
// reads perfectly over a dark Zen window lands on pure white and the image is blown out.
// Nothing is broken; the page is simply being composited against something other than
// what you were looking at.
//
// What this does about it
// -----------------------
// It puts the colour that was actually behind the page into the picture, by taking over
// createCanvas and passing that colour in the two places it hardcodes white — the fill that
// backs the canvas, and the background handed to drawSnapshot. The page is never touched:
// no stylesheet is injected, no extension is disabled, nothing in the content process is
// asked to do anything. Every failure path falls back to calling Firefox's own createCanvas,
// so the worst this file can do is produce exactly the white it was written to replace.
//
// Why this is a background module rather than a window script
// ----------------------------------------------------------
// ScreenshotsUtils is an ESM singleton, so patching it is process-global while every
// window script is per-window and is nuked when its window closes. A patch installed from
// window A that still referenced A's functions would start throwing "can't access dead
// object" the moment A was closed — with the only symptom being that screenshots quietly
// broke in every *other* window. So the patch lives here, in a realm that outlives every
// window, and it holds no window reference of its own: the colour is fetched at capture
// time from the browser's own window, used, and dropped.
//
// The usual background-module caveat applies — this file is imported once per process and
// its top level never runs again, so editing it changes nothing until Zen is restarted.

const SCREENSHOTS_UTILS =
    "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs";

// The largest rect drawSnapshot will render in one call, so a capture bigger than this is
// taken in tiles. Same value as ScreenshotsUtils' own MAX_SNAPSHOT_DIMENSION, kept as a
// literal rather than imported so a rename in a Zen update cannot break the hook.
const MAX_SNAPSHOT_DIMENSION = 1024;

/* --------------------------------------------------------------------- install */

// Idempotent, and cheap to call from every window: the second and later calls see the
// marker on the module object and return.
//
// Returns true when the hook is in place — which is not the same as "the backdrop is on".
// Whether a given screenshot gets one is decided per capture, by the window, from prefs.
export function installScreenshotBackdrop() {
    let ScreenshotsUtils;
    try {
        ({ ScreenshotsUtils } = ChromeUtils.importESModule(SCREENSHOTS_UTILS));
    } catch (e) {
        // A Zen update could move or rename this module. Zen Easel's own captures do not
        // go through it and keep working; only Zen's native screenshots lose the backdrop.
        console.warn("[zen-easel] could not reach Zen's screenshot module, so native " +
            "screenshots will keep compositing onto white:", e);
        return false;
    }

    if (!ScreenshotsUtils || typeof ScreenshotsUtils.createCanvas !== "function") {
        console.warn("[zen-easel] Zen's screenshot module has no createCanvas to hook; " +
            "native screenshots will keep compositing onto white");
        return false;
    }

    // Restore-then-repatch, rather than returning early when the marker is already set.
    //
    // The early return was the one path through this function that did nothing and still
    // reported success, which is exactly the shape of a bug that cannot be found from the
    // outside: the caller logs "hooked: true" and every screenshot still comes out white.
    // It also made the module impossible to fix in place — a patch installed by an earlier
    // revision owned the property for the rest of the session, and the only code that could
    // displace it was the same stale copy that installed it.
    //
    // Keeping the true original on the object instead means a second call re-wraps a clean
    // function rather than wrapping its own wrapper, and the newest copy of this module
    // always wins.
    const original = ScreenshotsUtils._zenEaselOriginalCreateCanvas ||
        ScreenshotsUtils.createCanvas;
    ScreenshotsUtils._zenEaselOriginalCreateCanvas = original;
    ScreenshotsUtils._zenEaselBackdrop = true;

    // createCanvas is the single funnel for all four of Zen's screenshot outputs — save
    // visible page, save full page, copy region, download region — and every internal
    // caller reaches it as `this.createCanvas`, so replacing the property covers all of
    // them. The preview dialog comes along for free: it displays whatever this returns.
    //
    // This used to wrap the original and substitute the colour further down, by shimming
    // drawSnapshot on the window global for the duration of the call. That was three moving
    // parts — an own-property shim with a prototype fallback, a WeakMap of in-flight
    // captures keyed on a reflector, and a gate that only fired when the caller passed
    // Firefox's exact white literal — and if any one of them missed, the capture came out
    // white with nothing said about why. It also could not reach the fillRect *inside*
    // createCanvas, which left a white hairline along the right and bottom edges at a
    // fractional devicePixelRatio.
    //
    // Reimplementing the function outright replaces all of that with one substitution in
    // each of the two places the colour is actually used. It is a faithful copy of
    // ScreenshotsUtils.createCanvas — including the modulo arithmetic on the tile offsets,
    // which is load-bearing: a devicePixelRatio like 0.3 floors snapshotSize to 307 while
    // tiles start every 307.2 device pixels, and without the correction every fifth tile
    // lands a pixel out and leaves a visible seam.
    ScreenshotsUtils.createCanvas = async function (region, browser) {
        let color = null;
        try {
            color = backdropFor(browser);
        } catch (e) {
            console.error("[zen-easel] could not work out a capture backdrop:", e);
        }
        // No opinion — off, not a transparent tab, or no window to ask. Firefox's own
        // white is then exactly the right answer, and the original is left to give it.
        if (!color) return original.call(this, region, browser);

        try {
            return await drawOnto(this, region, browser, color);
        } catch (e) {
            // A colour Gecko will not parse, a tab that navigated mid-capture, a rect it
            // refused. None of these are worth failing a screenshot over, so the picture
            // is taken again the way Firefox would have taken it. Note the region has been
            // rounded and clamped by now; both operations are idempotent, so handing it to
            // the original a second time is safe.
            console.warn("[zen-easel] the capture backdrop was refused, " +
                "falling back to white:", e);
            return original.call(this, region, browser);
        }
    };

    return true;
}

/* -------------------------------------------------------------------- the copy */

// ScreenshotsUtils.createCanvas, with `color` wherever it hardcodes rgb(255,255,255).
// `utils` is the ScreenshotsUtils object the call came in on, so the helpers it reaches for
// are its own rather than a copy of them.
async function drawOnto(utils, region, browser, color) {
    region.left = Math.round(region.left);
    region.right = Math.round(region.right);
    region.top = Math.round(region.top);
    region.bottom = Math.round(region.bottom);
    region.width = Math.round(region.right - region.left);
    region.height = Math.round(region.bottom - region.top);

    // Zen's own clamp, and it also raises the "too large" alert, so it stays on the object.
    utils.cropScreenshotRectIfNeeded(region);

    const { devicePixelRatio } = region;
    const browsingContext = BrowsingContext.get(browser.browsingContext.id);

    const canvas = new OffscreenCanvas(
        region.width * devicePixelRatio,
        region.height * devicePixelRatio
    );
    const context = canvas.getContext("2d");

    // The first of the two substitutions. This fill covers the device-pixel rows rounding
    // leaves the renderer short of; white here is what put a pale edge on a dark capture.
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const snapshotSize = Math.floor(MAX_SNAPSHOT_DIMENSION * devicePixelRatio);

    for (let startLeft = region.left; startLeft < region.right;
        startLeft += MAX_SNAPSHOT_DIMENSION) {
        for (let startTop = region.top; startTop < region.bottom;
            startTop += MAX_SNAPSHOT_DIMENSION) {

            const height = startTop + MAX_SNAPSHOT_DIMENSION > region.bottom
                ? region.bottom - startTop : MAX_SNAPSHOT_DIMENSION;
            const width = startLeft + MAX_SNAPSHOT_DIMENSION > region.right
                ? region.right - startLeft : MAX_SNAPSHOT_DIMENSION;

            // The second substitution: what shows through wherever the page itself paints
            // nothing, which on a transparent Zen tab is most of it.
            const snapshot = await browsingContext.currentWindowGlobal.drawSnapshot(
                new DOMRect(startLeft, startTop, width, height),
                devicePixelRatio,
                color
            );

            const left = Math.floor((startLeft - region.left) * devicePixelRatio);
            const top = Math.floor((startTop - region.top) * devicePixelRatio);
            context.drawImage(
                snapshot,
                left - (left % snapshotSize),
                top - (top % snapshotSize),
                Math.floor(width * devicePixelRatio),
                Math.floor(height * devicePixelRatio)
            );

            snapshot.close();
        }
    }

    return canvas;
}

/* ---------------------------------------------------------------- the colour */

// Asked of the window that owns the tab, at the moment of capture, and never held on to.
// A window whose Zen Easel host has not loaded — or has been torn down — simply has no
// opinion, and the capture falls through to Firefox's white.
function backdropFor(browser) {
    const backdrop = hostWindowFor(browser);
    if (!backdrop) return null;

    const color = backdrop.resolve(browser);
    return typeof color === "string" && color ? color : null;
}

// Finds the gZenEaselCaptureBackdrop published by the window that owns this browser.
//
// This used to be `browser.ownerGlobal` and nothing else, and was widened when Copy,
// Download and both Save buttons were compositing onto white while Zen Easel's own captures
// were fine. Worth being straight about the evidence: that symptom is fully explained by the
// stale-module early return removed from installScreenshotBackdrop above — an older revision
// owned createCanvas for the session and this file never ran. Zen Easel's own path was
// unaffected for the same reason it looks unaffected here: it reads the object straight out
// of its window script's closure and never goes through this lookup at all.
//
// `ownerGlobal` was never shown to fail. It is defined as `ownerDocument.defaultView`, and
// for a <browser> in the chrome document that is the browser window. Attempts to measure it
// otherwise were reading the Browser Console, which cannot see the property at all and
// reports null for every node including document.documentElement.
//
// So the extra candidates below are unverified belt-and-braces, not a fix for anything
// diagnosed. Each is checked for the object itself rather than for being a plausible window,
// which is the right shape if a lookup ever does land somewhere hostless — but if this ever
// needs touching again, delete rather than extend.
function hostWindowFor(browser) {
    const candidates = [];

    try { candidates.push(browser.ownerGlobal); } catch (e) { }
    // What the mod's own actors use to get from a browsing context back to chrome, and what
    // holds up in the cases ownerGlobal does not. There is no third route worth trying:
    // ownerDocument.defaultView is what ownerGlobal already is.
    try { candidates.push(browser.browsingContext?.topChromeWindow); } catch (e) { }

    for (const win of candidates) {
        const backdrop = win && win.gZenEaselCaptureBackdrop;
        if (backdrop && typeof backdrop.resolve === "function") return backdrop;
    }

    // Last resort: any open browser window that has a host. The colour is read from Zen's
    // own theme variables, which are the same in every window of a profile, so borrowing
    // another window's answer is very nearly always the same answer — and a backdrop from
    // the wrong window still beats the white this exists to replace. The exception is a
    // private or unsynced window, whose --zen-main-browser-background is its own; a capture
    // there that fell this far would take the ordinary window's colour instead.
    //
    // Only reached when both direct routes have failed, and nothing is known to reach this
    // far — see the note above. It is the floor, not a route with a case behind it.
    try {
        for (const win of Services.wm.getEnumerator("navigator:browser")) {
            const backdrop = win.gZenEaselCaptureBackdrop;
            if (backdrop && typeof backdrop.resolve === "function") return backdrop;
        }
    } catch (e) { }

    return null;
}
