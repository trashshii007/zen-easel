// Zen Easel — the "Easel" button on Zen's post-capture region bar.
//
// This file exists because that bar cannot be reached any other way. Zen builds it with
// document.insertAnonymousContent() from ScreenshotsOverlayChild, in the *content*
// process, so it is neither in the chrome document nor in any shadow root a chrome script
// can walk. The only way in is to be code running in that process — which is what a child
// actor is.
//
// KEEP THIS FILE SMALL, AND EXPECT TO RESTART ZEN TO CHANGE IT.
//
// Content-process ESMs are cached per process. After the first load, editing this file
// changes nothing until Zen is restarted — and unlike the mod's window scripts there is no
// "re-register over the stale copy" escape hatch, because the code that would do the
// replacing is itself the stale copy. Worse, what goes stale here is a patch installed on
// one of Firefox's own prototypes, which then serves every tab in the process for the rest
// of the session. So: anything that can be decided in the parent is decided in the parent.
// This file finds the bar, draws a button on it, and reports a click. Nothing else.
//
// The patch is install-once, restore-never. See the note above the ownership flag below.

const OVERLAY_MODULE =
    "moz-src:///browser/components/screenshots/ScreenshotsOverlayChild.sys.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const BUTTON_ID = "zen-easel-send";

// The mod's icon, inlined rather than referenced.
//
// The picture cannot come from a stylesheet the way Zen's own do. `#copy > img` points at a
// chrome:// URL, and neither half of that is available here: the mod's chrome package is not
// registered contentaccessible, so a content document cannot load chrome://sine at all, and a
// data: URI would lose -moz-context-properties, which Gecko honours for chrome:// and
// resource:// images only — leaving a glyph that could not follow the button's colour.
//
// So the drawing is inline markup: it loads nothing, and currentColor does here what
// context-fill does in resources/zen-easel-board.svg — inline SVG has no context to fill
// from. Keep the two in step by hand. Its *box* is still Zen's — see below.
function icon(doc, native) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 128 128");
    // Measured off the <img> this replaces, because `.screenshots-button > img` cannot match
    // an <svg> and a theme is free to change those numbers.
    const style = doc.defaultView.getComputedStyle(native);
    svg.setAttribute("width", parseFloat(style.width) || 16);
    svg.setAttribute("height", parseFloat(style.height) || 16);
    // Without this a click on the glyph reports the <svg> as event.originalTarget and Zen's
    // handleClick, which dispatches on originalTarget.id, attributes it to nothing.
    svg.style.pointerEvents = style.pointerEvents;
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "9");
    svg.setAttribute("stroke-linecap", "round");

    const scribble = doc.createElementNS(SVG_NS, "path");
    scribble.setAttribute("d", "M90.2992 23.2896C107.674 41.5313 103.743 47.03 94.4594 " +
        "43.3343C85.176 39.6387 71.6962 26.8147 62.3622 31.1417C53.0282 35.4688 108.075 " +
        "83.802 88.4082 87.2058C80.9549 88.4958 39.7619 39.3475 25.6266 43.3343C10.8767 " +
        "47.4946 60.7995 83.802 63.8251 106.872");

    svg.append(scribble);
    return svg;
}

// Draws the button into the bar, immediately before Copy.
//
// Called from a patched initializeElements, so the overlay's own element references are
// already resolved — copyButton included. Re-entrant by design: initializeElements runs
// once per overlay, and there is one overlay per document, but a document that navigates
// gets a fresh anonymous-content root and therefore a fresh bar.
function addButton(overlay) {
    const wrapper = overlay.buttonsContainer &&
        overlay.buttonsContainer.querySelector(".buttons-wrapper");
    if (!wrapper || wrapper.querySelector(`#${BUTTON_ID}`)) return;

    // Cloned from Copy rather than built to match it, so the class list, the element
    // namespace and the <img>/<label> pair overlay.css styles by child selector all come from
    // Zen's own markup — a theme that restyles Copy restyles this, with nothing to keep in
    // sync. The namespace matters on its own: createElement() in an XHTML document yields a
    // null-namespace <button>, which every `html|button` rule in common.css then skips.
    const copy = overlay.copyButton;
    if (!copy) {
        console.warn("[zen-easel] Zen's screenshot bar has no Copy button to match, so no " +
            "easel button was added to it");
        return;
    }

    const doc = overlay.document;
    const button = copy.cloneNode(true);
    button.id = BUTTON_ID;
    button.setAttribute("title", "Send to easel");
    button.setAttribute("aria-label", "Send to easel");
    button.querySelector("label").textContent = "Easel";

    wrapper.insertBefore(button, copy);

    // After insertion, so the <img> icon() measures is in the tree and has a computed style.
    const image = button.querySelector("img");
    button.replaceChild(icon(doc, image), image);
}

// Everything the parent needs to encode the capture and place the menu.
//
// Note what is *not* here: no viewport measurements. The parent asks the ZenEaselCapture
// actor for those through capture-host's measureViewport(), which is documented as the one
// place that measurement is made — a second copy here is precisely how one of the two
// capture paths silently stops being live-capable.
function pickPayload(overlay) {
    const win = overlay.window;

    // Region.dimensions carries only left/top/right/bottom/width/height. ScreenshotsUtils
    // reads devicePixelRatio off the region it is handed, and Zen's own child stamps it on
    // for exactly this reason; without it the capture canvas comes out zero-sized.
    const region = Object.assign({}, overlay.selectionRegion.dimensions);
    region.devicePixelRatio = win.devicePixelRatio;

    // The overlay normalises page coordinates by subtracting these (getCoordinatesFromEvent),
    // while a raw win.scrollY does not. They differ on RTL and negative-origin pages, so the
    // parent needs them to line the region up against the scroll offset it measures.
    const dims = overlay.windowDimensions.dimensions;

    const rect = overlay.getElementById(BUTTON_ID).getBoundingClientRect();

    return {
        region,
        scrollMinX: dims.scrollMinX || 0,
        scrollMinY: dims.scrollMinY || 0,
        // Screen position in this window's CSS pixels, plus the ratio needed to convert
        // them into the chrome window's. Page zoom is folded into devicePixelRatio, which
        // is why the parent cannot simply add CSS pixels of its own.
        anchor: {
            left: win.mozInnerScreenX + rect.left,
            top: win.mozInnerScreenY + rect.top,
            bottom: win.mozInnerScreenY + rect.bottom,
            devicePixelRatio: win.devicePixelRatio
        }
    };
}

// Patches ScreenshotsOverlay.prototype, once per content process.
//
// Install-once, restore-never, with the guard on the prototype rather than in this module.
// Never add an "unpatch" path: the flag lives on an object shared by every document in the
// process, so any teardown that restored the originals would silently disarm the button for
// every other tab — which is the shape of the bug this whole rewrite was meant to remove.
function ensurePatched() {
    const { ScreenshotsOverlay } = ChromeUtils.importESModule(OVERLAY_MODULE);
    const proto = ScreenshotsOverlay.prototype;
    if (proto._zenEaselPatched) return;
    proto._zenEaselPatched = true;

    const originalInit = proto.initializeElements;
    proto.initializeElements = function () {
        originalInit.apply(this, arguments);
        try {
            addButton(this);
        } catch (e) {
            // Zen's screenshot UI has to keep working even when ours does not.
            console.error("[zen-easel] could not add the easel button:", e);
        }
    };

    const originalClick = proto.handleClick;
    proto.handleClick = function (event) {
        try {
            // event.originalTarget resolving to the button rather than to the icon inside
            // it depends on a pointer-events rule in Zen's overlay.css. closest() makes
            // that irrelevant. The button check is limited to a plain left click so that
            // right- and middle-clicks still reach preEventHandler, which uses them to
            // back out of a drag.
            const target = event.originalTarget;
            const mine = target && event.button === 0 &&
                (target.id === BUTTON_ID ||
                    (target.closest && target.closest(`#${BUTTON_ID}`)));

            if (mine) {
                this.window.windowGlobalChild
                    .getActor("ZenEaselScreenshot")
                    .sendAsyncMessage("ZenEaselScreenshot:Pick", pickPayload(this));
                return;
            }
        } catch (e) {
            console.error("[zen-easel] the easel button could not report a click:", e);
            // Falls through to Zen's handler, which ignores an id it does not know.
        }
        return originalClick.apply(this, arguments);
    };
}

export class ZenEaselScreenshotChild extends JSWindowActorChild {
    receiveMessage(message) {
        switch (message.name) {
            // Sent from a patched ScreenshotsUtils.showPanelAndOverlay, immediately before
            // the message that builds the overlay. Both ride the same PWindowGlobal and are
            // delivered in order, so the patch is always in place before the first overlay
            // in this process is constructed.
            case "ZenEaselScreenshot:Prime":
                ensurePatched();
                return null;
            case "ZenEaselScreenshot:EndOverlay":
                return this.#endOverlay();
        }
        return null;
    }

    // Takes Zen's overlay down before the parent photographs the page.
    //
    // drawSnapshot paints anonymous content like anything else, so the selection border,
    // the corner handles and the size readout all end up *inside* the picture unless the
    // overlay is gone first. Zen's own Copy and Download avoid this by calling
    // endScreenshotsOverlay synchronously, immediately after queueing the capture message —
    // see requestCopyScreenshot in ScreenshotsComponentChild.
    //
    // This mod cannot do it at the same moment: the overlay has to stay up while the
    // send-to-easel menu is open, or the selection the user is choosing a destination for
    // would vanish out from under the menu. So it is torn down here instead, once a
    // destination has been picked, and the parent waits for this to return before capturing.
    // That round trip makes the ordering stronger than Zen's own, which merely relies on the
    // teardown running before the parent gets round to the snapshot.
    #endOverlay() {
        try {
            this.contentWindow.windowGlobalChild
                .getActor("ScreenshotsComponent")
                // doNotResetMethods matches what Zen passes on its own capture paths: the
                // screenshot is being completed, not abandoned, so the telemetry about how
                // the region was chosen still applies.
                .endScreenshotsOverlay({ doNotResetMethods: true });
        } catch (e) {
            // Reported rather than swallowed: carrying on from here means capturing the
            // overlay along with the page, which is a picture nobody wants but which does
            // still arrive, so the console is the only place the reason could show up.
            console.error("[zen-easel] could not take Zen's screenshot overlay down before " +
                "capturing, so its handles may appear in the image:", e);
        }
        return null;
    }
}
