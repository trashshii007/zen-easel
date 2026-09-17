// Zen Easel — floating text controls.
//
// The small vertical strip that rides alongside a text box, as Arc's easels do. Three
// buttons: Aa opens the typeface list, the size button opens the paragraph styles, and
// the last one is the highlighter.
//
// Both lists are the same popup. The five paragraph styles used to be rendered inline
// as five buttons down the side of the strip, which made the strip taller than most of
// the boxes it was annotating and put a permanent wall of labels next to text you were
// trying to read. Aa had already solved that problem for typefaces, so sizes borrow the
// solution rather than a second one being invented — hence _openPanel below being the
// only panel implementation, with one dismiss listener and one positioning rule.
//
// It is deliberately not in the toolbar. Text size is a property of the thing you are
// looking at, so the control belongs next to that thing — and putting it there is what
// let the toolbar shrink to Arc's compact tool pill.

"use strict";

(function () {
    if (window.ZenEaselTextControls) return;

    const GAP = 10;          // screen px between the box and the stepper
    const STEPPER_WIDTH = 36;

    // What the size button reads when the box is not on any preset — a size nudged by
    // hand, or one inherited from an older document. Deliberately not a number: the
    // button is 36px wide and "··" says "custom" without lying about which preset is on.
    const CUSTOM_LABEL = "··";

    class ZenEaselTextControls {
        constructor(host, root) {
            this.host = host;
            this.root = root;                 // .easel-viewport
            this.el = window.ZenEaselUtil.el;

            this._element = null;
            this._panel = null;               // { element, anchor, kind }
            this._targetId = null;
            this._dismiss = null;
        }

        /* --------------------------------------------------------------- build */

        _build() {
            if (this._element) return;

            this._fontToggle = this.el("button", {
                className: "easel-text-font",
                type: "button",
                title: "Typeface",
                textContent: "Aa",
                onclick: e => { e.stopPropagation(); this._togglePanel("font"); }
            });

            // Arc's five paragraph styles (EaselTextStyle: body, h2, h1, h0, ultra).
            // Presets over fontSize rather than a separate axis, so a box nudged off one
            // is simply custom rather than invalid.
            this._sizeToggle = this.el("button", {
                className: "easel-text-font easel-text-size",
                type: "button",
                title: "Text size",
                textContent: CUSTOM_LABEL,
                onclick: e => { e.stopPropagation(); this._togglePanel("size"); }
            });

            // EaselFillStyle.contentHugging — the highlighter.
            this._fillToggle = this.el("button", {
                className: "easel-text-fill",
                type: "button",
                title: "Highlight",
                textContent: "▮",
                onclick: e => { e.stopPropagation(); this._toggleFill(); }
            });

            // Markdown mode: the box keeps its source and the canvas paints it rendered.
            this._markdownToggle = this.el("button", {
                className: "easel-text-fill easel-text-md",
                type: "button",
                title: "Markdown",
                textContent: "M↓",
                onclick: e => { e.stopPropagation(); this._toggleMarkdown(); }
            });

            this._element = this.el("div", { className: "easel-text-controls" }, [
                this._fontToggle,
                this._sizeToggle,
                this.el("div", { className: "easel-text-divider" }),
                this._fillToggle,
                this._markdownToggle
            ]);
            this.root.appendChild(this._element);
        }

        /* ---------------------------------------------------------------- sync */

        // Called from the canvas paint loop, so the strip tracks the box through
        // pans, zooms and edits without a listener of its own.
        sync() {
            const canvas = this.host.canvas;
            if (!canvas || !canvas.doc) return this.hide();

            const target = this._resolveTarget(canvas);
            if (!target) return this.hide();

            this._build();
            this._targetId = target.id;
            this._element.classList.add("is-visible");

            const view = canvas.view;
            const topLeft = canvas.toScreen(target.x, target.y);
            const height = target.h * view.zoom;

            // Sits to the left of the box, vertically centred on it, and flips to the
            // right when the box is close to the left edge of the viewport.
            const preferredLeft = topLeft.x - STEPPER_WIDTH - GAP;
            const left = preferredLeft < 8
                ? topLeft.x + target.w * view.zoom + GAP
                : preferredLeft;

            const elementHeight = this._element.offsetHeight || 96;
            const top = Math.max(8, Math.min(
                topLeft.y + height / 2 - elementHeight / 2,
                this.root.clientHeight - elementHeight - 8
            ));

            this._element.style.left = `${left}px`;
            this._element.style.top = `${top}px`;

            this._reflectState(target);
            if (this._panel) this._positionPanel(left);
        }

        // Runs on every painted frame, so it compares before writing: toggling a class
        // unconditionally per frame is a style invalidation for a value that changes only
        // when the selection does.
        _reflectState(target) {
            const styleKey = window.ZenEaselObjects.TEXT_STYLES
                .find(s => s.size === target.text.fontSize)?.key ?? null;
            if (styleKey !== this._lastStyleKey) {
                this._lastStyleKey = styleKey;
                // The button reports which preset the box is on, so the strip answers
                // the question without the list having to be opened.
                const style = window.ZenEaselObjects.TEXT_STYLE_BY_KEY.get(styleKey);
                this._sizeToggle.textContent = style ? style.label : CUSTOM_LABEL;
                this._sizeToggle.title = style ? `Text size — ${style.label}` : "Text size";
            }

            const hugging = target.text.fill === "hug";
            if (hugging !== this._lastFill) {
                this._lastFill = hugging;
                this._fillToggle.classList.toggle("is-active", hugging);
            }

            const markdown = target.text.markdown === true;
            if (markdown !== this._lastMarkdown) {
                this._lastMarkdown = markdown;
                this._markdownToggle.classList.toggle("is-active", markdown);
            }
        }

        // The box being edited wins; otherwise a single selected text object. A
        // multi-selection gets nothing, since one strip cannot represent several
        // different sizes honestly.
        _resolveTarget(canvas) {
            const editor = this.host.textEditor;
            if (editor && editor.isEditing) return canvas._byId(editor.editing);

            if (canvas.selection.size !== 1) return null;
            const only = canvas._byId([...canvas.selection][0]);
            return only && only.type === "text" ? only : null;
        }

        hide() {
            this._targetId = null;
            if (this._element) this._element.classList.remove("is-visible");
            this._closePanel();
        }

        /* -------------------------------------------------------------- actions */

        _applyStyle(style) {
            const canvas = this.host.canvas;
            if (!this._targetId || !canvas._byId(this._targetId)) return;
            this.host.tools.fontSize = style.size;
            canvas.setSelectionText({ fontSize: style.size });
        }

        _applyFont(font) {
            const canvas = this.host.canvas;
            this.host.tools.fontFamily = font.key;
            canvas.setSelectionText({ fontFamily: font.key });
        }

        _toggleFill() {
            const canvas = this.host.canvas;
            const target = this._targetId && canvas._byId(this._targetId);
            if (!target) return;
            canvas.setSelectionText({ fill: target.text.fill === "hug" ? "none" : "hug" });
        }

        _toggleMarkdown() {
            const canvas = this.host.canvas;
            const target = this._targetId && canvas._byId(this._targetId);
            if (!target) return;
            const markdown = target.text.markdown !== true;
            // Remembered for the next box, the way the font and size are.
            this.host.tools.markdown = markdown;
            canvas.setSelectionText({ markdown });
        }

        /* ---------------------------------------------------------- the panel */

        // One popup, two contents. Reopening the panel that is already showing closes
        // it; opening the other one swaps straight across without a flash of nothing.
        _togglePanel(kind) {
            const open = this._panel && this._panel.kind === kind;
            this._closePanel();
            if (open) return;

            const rows = kind === "font" ? this._fontRows() : this._sizeRows();
            const anchor = kind === "font" ? this._fontToggle : this._sizeToggle;
            this._openPanel(kind, anchor, rows);
        }

        _fontRows() {
            const canvas = this.host.canvas;
            const target = this._targetId && canvas._byId(this._targetId);
            const current = target ? target.text.fontFamily : this.host.tools.fontFamily;

            return window.ZenEaselObjects.FONTS.map(font => this.el("button", {
                className: `easel-font-option${font.key === current ? " is-active" : ""}`,
                type: "button",
                // Each row previews its own typeface — the only reliable way to
                // pick one, and how Excalidraw's font picker reads.
                style: { fontFamily: font.css },
                textContent: font.label,
                onclick: e => {
                    e.stopPropagation();
                    this._applyFont(font);
                    this._closePanel();
                }
            }));
        }

        _sizeRows() {
            const canvas = this.host.canvas;
            const target = this._targetId && canvas._byId(this._targetId);
            const current = target ? target.text.fontSize : this.host.tools.fontSize;
            const styles = window.ZenEaselObjects.TEXT_STYLES;
            // Previewed at a size proportional to the real one rather than at it: Ultra
            // is 180px and would be a row taller than the viewport. The ramp is
            // normalised against the largest preset so the relative jumps stay honest.
            const largest = styles[styles.length - 1].size;

            return styles.map(style => this.el("button", {
                className: `easel-font-option${style.size === current ? " is-active" : ""}`,
                type: "button",
                style: { fontSize: `${11 + (style.size / largest) * 13}px`, fontWeight: "600" },
                textContent: style.label,
                onclick: e => {
                    e.stopPropagation();
                    this._applyStyle(style);
                    this._closePanel();
                }
            }));
        }

        _openPanel(kind, anchor, rows) {
            const panel = this.el("div", { className: "easel-font-panel" }, rows);
            this.root.appendChild(panel);
            this._panel = { element: panel, anchor, kind };
            anchor.classList.add("is-open");
            this._positionPanel(parseFloat(this._element.style.left) || 0);
            // Opening one moves nothing on the board, so nothing else would tell the live
            // layer there is a new panel to keep its tiles out from under.
            this.host.chromeChanged();

            this._dismiss = event => {
                const path = event.composedPath();
                if (path.includes(panel) || path.includes(anchor)) return;
                this._closePanel();
            };
            this.host.shadowRoot.addEventListener("pointerdown", this._dismiss, true);
        }

        // Opens on whichever side has room, matching the strip's own flip.
        _positionPanel(stepperLeft) {
            if (!this._panel || !this._element) return;
            const panel = this._panel.element;

            const width = panel.offsetWidth || 190;
            const toLeft = stepperLeft - width - 8;
            panel.style.left = toLeft < 8
                ? `${stepperLeft + STEPPER_WIDTH + 8}px`
                : `${toLeft}px`;

            // Aligned to the button that opened it rather than to the strip, so the
            // size list does not sit over the typeface button and vice versa.
            const stripTop = parseFloat(this._element.style.top) || 0;
            const top = stripTop + this._panel.anchor.offsetTop;
            panel.style.top = `${Math.max(8, Math.min(top, this.root.clientHeight - panel.offsetHeight - 8))}px`;
        }

        _closePanel() {
            if (!this._panel) return;
            this._panel.element.remove();
            this._panel.anchor.classList.remove("is-open");
            this._panel = null;
            this.host.chromeChanged();
            if (this._dismiss) {
                this.host.shadowRoot.removeEventListener("pointerdown", this._dismiss, true);
                this._dismiss = null;
            }
        }

        destroy() {
            this._closePanel();
            if (this._element) {
                this._element.remove();
                this._element = null;
            }
        }
    }

    window.ZenEaselTextControls = ZenEaselTextControls;
})();
