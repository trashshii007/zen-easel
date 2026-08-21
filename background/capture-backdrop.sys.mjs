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
// It puts the colour that was actually behind the page into the picture, by changing the
// one argument that decides it. The page is never touched: no stylesheet is injected, no
// extension is disabled, nothing in the content process is asked to do anything. If this
// file does nothing at all, the result is exactly today's white — that is the failure
// mode, by construction.
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

// The exact literal Firefox's createCanvas passes for the snapshot background. Matched on
// rather than replaced blindly, so that if a future Gecko starts passing a deliberate
// colour of its own — a print preview, a dark-mode canvas — that colour is left alone and
// only the "no opinion, use white" case is answered.
const FIREFOX_WHITE = "rgb(255,255,255)";

// Which window globals have a capture in flight, and what colour each one wants. Keyed by
// the window global rather than held in a single slot, so two windows screenshotting at
// the same moment each get their own answer instead of the later one taking the earlier
// one's backdrop away. Weak because a tab can navigate or close mid-capture, and a stray
// entry must not be what keeps a dead window global alive.
const active = new WeakMap();

// The gated prototype patch below is installed at most once and then left in place. See
// shimPrototype for why it is not put up and taken down per capture.
let prototypePatched = false;

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

    if (ScreenshotsUtils._zenEaselBackdrop) return true;

    const original = ScreenshotsUtils.createCanvas;
    ScreenshotsUtils._zenEaselBackdrop = true;

    // createCanvas is the single funnel for all four of Zen's screenshot outputs — save
    // visible page, save full page, copy region, download region — and every internal
    // caller reaches it as `this.createCanvas`, so replacing the property covers all of
    // them. Deliberately not async: the original returns a promise and so must this, but
    // wrapping the body in an async function would also swallow the synchronous throw
    // path into a rejection and change how a caller that never expected one behaves.
    //
    // Known gap: createCanvas also fills its OffscreenCanvas with rgb(255,255,255) before
    // it draws, to cover the device-pixel rows that rounding leaves the renderer short of.
    // That fill is inside the original and cannot be reached from out here, so on a
    // fractional devicePixelRatio a dark backdrop can still leave a white hairline at the
    // right or bottom edge. Substituting the drawSnapshot colour is the whole of what this
    // can do without reimplementing the function.
    ScreenshotsUtils.createCanvas = function (region, browser) {
        let color = null;
        try {
            color = backdropFor(browser);
        } catch (e) {
            console.error("[zen-easel] could not work out a capture backdrop:", e);
        }
        if (!color) return original.call(this, region, browser);

        // The same expression createCanvas itself uses, so the shim lands on the object
        // it will actually call. Resolved once here rather than per tile: a full-page
        // capture loops over drawSnapshot, and re-reading it would only matter if the tab
        // navigated mid-capture, in which case losing the backdrop is the right answer.
        let windowGlobal = null;
        try {
            windowGlobal = BrowsingContext.get(browser.browsingContext.id)?.currentWindowGlobal;
        } catch (e) { }
        if (!windowGlobal) return original.call(this, region, browser);

        // A window global that died between being fetched and being shimmed throws on
        // property access. Nothing about a backdrop is worth failing a screenshot over,
        // so this path gives up and lets Firefox take its usual picture.
        let release;
        try {
            release = holdBackdrop(windowGlobal, color);
        } catch (e) {
            console.warn("[zen-easel] could not install the capture backdrop:", e);
            return original.call(this, region, browser);
        }

        let result;
        try {
            result = original.call(this, region, browser);
        } catch (e) {
            release();
            throw e;
        }
        return Promise.resolve(result).finally(release);
    };

    return true;
}

/* ---------------------------------------------------------------- the colour */

// Asked of the window that owns the tab, at the moment of capture, and never held on to.
// A window whose Zen Easel host has not loaded — or has been torn down — simply has no
// opinion, and the capture falls through to Firefox's white.
function backdropFor(browser) {
    const win = browser && browser.ownerGlobal;
    const backdrop = win && win.gZenEaselCaptureBackdrop;
    if (!backdrop || typeof backdrop.resolve !== "function") return null;

    const color = backdrop.resolve(browser);
    return typeof color === "string" && color ? color : null;
}

/* ------------------------------------------------------------------ the shim */

// Makes drawSnapshot answer with `color` instead of Firefox's white, for this window
// global, until the returned function is called.
function holdBackdrop(windowGlobal, color) {
    active.set(windowGlobal, color);
    installShim(windowGlobal);
    return () => active.delete(windowGlobal);
}

// The shim itself is installed once and then left alone — it is not what decides anything.
// With no entry in `active` for the window global it is called on, it hands straight
// through to the real method, so leaving it in place costs one WeakMap lookup per snapshot
// and removes every way that a capture ending could disturb one still running.
function installShim(windowGlobal) {
    if (windowGlobal.drawSnapshot && windowGlobal.drawSnapshot._zenEaselBackdrop) return;

    const proto = Object.getPrototypeOf(windowGlobal);
    const real = proto && proto.drawSnapshot;
    if (typeof real !== "function") return;

    // First choice: an own property on this one WindowGlobalParent, shadowing the
    // prototype method. Nothing outside this single tab's window global can see it, and it
    // dies with the window global — on navigation, or when the tab closes.
    const shim = function (rect, scale, background, ...rest) {
        return draw(real, this, rect, scale, background, active.get(this), rest);
    };
    shim._zenEaselBackdrop = true;

    try {
        Object.defineProperty(windowGlobal, "drawSnapshot", {
            value: shim,
            configurable: true,
            writable: true
        });
    } catch (e) { }

    if (Object.prototype.hasOwnProperty.call(windowGlobal, "drawSnapshot")) return;

    // Fallback, if a future Gecko ever seals its reflectors: patch the prototype instead.
    shimPrototype(proto, real);
}

// Installed at most once per process and then left alone, rather than put up and taken down
// around each capture. Two windows can be screenshotting at the same moment, and
// install/restore pairs that interleave leave one window's patch layered permanently under
// the other's. Left in place, it is a single WeakMap lookup on the way past for everything
// else in the browser that draws a snapshot — tab thumbnails, print preview, other add-ons
// — because nothing is in `active` unless a Zen Easel-backed capture is actually in flight.
function shimPrototype(proto, real) {
    if (prototypePatched) return;
    prototypePatched = true;

    console.warn("[zen-easel] this window global would not take an own drawSnapshot, " +
        "so the capture backdrop is falling back to a gated prototype hook");

    const shim = function (rect, scale, background, ...rest) {
        return draw(real, this, rect, scale, background, active.get(this), rest);
    };
    // Marked like the own-property shim so installShim recognises it and stops
    // re-deriving a wrapper on every capture once this path has been taken.
    shim._zenEaselBackdrop = true;
    proto.drawSnapshot = shim;
}

// One body, two installation sites. Substitutes the colour, and falls back to whatever the
// caller asked for if the substitution is refused — so the worst case is a white screenshot
// rather than a screenshot that failed.
//
// `background !== FIREFOX_WHITE` is the other half of the gate: only the "no opinion, use
// white" case is answered, so a snapshot taken during our capture by something with a
// deliberate colour of its own is left exactly as it was.
function draw(real, self, rect, scale, background, color, rest) {
    if (!color || background !== FIREFOX_WHITE) {
        return real.call(self, rect, scale, background, ...rest);
    }

    const fallBack = e => {
        console.warn("[zen-easel] the capture backdrop colour was refused, " +
            "falling back to white:", e);
        return real.call(self, rect, scale, background, ...rest);
    };

    let attempt;
    try {
        attempt = real.call(self, rect, scale, color, ...rest);
    } catch (e) {
        return fallBack(e);
    }
    return Promise.resolve(attempt).catch(fallBack);
}
