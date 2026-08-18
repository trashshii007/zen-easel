// Zen Easel — floating shape controls.
//
// The sibling of text-controls.uc.js: the same vertical strip, riding alongside a selected
// shape instead of a text box, offering the one choice a shape has that its colour and
// stroke width do not already cover — whether it is a solid block or just an outline.
//
// Arc's EaselShapeViewController has the same property. The renderer here has honoured it
// since shapes were added (`if (obj.shape.filled) ctx.fill()`), but nothing ever set it:
// every shape was created with `filled: false` and there was no way to say otherwise. So
// this is the missing half of a feature rather than a new one.
//
// Deliberately not in the toolbar, for the reason the text strip is not either: fill is a
// property of the thing you are looking at, so the control belongs next to that thing.
//
// Only shapes with an interior get the strip. A line and an arrow have none — the renderer
// returns before the fill test for both — and offering the choice there would be a control
// that does nothing.

"use strict";

(function () {
    if (window.ZenEaselShapeControls) return;

    const GAP = 10;          // screen px between the shape and the strip
    const STRIP_WIDTH = 36;

    // The kinds that enclose an area. Kept here rather than inferred from the renderer so
    // the two cannot silently disagree about what "fillable" means.
    const FILLABLE = new Set(["rectangle", "ellipse", "triangle"]);

    class ZenEaselShapeControls {
        constructor(host, root) {
            this.host = host;
            this.root = root;                 // .easel-viewport
            this.el = window.ZenEaselUtil.el;

            this._element = null;
            this._targetIds = [];
            this._lastFilled = null;
        }

        /* --------------------------------------------------------------- build */

        _build() {
            if (this._element) return;

            // Two explicit options rather than one toggle. Fill is a binary *look*, and a
            // toggle only tells you the current state if you already know which way round
            // it reads; a pair shows both and highlights the one in force.
            this._outlineButton = this._option("Outline", false);
            this._solidButton = this._option("Solid", true);

            this._element = this.el("div", { className: "easel-shape-controls" }, [
                this._outlineButton,
                this._solidButton
            ]);
            this.root.appendChild(this._element);
        }

        _option(label, filled) {
            return this.el("button", {
                className: "easel-shape-option",
                type: "button",
                title: filled ? "Solid fill" : "Outline only",
                "aria-label": filled ? "Solid fill" : "Outline only",
                onclick: e => {
                    e.stopPropagation();
                    this._applyFill(filled);
                }
            }, [
                // Drawn in CSS rather than set as a glyph: ■ and □ are a different weight
                // and baseline in every font, and these have to read as the same square in
                // two states.
                this.el("span", {
                    className: `easel-shape-swatch${filled ? " is-solid" : ""}`
                })
            ]);
        }

        /* ---------------------------------------------------------------- sync */

        // Called from the canvas paint loop, so the strip tracks its shape through pans,
        // zooms and drags without a listener of its own.
        sync() {
            const canvas = this.host.canvas;
            if (!canvas || !canvas.doc) return this.hide();

            const targets = this._resolveTargets(canvas);
            if (!targets.length) return this.hide();

            this._build();
            this._targetIds = targets.map(o => o.id);
            this._element.classList.add("is-visible");

            const view = canvas.view;
            // Positioned against the union of the selection, so a strip beside several
            // shapes sits beside all of them rather than beside whichever happened to be
            // first in the list.
            const bounds = this.host.canvas.Objects.unionBounds(targets);
            const topLeft = canvas.toScreen(bounds.x, bounds.y);
            const height = bounds.h * view.zoom;

            // Left of the shape, vertically centred, flipping to the right when there is
            // no room — the same rule the text strip follows, so the two never behave
            // differently in the same corner of the board.
            const preferredLeft = topLeft.x - STRIP_WIDTH - GAP;
            const left = preferredLeft < 8
                ? topLeft.x + bounds.w * view.zoom + GAP
                : preferredLeft;

            const elementHeight = this._element.offsetHeight || 64;
            const top = Math.max(8, Math.min(
                topLeft.y + height / 2 - elementHeight / 2,
                this.root.clientHeight - elementHeight - 8
            ));

            this._element.style.left = `${left}px`;
            this._element.style.top = `${top}px`;

            this._reflectState(targets);
        }

        // Runs on every painted frame, so it compares before writing rather than toggling
        // classes for a value that changes only when the selection does.
        _reflectState(targets) {
            // null for a mixed selection: neither option is in force, so neither is shown
            // as active. Claiming one would be a guess the user then has to undo.
            const first = !!targets[0].shape.filled;
            const filled = targets.every(o => !!o.shape.filled === first) ? first : null;

            if (filled === this._lastFilled) return;
            this._lastFilled = filled;
            this._outlineButton.classList.toggle("is-active", filled === false);
            this._solidButton.classList.toggle("is-active", filled === true);
        }

        // Every selected object must be a fillable shape. A selection that also holds text
        // or an image gets nothing: the strip would be claiming to describe objects it
        // cannot change.
        _resolveTargets(canvas) {
            if (!canvas.selection.size) return [];
            const targets = [];
            for (const id of canvas.selection) {
                const obj = canvas._byId(id);
                if (!obj || obj.type !== "shape") return [];
                if (!obj.shape || !FILLABLE.has(obj.shape.kind)) return [];
                targets.push(obj);
            }
            return targets;
        }

        hide() {
            this._targetIds = [];
            this._lastFilled = null;
            if (this._element) this._element.classList.remove("is-visible");
        }

        /* -------------------------------------------------------------- actions */

        _applyFill(filled) {
            const canvas = this.host.canvas;
            if (!this._targetIds.length) return;
            // Remembered as the toolbar's default too, so the next shape drawn keeps the
            // choice — the same thing _applyStyle does for text size.
            this.host.tools.shapeFilled = filled;
            canvas.setSelectionShape({ filled });
        }

        destroy() {
            if (this._element) {
                this._element.remove();
                this._element = null;
            }
        }
    }

    window.ZenEaselShapeControls = ZenEaselShapeControls;
})();
