// Zen Easel — split-divider drag fix.
//
// Nothing in this file is about easels, and it is meant to be removed. It is here because
// Sine is the only loader this profile has wired up; it lifts out into a mod of its own
// unchanged, and the setting that turns it off — Easel settings, "Split view" — exists so
// it can be switched off the day Zen fixes this upstream, without touching any files.
//
// THE FAULT
//
// Drag a split divider with an about: page in one of the panes and the divider jumps: it
// snaps hard to one side, then keeps tracking from there, no longer under the pointer. At
// speed the panes strobe instead, flicking between two layouts every frame, and a band at
// the edge of a pane shows the window's backdrop where the page has not caught up. None of
// it is an easel bug — about:preferences and about:config do it identically in a stock
// profile — and the two symptoms are the same fault.
//
// clientX and clientY are measured from the origin of the document the event came from. A
// splitter drag takes the pointer off Zen's chrome overlay and out over the panes, and a
// pane holding an about: page is an in-process <browser>: a subdocument of this window,
// whose mouse events retarget into this document still carrying *its* coordinates. The
// instant the pointer crosses that boundary, x drops by the pane's offset. Measured on a
// real drag: 978 while over the chrome, 85 one crossing later, for a pointer that had not
// moved left at all.
//
// Zen's splitter reads clientX straight off the event, so crossing into an about: pane
// hands it a large negative movement and its loop drives that pane down to
// minResizeWidth — the snap. Frames whose events came from either side of the boundary
// disagree about where the pointer is, so the layout alternates between two answers at
// frame rate — the strobe, and the unpainted band, which is a pane whose content cannot
// follow a box that keeps changing its mind. A pane in a content process never does this:
// those events do not retarget into this document at all, which is why splitting two web
// pages is clean and why any about: page is not.
//
// Zen's arithmetic is correct. It was being handed numbers that did not mean what it
// thought they meant.
//
// WHAT THIS DOES
//
// Mode "ghost", the default. The splitter's own mousedown is intercepted, so Zen's
// per-frame drag never starts; a line follows the pointer, and the geometry is applied once
// on release by replaying the gesture into Zen's handler — a mousedown where the drag
// began, a mousemove where it ended, a mouseup. Two things come out of that. The
// coordinates handed over are read from the screen rather than from whichever document the
// event came from, so they mean the same thing throughout; and there is exactly one
// relayout per gesture rather than sixty, so no frame exists in which a pane's content can
// be late for its box.
//
// The line is driven by a *captured* pointer, taken on the splitter at pointerdown. This
// is not a detail: the same retargeting rule that causes the fault also decides which
// events this file can see, and it cuts both ways. Move events over an in-process about:
// pane retarget into this document carrying the wrong coordinates — the bug — while move
// events over a pane in a content process are consumed there and do not arrive at all. A
// document-level listener therefore went blind the instant the drag crossed an ordinary
// web page, freezing the line at the edge of the pane while the gesture carried on. A
// capture routes the whole gesture to the splitter regardless of what it passes over, and
// delivers the release even when it lands outside the window.
//
// The replay is deliberate: Zen's geometry stays Zen's, including the parts this file would
// have got wrong — minimum pane sizes, nested splits, and how much of a movement each
// neighbour absorbs.
//
// Mode "freeze" pins each in-process pane to its pre-drag pixel size so it is never relaid
// out mid-gesture. It predates knowing what the fault was: it hides the band, does nothing
// about the snap, and is kept only because it is the one option that leaves the panes
// resizing live under the cursor.
//
// WHAT DID NOT WORK, AND WHY IT IS WORTH REMEMBERING
//
// Every earlier attempt treated this as a painting problem, because that is what it looks
// like: painting the easel's canvas synchronously inside its resize observer; forcing the
// subdocument's reflow to complete inside Zen's drag callback, where a script-initiated
// flush cannot be interrupted; pinning the pages so they never reflowed at all. Each helped
// visibly and none of them finished the job, which in hindsight is exactly what a fix aimed
// at the wrong layer looks like — the geometry underneath was oscillating the whole time,
// and no amount of painting it faithfully was going to settle it.

"use strict";

(function () {
    if (window.ZenEaselSplitResize) return;

    // Zen stamps this on #tabbrowser-tabpanels for exactly the duration of a splitter drag.
    const RESIZING_ATTR = "zen-split-resizing";

    // Ours, on the same element, for the stylesheet that clips a pinned page to its pane in
    // freeze mode. Separate from Zen's so that turning the setting off leaves nothing of
    // ours in the DOM or in the cascade.
    const FROZEN_ATTR = "zen-easel-split-frozen";

    // Zen's own "apply this layout without animating it". Held across the replay because
    // the inset transition would otherwise resize the pane over 90ms after the mouse came
    // up — which is a resize like any other, and would flicker exactly as one.
    const NO_TRANSITION_CLASS = "zen-split-view-no-transition";

    const SPLITTER_SELECTOR = ".zen-split-view-splitter";

    // How thick the ghost line is, and how far from the edge of the panel it may be
    // dragged. The clamp is approximate on purpose: Zen re-clamps on apply against the real
    // minimum, and this only decides where the line is allowed to be drawn.
    const GHOST_THICKNESS = 3;
    const GHOST_EDGE_FRACTION = 0.07;

    class ZenEaselSplitResize {
        constructor() {
            this.log = window.ZenEaselUtil.log;
            this._panel = null;
            this._observer = null;

            // browser -> the inline style text it had before it was pinned. Restoring the
            // exact string rather than clearing properties keeps this safe against a future
            // Zen that sets an inline width on these elements itself.
            this._pinned = new Map();

            this._drag = null;
            this._ghost = null;
            // True only while this file is dispatching the synthetic events of a replay, so
            // its own capturing listener lets them through to Zen instead of starting a
            // second ghost drag on top of the first.
            this._replaying = false;

            this._onPointerDown = this._onPointerDown.bind(this);
            this._onPointerMove = this._onPointerMove.bind(this);
            this._onPointerUp = this._onPointerUp.bind(this);
            this._onLostCapture = this._onLostCapture.bind(this);
            this._onMouseDown = this._onMouseDown.bind(this);
            this._onKeyDown = this._onKeyDown.bind(this);
        }

        install() {
            this._panel = gBrowser.tabpanels || document.getElementById("tabbrowser-tabpanels");
            if (!this._panel) return;

            // Two listeners for one gesture, and they do different jobs.
            //
            // pointerdown starts the drag, because it is the only one that can take a
            // pointer capture — and the capture is what makes the gesture work at all. The
            // ghost line used to be moved by a mousemove listener on this document, which
            // silently stopped receiving events the moment the pointer crossed a pane
            // running in a content process: those do not retarget here, which this file
            // says in its own header and then relied on anyway. Dragging a divider between
            // two ordinary web pages therefore froze the line where it entered the pane.
            // A capture routes every move to the splitter whatever is underneath, which
            // also disposes of the mouseup that lands outside the window and used to leave
            // the drag, the line and the resize cursor stuck.
            //
            // mousedown is still intercepted, and only to suppress it. Zen mounts its own
            // per-frame drag from a mousedown on the splitter, and stopping that event in
            // the capture phase before it reaches the target is what keeps that from
            // starting. pointerdown fires first, so by the time this runs the ghost drag is
            // already up and it only has to recognise its own gesture.
            document.addEventListener("pointerdown", this._onPointerDown, true);
            document.addEventListener("mousedown", this._onMouseDown, true);

            if (typeof MutationObserver === "function") {
                this._observer = new MutationObserver(() => this._syncFreeze());
                this._observer.observe(this._panel, {
                    attributes: true, attributeFilter: [RESIZING_ATTR]
                });
            }
            this._syncFreeze();
        }

        // Where the pointer is, in this window's coordinates, whatever document the event
        // came from.
        //
        // This is the whole bug. clientX/clientY are measured from the origin of the
        // document the event belongs to, and a drag takes the pointer off the chrome
        // overlay and over the panes. A pane holding an in-process about: page is a
        // subdocument of this window, and its mouse events arrive here measured from *its*
        // origin — so the instant the pointer crosses into it, x drops by the pane's offset
        // and stays wrong for the rest of the gesture. Measured on a real drag: 978 while
        // over the chrome, 85 one pane-crossing later, for a pointer that never moved left.
        //
        // Zen's own splitter drag reads clientX directly, which is why dragging *into* an
        // about: pane collapses it to the minimum — the movement it computes is hugely
        // negative — and why frames whose events came from either side of the boundary
        // disagree, which is the flicker. A pane in a content process does not do this: its
        // events do not retarget into this document at all.
        //
        // screenX/screenY are the same measurement wherever they came from, and
        // mozInnerScreenX/Y is where this window's own origin sits on the screen.
        _point(event) {
            return {
                x: event.screenX - window.mozInnerScreenX,
                y: event.screenY - window.mozInnerScreenY
            };
        }

        // "ghost" | "freeze" | "off". Read at the moment it is needed rather than cached,
        // so the setting takes effect on the next gesture with no reload.
        _mode() {
            const mode = window.ZenEaselUtil.prefs["split-resize"];
            return mode === "freeze" || mode === "off" ? mode : "ghost";
        }

        /* ---------------------------------------------------------------- ghost */

        // Starts the ghost drag and takes the pointer with it.
        //
        // The capture is the substance of this handler. Without it the move events are
        // delivered to whatever is under the pointer, and a pane running in a content
        // process consumes them entirely — so the line froze at the edge of the first web
        // page the drag crossed, while the gesture went on and ended somewhere the line
        // never reached. With it, every move for this pointer id is delivered to the
        // splitter until the gesture ends, whatever it passes over, and the release is
        // delivered even if it happens outside the window.
        _onPointerDown(event) {
            if (this._replaying || this._drag) return;
            if (event.button !== 0 || !event.isPrimary) return;
            if (this._mode() !== "ghost") return;

            const splitter = event.target?.closest?.(SPLITTER_SELECTOR);
            if (!splitter) return;

            const vertical = splitter.getAttribute("orient") === "vertical";
            const point = this._point(event);
            this._drag = {
                splitter, vertical, pointerId: event.pointerId, captured: false,
                startX: point.x, startY: point.y,
                x: point.x, y: point.y
            };

            // Listeners on the splitter, because that is where a captured pointer delivers.
            // The fallback keeps the old document-level behaviour for the case where the
            // capture is refused: worse over remote panes, which is still better than a
            // divider that does not move at all.
            try {
                splitter.setPointerCapture(event.pointerId);
                this._drag.captured = true;
            } catch (e) {
                this.log("could not capture the pointer for a split drag:", e.message);
            }
            const target = this._drag.captured ? splitter : document;
            target.addEventListener("pointermove", this._onPointerMove, true);
            target.addEventListener("pointerup", this._onPointerUp, true);
            target.addEventListener("pointercancel", this._onPointerUp, true);
            splitter.addEventListener("lostpointercapture", this._onLostCapture);
            document.addEventListener("keydown", this._onKeyDown, true);
            this._drag.target = target;

            try { window.setCursor(vertical ? "ew-resize" : "ns-resize"); } catch (e) { }
            this._showGhost();
        }

        // Suppression only. Zen starts its per-frame drag from a mousedown on the splitter,
        // and stopping the event in the capture phase is what keeps that from running
        // alongside the ghost. pointerdown has already fired by now, so this recognises the
        // gesture by the drag it started rather than testing the conditions again.
        _onMouseDown(event) {
            if (this._replaying || !this._drag) return;
            if (!event.target?.closest?.(SPLITTER_SELECTOR)) return;
            event.stopPropagation();
            event.preventDefault();
        }

        _onPointerMove(event) {
            if (!this._drag || event.pointerId !== this._drag.pointerId) return;
            const point = this._point(event);
            this._drag.x = point.x;
            this._drag.y = point.y;
            this._showGhost();
        }

        _onPointerUp(event) {
            const drag = this._drag;
            if (!drag || event.pointerId !== drag.pointerId) return;
            this._endDrag();

            // A pointercancel is the gesture being taken away rather than finished — the
            // pane never moved and the user did not ask for it to, so it is dropped the
            // same way Escape is.
            if (event.type === "pointercancel") return;

            // A click on the divider that never moved is not a resize, and replaying it
            // would put a mousedown/mouseup pair through Zen's handler for nothing.
            const moved = drag.vertical ? drag.x - drag.startX : drag.y - drag.startY;
            if (!moved) return;

            this._replay(drag);
        }

        // The capture was taken away mid-gesture — another element claimed it, or the
        // element left the document. Whatever the reason, moves stop arriving from here on,
        // so the drag is ended rather than left running blind with a line that no longer
        // tracks. Not treated as a release: nothing is applied.
        _onLostCapture(event) {
            if (!this._drag || event.pointerId !== this._drag.pointerId) return;
            if (!this._drag.releasing) this._endDrag();
        }

        _onKeyDown(event) {
            if (event.key !== "Escape" || !this._drag) return;
            event.preventDefault();
            event.stopPropagation();
            // Cancelled: the panes never moved, so there is nothing to put back.
            this._endDrag();
        }

        _endDrag() {
            const drag = this._drag;
            if (!drag) return;
            // Read by _onLostCapture, which releasePointerCapture below is about to fire.
            // Without it the release would re-enter this on its way out.
            drag.releasing = true;
            this._drag = null;

            const target = drag.target || document;
            target.removeEventListener("pointermove", this._onPointerMove, true);
            target.removeEventListener("pointerup", this._onPointerUp, true);
            target.removeEventListener("pointercancel", this._onPointerUp, true);
            drag.splitter.removeEventListener("lostpointercapture", this._onLostCapture);
            document.removeEventListener("keydown", this._onKeyDown, true);
            if (drag.captured) {
                try { drag.splitter.releasePointerCapture(drag.pointerId); } catch (e) { }
            }

            try { window.setCursor("auto"); } catch (e) { }
            this._hideGhost();
        }

        // The whole gesture, handed to Zen as three events in one turn: down where it
        // started, move to where it ended, up. Zen's dragFunc does its work in a
        // requestAnimationFrame, so the layout lands on the next frame — once, from a
        // pointer position that is no longer moving.
        _replay(drag) {
            const splitter = drag.splitter;
            if (!splitter.isConnected) return;

            const at = (type, x, y, target) => {
                const event = new MouseEvent(type, {
                    bubbles: true, cancelable: true, view: window,
                    clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1
                });
                target.dispatchEvent(event);
            };

            // The coordinates handed over are the corrected ones, and the events are
            // dispatched at chrome elements, so what Zen measures against them is this
            // window's own frame of reference throughout. That is the second half of the
            // fix: Zen's arithmetic is right, and it is finally being given numbers that
            // mean what it thinks they mean.
            //
            // Zen re-enables its inset transition the moment its own mouseup handler
            // clears the resizing attribute — and an animated inset is a resize on every
            // frame of the animation, which is the fault all over again for 90ms. Held off
            // until the layout has been applied.
            this._panel?.classList.add(NO_TRANSITION_CLASS);

            this._replaying = true;
            try {
                at("mousedown", drag.startX, drag.startY, splitter);
                at("mousemove", drag.x, drag.y, document);
                at("mouseup", drag.x, drag.y, document);
            } catch (e) {
                this.log("could not replay a split drag:", e.message);
            } finally {
                this._replaying = false;
            }

            // Two frames: one for Zen's queued callback to write the geometry, one for it
            // to have been painted before transitions are allowed back.
            window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                    this._panel?.classList.remove(NO_TRANSITION_CLASS);
                });
            });
        }

        _showGhost() {
            const drag = this._drag;
            if (!drag || !this._panel) return;

            if (!this._ghost) {
                this._ghost = document.createElement("div");
                this._ghost.className = "zen-easel-split-ghost";
                (document.getElementById("browser") || document.documentElement)
                    .appendChild(this._ghost);
            }

            const rect = this._panel.getBoundingClientRect();
            const style = this._ghost.style;

            if (drag.vertical) {
                const margin = rect.width * GHOST_EDGE_FRACTION;
                const x = Math.min(Math.max(drag.x, rect.left + margin), rect.right - margin);
                style.left = `${x - GHOST_THICKNESS / 2}px`;
                style.top = `${rect.top}px`;
                style.width = `${GHOST_THICKNESS}px`;
                style.height = `${rect.height}px`;
            } else {
                const margin = rect.height * GHOST_EDGE_FRACTION;
                const y = Math.min(Math.max(drag.y, rect.top + margin), rect.bottom - margin);
                style.left = `${rect.left}px`;
                style.top = `${y - GHOST_THICKNESS / 2}px`;
                style.width = `${rect.width}px`;
                style.height = `${GHOST_THICKNESS}px`;
            }
        }

        _hideGhost() {
            if (!this._ghost) return;
            this._ghost.remove();
            this._ghost = null;
        }

        /* --------------------------------------------------------------- freeze */

        _syncFreeze() {
            const resizing = !!this._panel && this._panel.hasAttribute(RESIZING_ATTR);
            // The mode is read once, on the way in. A setting changed mid-drag must not
            // leave pages pinned with nothing left that would unpin them.
            if (resizing && this._mode() === "freeze") this._freeze();
            else this._thaw();
        }

        _freeze() {
            if (this._pinned.size) return;

            for (const browser of this._panes()) {
                try {
                    if (browser.isRemoteBrowser) continue;
                    const rect = browser.getBoundingClientRect();
                    if (!rect.width || !rect.height) continue;

                    this._pinned.set(browser, browser.getAttribute("style") || "");
                    // min and max as well as the size itself: the browser is a flex child
                    // of a container that is about to change size underneath it, and a
                    // width alone is a preference a flex line may override.
                    browser.style.setProperty("width", `${rect.width}px`, "important");
                    browser.style.setProperty("height", `${rect.height}px`, "important");
                    browser.style.setProperty("min-width", `${rect.width}px`, "important");
                    browser.style.setProperty("min-height", `${rect.height}px`, "important");
                    browser.style.setProperty("max-width", `${rect.width}px`, "important");
                    browser.style.setProperty("max-height", `${rect.height}px`, "important");
                    browser.style.setProperty("flex", "none", "important");
                } catch (e) { }
            }

            if (!this._pinned.size) return;
            this._panel.setAttribute(FROZEN_ATTR, "true");
        }

        _thaw() {
            if (!this._pinned.size) {
                this._panel?.removeAttribute(FROZEN_ATTR);
                return;
            }

            for (const [browser, style] of this._pinned) {
                try {
                    if (style) browser.setAttribute("style", style);
                    else browser.removeAttribute("style");
                } catch (e) { }
            }
            this._pinned.clear();
            this._panel.removeAttribute(FROZEN_ATTR);

            // One relayout, now, rather than whenever the next frame gets to it. A flush
            // asked for by script is not interruptible, which is exactly what the frames
            // during the drag could not promise.
            for (const browser of this._panes()) {
                try {
                    if (browser.isRemoteBrowser) continue;
                    browser.getBoundingClientRect();
                    browser.contentDocument?.documentElement?.getBoundingClientRect();
                } catch (e) { }
            }
        }

        _panes() {
            try {
                const split = gBrowser.splitViewBrowsers;
                if (split && split.length) return Array.from(split);
            } catch (e) { }
            // Zen marks the containers it lays out, so this finds the same set during the
            // first frames of a split being created, before splitViewBrowsers is populated.
            try {
                return Array.from(
                    document.querySelectorAll('.browserSidebarContainer[zen-split="true"] browser')
                );
            } catch (e) { }
            return [];
        }

        destroy() {
            document.removeEventListener("pointerdown", this._onPointerDown, true);
            document.removeEventListener("mousedown", this._onMouseDown, true);
            if (this._observer) {
                try { this._observer.disconnect(); } catch (e) { }
                this._observer = null;
            }
            if (this._drag) this._endDrag();
            this._hideGhost();
            // Before dropping the panel reference, or a reload mid-drag would leave every
            // pinned page stuck at the size it was frozen at.
            this._thaw();
            this._panel?.classList.remove(NO_TRANSITION_CLASS);
            this._panel = null;
        }
    }

    window.ZenEaselSplitResize = ZenEaselSplitResize;
})();
