// Zen Easel — the capture backdrop, window half.
//
// Works out what colour was actually behind the page, so a capture of a transparent page
// composites onto that instead of onto Firefox's white. See the header of
// background/capture-backdrop.sys.mjs for why a transparent page is the normal case in
// Zen and what goes wrong without this.
//
// Everything here is a read: computed styles off this window's own chrome, and two prefs.
// Nothing is written, nothing is injected into a page, and no extension is disabled. The
// only output is a CSS colour string, and returning null means "leave Firefox alone",
// which is what every failure path does.
//
// Two consumers, one answer:
//   * capture-host.uc.js passes it straight to drawSnapshot for Zen Easel's own captures.
//   * the background module above passes it to drawSnapshot inside Zen's native
//     screenshots, by way of window.gZenEaselCaptureBackdrop.
//
// Modes (zen.easel.capture-backdrop):
//   auto    the window's colour, but only on tabs Zen has actually made transparent
//   always  the window's colour, whatever the tab is
//   page    an opaque surface for the window's light/dark scheme, ignoring Zen's theme
//   custom  zen.easel.capture-backdrop-color, exactly as typed
//   off     Firefox's white, on both paths — the feature is a no-op

"use strict";

(function () {
    if (window.ZenEaselCaptureBackdrop) return;

    const HTML_NS = "http://www.w3.org/1999/xhtml";

    // Zen's own name for what is painted behind the content area. Defined on :root in
    // zen-theme.css, including the private-window and unsynced-window variants, so reading
    // it back gets whichever one is in force rather than a guess.
    const ZEN_BACKGROUND = "var(--zen-main-browser-background)";

    // The system colour for a page's default surface: white in a light scheme, near-black
    // in a dark one, resolved against this window's own colour-scheme.
    const SCHEME_SURFACE = "Canvas";

    // Deep enough to reach the window root from a <browser> several times over. A bound at
    // all only because this walks a live DOM from inside a capture.
    const MAX_WALK = 32;

    // What getComputedStyle hands back for a colour. Checked before the string is handed
    // to drawSnapshot — not because computed style is untrustworthy, but because the
    // custom pref goes through the same funnel and that one is typed by a person.
    const COMPUTED_COLOR = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/;

    class ZenEaselCaptureBackdrop {
        constructor() {
            this.log = window.ZenEaselUtil.log;
            this._installed = false;
            this._idle = null;
            this._probe = null;
        }

        // Hooks Zen's native screenshots. Deferred rather than done here because this runs
        // while the browser window is still coming up, and importing a module plus walking
        // its exports is work that has no business being on that path. Nothing is saved by
        // going further and deferring it to the first screenshot: BrowserGlue already
        // loads ScreenshotsUtils from its own startup idle list every session. The timeout
        // means a screenshot taken in the first few seconds of a cold start still gets a
        // backdrop.
        install() {
            if (this._idle !== null) return;
            this._idle = window.requestIdleCallback(() => {
                this._idle = null;
                try {
                    const { installScreenshotBackdrop } = ChromeUtils.importESModule(
                        "chrome://sine/content/zen-easel/background/capture-backdrop.sys.mjs");
                    this._installed = installScreenshotBackdrop();
                    this.log("native screenshot backdrop hooked:", this._installed);
                    // Not behind the debug pref. A hook that failed to go on means every
                    // native screenshot silently keeps compositing onto white, and the
                    // symptom — a blown-out capture — looks identical to the feature being
                    // switched off, so the one place the difference is visible has to be
                    // somewhere it will actually be seen.
                    if (!this._installed) {
                        console.warn("[zen-easel] Zen's own screenshots could not be hooked " +
                            "for the capture backdrop; Copy, Download and the Save buttons " +
                            "will keep compositing onto white");
                    }
                } catch (e) {
                    console.error("[zen-easel] could not hook Zen's screenshots for the " +
                        "capture backdrop:", e);
                }
            }, { timeout: 4000 });
        }

        destroy() {
            if (this._idle !== null) {
                window.cancelIdleCallback(this._idle);
                this._idle = null;
            }
            if (this._probe) {
                this._probe.remove();
                this._probe = null;
            }
            // The hook itself is left in place on purpose. It is process-global and shared
            // with every other open window, so taking it down because this window reloaded
            // would silently disable the feature everywhere else. It is inert anyway:
            // with no window offering a colour it passes Firefox's own white straight
            // through, and "off" below is what actually turns the feature off.
        }

        /* ------------------------------------------------------------- the answer */

        // A CSS colour string, or null for "leave Firefox alone".
        //
        // Called once per capture — twice for a full-page screenshot's first tile — so the
        // handful of style resolutions below are not on any hot path and are deliberately
        // not cached: a theme change, a workspace change or a move to a private window all
        // change the answer, and none of them are worth an observer to notice.
        resolve(browser) {
            try {
                const mode = window.ZenEaselUtil.prefs["capture-backdrop"];

                if (mode === "off") return null;

                if (mode === "custom") {
                    const typed = window.ZenEaselUtil.prefStr("zen.easel.capture-backdrop-color", "");
                    const custom = this._normalize(typed);
                    if (custom) return custom;
                    // Said out loud. The alternative is a setting that looks applied and
                    // quietly does nothing, or — worse — silently falls back to a colour
                    // that was not asked for.
                    console.warn("[zen-easel] zen.easel.capture-backdrop is \"custom\" but " +
                        `zen.easel.capture-backdrop-color is not a colour Gecko accepts ` +
                        `(${JSON.stringify(typed)}); captures will composite onto white`);
                    return null;
                }

                if (mode === "page") return this._schemeColor();

                // auto: only where the transparency is actually in play. Zen marks every
                // <browser> it allows to be transparent, and that attribute is exactly the
                // condition under which the window shows through a page. An opaque page in
                // such a tab paints over the backdrop completely, so this costs nothing
                // there — and in the default configuration the colour applied is the one
                // already showing through, so there is nothing to notice either way.
                if (mode === "auto" && !browser.hasAttribute("transparent")) return null;

                return this._windowColor(browser) || this._schemeColor();
            } catch (e) {
                console.error("[zen-easel] could not resolve a capture backdrop:", e);
                return null;
            }
        }

        /* -------------------------------------------------------------- the colour */

        // What Zen is painting behind the content area.
        _windowColor(browser) {
            const named = this._normalize(ZEN_BACKGROUND, { opaqueOnly: true });
            if (named) {
                this.log("capture backdrop from --zen-main-browser-background:", named);
                return named;
            }

            // Zen's variable was missing, or resolved to something that is not an opaque
            // colour — a gradient from a theme, or a translucent mica surface. Fall back
            // to asking the chrome what it paints, from the <browser> upwards, stopping at
            // the first thing that is opaque. Anything translucent on the way is skipped
            // rather than used, because a translucent layer means what is under it is
            // still part of what you were looking at.
            let el = browser.parentElement;
            for (let depth = 0; el && depth < MAX_WALK; depth++, el = el.parentElement) {
                // Zen paints the window background on pseudo-elements rather than on the
                // box itself — see .zen-browser-generic-background::after — so an element
                // that looks empty may well be the thing doing the painting.
                for (const pseudo of [null, "::after", "::before"]) {
                    let color;
                    try {
                        const style = window.getComputedStyle(el, pseudo);
                        // getComputedStyle answers for a pseudo-element whether or not one
                        // was ever generated, so a box that declares no `content` would
                        // otherwise hand back a background that is not on screen. And Zen
                        // cross-fades these two by opacity — ::before sits at
                        // calc(1 - --zen-background-opacity), so it is usually a perfectly
                        // opaque colour painted at 0 — which is a backdrop that was never
                        // visible. Both are skipped rather than trusted.
                        if (pseudo && style.content === "none") continue;
                        if (parseFloat(style.opacity) !== 1) continue;
                        color = style.backgroundColor;
                    } catch (e) {
                        continue;
                    }
                    if (this._isOpaque(color)) {
                        this.log("capture backdrop from", el.id || el.className || el.localName,
                            pseudo || "", color);
                        return color;
                    }
                }
            }

            return null;
        }

        // The honest last resort: an opaque page surface for whichever scheme this window
        // is in. Not a guess at Zen's theme — a deliberately plain answer, and the same
        // thing "page" mode returns on purpose for anyone whose window colour is a
        // gradient they would rather not have smeared behind every screenshot.
        _schemeColor() {
            // Null only if Gecko stopped resolving a system colour, which would mean
            // something far more broken than a screenshot.
            return this._normalize(SCHEME_SURFACE, { opaqueOnly: true });
        }

        /* ---------------------------------------------------------------- resolving */

        // Turns any CSS colour expression — a var(), a light-dark(), a color-mix(), a
        // system colour, or whatever a person typed into the pref — into the plain
        // rgb()/rgba() string drawSnapshot will accept, by asking this window's own style
        // system rather than parsing it here.
        //
        // Returns null for anything that does not resolve to a colour, which is what makes
        // this the validation step as well as the conversion step: a value Gecko refuses
        // leaves the declaration at its initial `transparent`, and transparent is rejected
        // below along with everything else that would not cover white.
        _normalize(value, { opaqueOnly = false } = {}) {
            if (!value || typeof value !== "string") return null;

            const probe = this._probeElement();
            if (!probe) return null;

            let computed = null;
            try {
                // Cleared first, so a value Gecko refuses leaves `transparent` behind
                // rather than whatever the previous call resolved to.
                probe.style.backgroundColor = "transparent";
                probe.style.backgroundColor = value;
                computed = window.getComputedStyle(probe).backgroundColor;
            } catch (e) {
                return null;
            }

            if (!computed || !COMPUTED_COLOR.test(computed)) return null;
            if (opaqueOnly && !this._isOpaque(computed)) return null;
            return computed;
        }

        // One hidden element, made once and kept, rather than one added and removed per
        // capture. It has to be in the tree for var() and light-dark() to resolve against
        // what this window is actually using — and putting a node into #main-window and
        // taking it out again on every screenshot is a DOM mutation that Zen's own
        // observers would see, for no reason. Out of flow, zero-sized and invisible, so it
        // takes part in no layout and is never painted.
        _probeElement() {
            const doc = window.document;
            const root = doc.documentElement;
            if (!root) return null;

            if (!this._probe) {
                this._probe = doc.createElementNS(HTML_NS, "div");
                this._probe.id = "zen-easel-colour-probe";
                this._probe.style.cssText =
                    "position:fixed;top:-9999px;left:-9999px;width:0;height:0;" +
                    "visibility:hidden;pointer-events:none;background-color:transparent;";
            }
            // Re-attached rather than assumed: a window reload, or anything else that
            // sweeps unknown children off the root, would otherwise leave this measuring
            // a detached node, which resolves nothing and inherits nothing.
            if (this._probe.parentNode !== root) root.appendChild(this._probe);

            return this._probe;
        }

        // A backdrop with any transparency in it is not a backdrop: the PNG comes out with
        // an alpha channel and looks blown out again the moment it is viewed on white,
        // which is the whole complaint. The one exception is `custom`, where a person has
        // said what they want and gets it.
        _isOpaque(color) {
            if (!color || !COMPUTED_COLOR.test(color)) return false;
            const alpha = color.slice(color.indexOf("(") + 1, -1).split(",")[3];
            return alpha === undefined || parseFloat(alpha) === 1;
        }
    }

    window.ZenEaselCaptureBackdrop = ZenEaselCaptureBackdrop;
})();
