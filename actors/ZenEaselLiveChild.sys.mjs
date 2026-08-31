// Zen Easel — the content half of a live web card.
//
// Runs inside the live tile's own content process, and only there: the actor is
// registered with messageManagerGroups ["zen-easel-live"], which matches the
// messagemanagergroup attribute that live-layer.uc.js puts on the <browser> elements it
// creates. It is therefore never instantiated for an ordinary tab.
//
// This implements the three behaviours Arc injects into a live card, plus the scroll
// re-pin that a captured crop needs in order to stay pointed at what was captured:
//
//   1. scroll lock      — the card is a fixed view of one region, not a scrollable frame
//   2. selection lock   — a card is a picture you can click, not text you can drag-select
//   3. link interception — following a link inside a 300px tile is never what you meant
//
// All input listeners are registered in the system event group, so a page calling
// stopPropagation() in the default group cannot get underneath them.

export class ZenEaselLiveChild extends JSWindowActorChild {
    #offset = null;
    #repinning = false;
    #settleObserver = null;
    #settleTimer = null;
    #settleDeadline = 0;
    #settleHits = 0;
    // A webBrowser object is a window onto a site rather than a pinned crop of one, so it
    // opts out of the two locks that exist to protect a crop. Link interception and the
    // context-menu hand-back stay on for both: neither has anything to do with the crop.
    #scrollLocked = true;
    #selectionLocked = true;
    // The scrollbar gutter the page had when it was captured, in CSS pixels. Zero means
    // there was none to reproduce. See #hideScrollbars.
    #gutter = 0;
    // Whether the offset is a contract or a starting position. A pinned crop holds its
    // offset for as long as it lives; a web tile is merely reopened where it was left and
    // must be free to scroll away the moment the settle watch is done with it. Without this
    // distinction an offset on a web tile silently became a scroll lock, because the scroll
    // handler below re-pins on nothing but #offset being set.
    #repin = true;
    // Agent sheets already loaded into the current document, by URI, and the document they
    // belong to.
    //
    // #configure runs on every Ready, and Ready is sent on every DOMContentLoaded and every
    // pageshow — so a tile on a site that navigates, or that fires pageshow off the bfcache,
    // used to re-add the same three or four sheets each time, with nothing ever calling
    // removeSheetUsingURIString to take them back out.
    #sheets = new Set();
    #sheetDoc = null;

    // Keys that scroll. The card's whole premise is that its viewport does not move.
    static #SCROLL_KEYS = new Set([
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "PageUp", "PageDown", "Home", "End", "Space"
    ]);

    // How long to keep re-asserting the captured offset while the page settles, and how
    // many consecutive checks must find it already in place before we stop.
    //
    // The budget used to be a fixed ladder at 250/750/1500/3000ms. That is long enough
    // for a server-rendered page and nowhere near long enough for an article that lazy-
    // loads its images: scrollTo clamps to the document height *at the moment it runs*,
    // so a tile pinned before the page finished growing sat short of its target forever
    // — and no scroll event ever fired to say so, because nothing had moved. That is
    // the whole of "sometimes it captures the right part of the page".
    static #SETTLE_BUDGET_MS = 20000;
    static #SETTLE_CONFIRMATIONS = 3;

    receiveMessage(message) {
        switch (message.name) {
            case "ZenEaselLive:Configure":
                this.#configure(message.data);
                break;
            case "ZenEaselLive:Measure":
                return this.#measure();
        }
        return null;
    }

    #configure(data) {
        this.#offset = data.offset || null;
        this.#scrollLocked = data.lockScroll !== false;
        this.#selectionLocked = data.lockSelection !== false;
        this.#gutter = data.gutter > 0 ? data.gutter : 0;
        this.#repin = this.#scrollLocked;

        // Every sheet comes off before any goes back on. A configure is now also how a tile
        // is *unlocked* — for the repositioning gesture, and so a login form can be reached
        // at all — and the locks are only half enforced by the flags above. The other half
        // is agent sheets, which outrank page CSS and which nothing used to take back out:
        // flipping #selectionLocked while `*{user-select:none!important}` stayed loaded
        // would leave the tile exactly as unusable as before.
        this.#unloadSheets();

        this.#applyStyleFixes(data.cssPatches);
        this.#pinStyles();
        if (this.#selectionLocked) this.#lockSelection();
        if (this.#scrollLocked) this.#hideScrollbars();
        this.#restoreOffset();
        this.#watchUntilSettled();
    }

    // What the parent needs to re-baseline this tile: where the page actually sits, and the
    // layout box it got. Two readers — the refresh button commits `scroll`, and the width
    // correction is the difference between `clientW` and the box the capture was taken in.
    //
    // Deliberately on this actor rather than widening ZenEaselCapture's messageManagerGroups
    // to reach tiles: this one is already in every tile and already owns the offset.
    //
    // Nothing here is content data, and nothing is reported that nobody reads: reading
    // clientWidth flushes layout, so this is not free, and it is also the ordering barrier a
    // Configure pushed just before it is waited on with.
    #measure() {
        const win = this.contentWindow;
        if (!win) return null;

        const root = this.document && this.document.documentElement;
        const clientW = (root && root.clientWidth) || 0;
        const clientH = (root && root.clientHeight) || 0;
        // A document with no box has not laid out yet, and its scroll position means
        // nothing. Height is checked and not reported for exactly that reason.
        if (!(clientW > 0) || !(clientH > 0)) return null;

        return {
            scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
            clientW
        };
    }

    handleEvent(event) {
        switch (event.type) {
            case "DOMContentLoaded":
            case "pageshow":
                if (this.#selectionLocked) this.#lockSelection();
                this.#restoreOffset();
                // A navigation inside the tile — or a process switch, which brings a
                // brand new actor with no configuration at all — is announced rather
                // than waited for. The parent answers with this tile's config, so the
                // crop survives both. It replaces a retry loop on the parent side that
                // polled for this actor's existence and then sent the config exactly
                // once, which a later process switch silently discarded.
                this.sendAsyncMessage("ZenEaselLive:Ready", {});
                break;

            case "load":
                // The last moment the document's height can change for reasons that
                // have nothing to do with script. Worth one more assertion.
                this.#restoreOffset();
                break;

            case "wheel":
            case "touchmove":
                if (this.#scrollLocked) {
                    event.preventDefault();
                    break;
                }
                // An unpinned tile restoring a remembered position keeps asserting it for
                // up to twenty seconds, so that a page still loading its images cannot
                // leave the scroll short of where it was clamped. A deliberate scroll ends
                // that immediately — otherwise the restore spends the rest of its budget
                // dragging the user back to a position they have just left.
                this.#abandonOffset();
                break;

            case "mousedown":
                // Middle button, which is Gecko about to start an autoscroll — the same
                // "the user is taking over" signal the wheel above is, arriving as the only
                // event autoscroll ever produces. Everything after this is scrollBy from the
                // content process, indistinguishable from a page moving itself, so if the
                // remembered position is not given up here the settle watch spends the rest
                // of its twenty seconds dragging the page back under the puck.
                //
                // Deliberately not prevented and deliberately not gated on the scroll lock: a
                // locked crop refuses autoscroll at the browser element instead, and has no
                // offset to abandon in any case.
                if (event.button === 1) this.#abandonOffset();
                break;

            case "keydown":
                // Escape hands the pointer back to the board. The manual has always said it
                // does, and the easel implements it — but only page-side, and once a tile is
                // activated the page does not have focus, so the key never reached it. This
                // is the missing half. Deliberately not preventDefault'd: stepping out of the
                // card is the easel's business, and whether Escape also closes the site's own
                // dialog is the site's.
                if (event.key === "Escape") {
                    this.sendAsyncMessage("ZenEaselLive:Release", {});
                    break;
                }
                if (this.#scrollLocked && ZenEaselLiveChild.#SCROLL_KEYS.has(event.key)) {
                    event.preventDefault();
                }
                break;

            case "selectstart":
                if (this.#selectionLocked) event.preventDefault();
                break;

            case "scroll":
                if (this.#repin) this.#restoreOffset();
                break;

            case "click":
            case "auxclick":
                this.#interceptLink(event);
                break;

            case "submit":
                // A form submission would navigate the tile away from what was captured —
                // but a webBrowser tile has nothing to be navigated away *from*, and
                // submitting a search box is the main thing anyone does with one. Gated on
                // the same flag as the scroll lock, which is what distinguishes "pinned to
                // a crop" from "a window onto a site".
                if (this.#scrollLocked) event.preventDefault();
                break;

            case "contextmenu":
                // The card belongs to the easel even though the pixels belong to a
                // website. Without this, right-clicking a live card gets the site's menu
                // and there is no way back to "Show screenshot instead".
                //
                // Screen coordinates are passed rather than client ones so the easel can
                // convert with mozInnerScreenX/Y and needs to know nothing about the
                // tile's scale or crop offset.
                event.preventDefault();
                event.stopPropagation();
                this.sendAsyncMessage("ZenEaselLive:ContextMenu", {
                    screenX: event.screenX,
                    screenY: event.screenY
                });
                break;
        }
    }

    // Blocking the scroll *inputs* is not enough on its own. Fragment navigation, a lazy
    // loader calling scrollIntoView, and focus moving to an offscreen control all move
    // the viewport with no user gesture — and any of them silently destroys the crop.
    #restoreOffset() {
        if (!this.#offset || this.#repinning) return;
        const win = this.contentWindow;
        if (!win) return;
        if (Math.abs(win.scrollX - this.#offset.x) < 1 && Math.abs(win.scrollY - this.#offset.y) < 1) return;

        // Guarded, because scrollTo re-enters this handler through the scroll event.
        this.#repinning = true;
        try {
            win.scrollTo(this.#offset.x, this.#offset.y);
        } finally {
            this.#repinning = false;
        }
    }

    // A pinned card is a fixed view of one region, so a scrollbar down its edge is both
    // wrong and an invitation. Only the bars are hidden — deliberately not
    // `overflow: hidden`, which would also stop us restoring a capture taken part-way down
    // a page, since there would no longer be anything to scroll.
    //
    // With a gutter to reproduce, the bar is made invisible rather than removed. Taking the
    // gutter away changes documentElement.clientWidth, which is the box the whole capture is
    // laid out against — so a tile that simply hid the scrollbar was laying the page out
    // against a viewport the capture never had. scrollbar-gutter keeps the space whether or
    // not the document overflows, so the box does not move when a lazy loader makes the page
    // taller; the transparent colour is what keeps it out of the picture.
    #hideScrollbars() {
        if (this.#gutter > 0) {
            this.#loadAgentSheet(
                "html{scrollbar-gutter:stable!important;" +
                "scrollbar-color:transparent transparent!important}"
            );
            return;
        }
        this.#loadAgentSheet(
            "html{scrollbar-width:none!important}" +
            "::-webkit-scrollbar{width:0!important;height:0!important}"
        );
    }

    // The scroll handler catches a page that scrolls itself. It does not catch a page
    // that *grows* underneath a scroll position it has never moved — and that is the
    // case that matters, because scrollTo clamps to the document height at the instant
    // it runs. Pin a card to y=4000 while the document is still 2000 tall and it lands
    // at the bottom; the page then finishes loading its images and grows to 6000, no
    // scroll event fires because nothing moved, and the card shows the wrong thing for
    // as long as it is open.
    //
    // So the trigger is the document's own size, watched directly, rather than a guess
    // at how long settling takes. The loop ends when the offset has been observed in
    // place several times running, or when the budget runs out — a page that is still
    // reflowing after twenty seconds is not going to converge.
    #watchUntilSettled() {
        this.#stopSettleWatch();
        const win = this.contentWindow;
        const root = this.document && this.document.documentElement;
        if (!win || !root || !this.#offset) return;

        this.#settleDeadline = Date.now() + ZenEaselLiveChild.#SETTLE_BUDGET_MS;
        this.#settleHits = 0;

        const check = () => {
            // #offset can be cleared by a later Configure — a card turned back into a
            // web tile, say — and this closure outlives that.
            if (!this.contentWindow || !this.#offset) return this.#stopSettleWatch();

            const before = this.contentWindow.scrollY;
            this.#restoreOffset();
            const settled = Math.abs(this.contentWindow.scrollY - this.#offset.y) < 1 &&
                Math.abs(before - this.#offset.y) < 1;

            this.#settleHits = settled ? this.#settleHits + 1 : 0;
            if (this.#settleHits >= ZenEaselLiveChild.#SETTLE_CONFIRMATIONS ||
                Date.now() > this.#settleDeadline) {
                this.#stopSettleWatch();
                // A web tile's offset was a starting position, and it has now started.
                // Dropped rather than kept, so nothing re-pins a tile the user is free to
                // scroll — the settle watch is the whole of the guarantee it gets.
                if (!this.#repin) this.#offset = null;
            }
        };

        try {
            // ResizeObserver on documentElement fires whenever the page's box changes,
            // which is exactly when a clamped scroll position becomes reachable.
            this.#settleObserver = new win.ResizeObserver(check);
            this.#settleObserver.observe(root);
        } catch (e) {
            this.#settleObserver = null;
        }

        // A poll alongside it, because content can grow without documentElement's own
        // box changing — an inner section expanding inside an already-tall page. Slow
        // enough to be free: #restoreOffset returns immediately when nothing is needed.
        //
        // The budget is enforced from inside check() rather than by a second timer.
        // A standalone stop-timer would still be pending when a navigation started a
        // fresh watch, and would then tear that one down early — the deadline belongs
        // to the watch, so it is read by the watch.
        this.#settleTimer = win.setInterval(check, 400);
    }

    // Gives up on restoring a remembered position, for a tile that was only ever being
    // *placed* there rather than pinned to it. A pinned crop is untouched: its offset is
    // the whole contract, and a wheel event over one is prevented before it gets here.
    #abandonOffset() {
        if (this.#repin || !this.#offset) return;
        this.#offset = null;
        this.#stopSettleWatch();
    }

    #stopSettleWatch() {
        if (this.#settleObserver) {
            try { this.#settleObserver.disconnect(); } catch (e) { }
            this.#settleObserver = null;
        }
        if (this.#settleTimer) {
            try { this.contentWindow?.clearInterval(this.#settleTimer); } catch (e) { }
            this.#settleTimer = null;
        }
    }

    // Three things Gecko does by default that a pinned crop cannot tolerate.
    //
    // Scroll anchoring is the subtle one: when content loads *above* the viewport the
    // engine helpfully scrolls to keep what you were looking at in place — which on a
    // card means silently walking away from the offset we just restored, once per lazy
    // image. Smooth scrolling makes scrollTo asynchronous, so the settle loop would be
    // measuring a position that had not arrived yet. And scrollRestoration would put
    // the session's remembered position back over ours after a navigation.
    // Gated on there being an offset to protect, not on the scroll lock.
    //
    // These exist to stop the engine undoing a restore, and an unpinned tile being placed
    // back where it was left is doing exactly as much restoring as a pinned crop — it just
    // stops afterwards. Gated on the lock, a web tile reopening at a remembered position
    // got none of them: scroll anchoring walked it off the position once per lazy image,
    // smooth scrolling made the settle loop measure a scroll that had not arrived, and
    // scrollRestoration put the session's own idea of the position back over ours.
    //
    // Unwound as well as applied, which matters because a configure is now also how a tile
    // is unlocked. The agent sheet comes off with every other in #unloadSheets; the history
    // flag is not a sheet, so it is put back by hand — a tile with no offset left to protect
    // has no business suppressing the session's own restore for the rest of its life.
    #pinStyles() {
        if (!this.#offset) {
            try {
                this.contentWindow.history.scrollRestoration = "auto";
            } catch (e) { }
            return;
        }
        // Scoped to the document scroller rather than to `*`. Only the viewport we
        // actually restore can undo our work, and a universal selector in an agent
        // sheet is a style cost on every element of every page a card is opened on.
        this.#loadAgentSheet(
            "html,body{overflow-anchor:none!important;scroll-behavior:auto!important}"
        );
        try {
            this.contentWindow.history.scrollRestoration = "manual";
        } catch (e) {
            // Not fatal: the settle loop corrects for it, just a beat later.
        }
    }

    didDestroy() {
        this.#stopSettleWatch();
    }

    // An agent sheet outranks page CSS and needs no !important arms race, so the caret
    // and highlight never appear even on a site that sets user-select itself. The
    // selectstart handler covers the interaction; this covers the appearance.
    #lockSelection() {
        this.#loadAgentSheet("*{user-select:none!important;-moz-user-select:none!important}");
    }

    // Arc ships per-site CSS that collapses sticky headers, because a header that pins
    // itself to the viewport lands in the middle of a crop taken further down the page.
    // The patches are supplied by the parent rather than hardcoded here.
    #applyStyleFixes(patches) {
        if (!Array.isArray(patches) || !patches.length) return;
        for (const patch of patches) {
            if (typeof patch === "string") this.#loadAgentSheet(patch);
        }
    }

    #loadAgentSheet(css) {
        try {
            const utils = this.contentWindow?.windowUtils;
            if (!utils) return;

            // Scoped to the document these sheets were loaded into. A same-process
            // navigation keeps this actor but replaces the document, and the new one
            // genuinely does need the sheets again.
            const doc = this.document;
            if (this.#sheetDoc !== doc) {
                this.#sheetDoc = doc;
                this.#sheets.clear();
            }

            const uri = "data:text/css," + encodeURIComponent(css);
            if (this.#sheets.has(uri)) return;
            this.#sheets.add(uri);

            utils.loadSheetUsingURIString(uri, utils.AGENT_SHEET);
        } catch (e) {
            // A sheet that will not load costs appearance, not correctness.
        }
    }

    // The counterpart #loadAgentSheet never had. Without it the locks were one-way: the
    // flags could be turned off but the sheets enforcing them stayed on the document for as
    // long as it lived.
    //
    // Scoped to the document the sheets were loaded into. A navigation takes its own sheets
    // with it, and asking the new document to remove one it never had is not an error worth
    // reporting — but it is worth not leaving stale URIs in the set, or the dedupe in
    // #loadAgentSheet would refuse to re-add them to the document that does need them.
    #unloadSheets() {
        const doc = this.document;
        if (this.#sheetDoc === doc) {
            const utils = this.contentWindow?.windowUtils;
            if (utils) {
                for (const uri of this.#sheets) {
                    try {
                        utils.removeSheetUsingURIString(uri, utils.AGENT_SHEET);
                    } catch (e) { }
                }
            }
        }
        this.#sheets.clear();
        this.#sheetDoc = doc;
    }

    #interceptLink(event) {
        // Middle-click is auxclick with button 1; anything else on auxclick is not a
        // navigation and can be left alone.
        if (event.type === "auxclick" && event.button !== 1) return;

        const target = event.composedTarget || event.target;
        const anchor = target?.closest?.("a[href]");
        if (!anchor) return;

        event.preventDefault();
        event.stopPropagation();

        // href is resolved against the document, so this is an absolute URL — but it is
        // still content-controlled, and the parent re-validates the scheme before doing
        // anything with it.
        this.sendAsyncMessage("ZenEaselLive:OpenLink", {
            url: anchor.href,
            screenX: event.screenX,
            screenY: event.screenY
        });
    }
}
