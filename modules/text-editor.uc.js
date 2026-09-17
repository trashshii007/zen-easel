// Zen Easel — text editor overlay.
//
// Text is painted to canvas like everything else, so editing needs a real focusable
// control on top of it. This is a <textarea> positioned over the object in screen
// coordinates with its font scaled by the zoom, which is how Excalidraw does it
// (wysiwyg/textWysiwyg.tsx).
//
// A textarea, not a contenteditable div, on purpose: its value is plain text by
// construction. contenteditable produces markup that has to be parsed back out, which
// is what the old renderer did and what the text.html -> text.content migration exists
// to undo.

"use strict";

(function () {
    if (window.ZenEaselTextEditor) return;

    // Taken from the renderer rather than restated, because the two agreeing exactly is
    // the whole point: any difference shows up as the text jumping when you open a box.
    const METRICS = window.ZenEaselRenderer.TEXT_METRICS;
    const LINE_HEIGHT = METRICS.lineHeight;

    class ZenEaselTextEditor {
        constructor(host, root) {
            this.host = host;
            this.root = root;               // .easel-viewport
            this.el = window.ZenEaselUtil.el;

            this.editing = null;            // object id being edited
            this._element = null;
            this._onInput = this._onInput.bind(this);
            this._onBlur = this._onBlur.bind(this);
            this._onKeyDown = this._onKeyDown.bind(this);
        }

        get isEditing() { return this.editing !== null; }

        start(obj, { selectAll = false } = {}) {
            if (this.editing) this.commit();

            this.editing = obj.id;

            const area = this.el("textarea", {
                className: "easel-text-editor",
                spellcheck: "false",
                wrap: "soft"
            });
            area.value = obj.text.content || "";
            // A Markdown box shows its source here, which can be taller than the rendered box.
            obj.h = this.editingHeight(obj);

            area.addEventListener("input", this._onInput);
            area.addEventListener("blur", this._onBlur);
            area.addEventListener("keydown", this._onKeyDown);

            this.root.appendChild(area);
            this._element = area;

            this.reposition();
            area.focus({ preventScroll: true });
            if (selectAll) area.select();
            else area.setSelectionRange(area.value.length, area.value.length);
        }

        // Called on every viewport change as well as on input: the editor has to track
        // the object underneath it through pans and zooms.
        reposition() {
            const area = this._element;
            const canvas = this.host.canvas;
            if (!area || !canvas) return;

            const obj = canvas._byId(this.editing);
            if (!obj) return;

            const view = canvas.view;
            const topLeft = canvas.toScreen(obj.x, obj.y);
            const fontSize = (obj.text.fontSize || 18) * view.zoom;

            Object.assign(area.style, {
                left: `${topLeft.x}px`,
                top: `${topLeft.y}px`,
                width: `${obj.w * view.zoom}px`,
                height: `${Math.max(obj.h * view.zoom, fontSize * LINE_HEIGHT + 4)}px`,
                fontSize: `${fontSize}px`,
                lineHeight: String(LINE_HEIGHT),
                fontFamily: window.ZenEaselObjects.fontCss(obj.text.fontFamily),
                color: window.ZenEaselObjects.colorCss(obj.color),
                textAlign: obj.text.align || "left",
                // Same inset the canvas draws at, scaled by the zoom. Combined with the
                // renderer's half-leading correction, the painted copy and the editable
                // copy land on the same pixels.
                padding: `${METRICS.padY * view.zoom}px ${METRICS.padX * view.zoom}px`,
                // The canvas rotates a text box about its own centre, so the editable
                // copy has to as well or double-clicking a tilted box would snap the
                // letters upright while you typed and drop them back on commit.
                // transform-origin is the box's centre for the same reason.
                transform: obj.rotation ? `rotate(${obj.rotation}deg)` : "",
                transformOrigin: "center center",
                // For the same reason as the colour and the font: a faded box that snapped
                // to full strength the moment you double-clicked it would look like the
                // edit had already changed something.
                opacity: obj.opacity === undefined ? "" : String(obj.opacity)
            });
        }

        // The height the box takes while its textarea is open. Plain text is what it
        // is; a Markdown box shows raw source, so it needs room for whichever of the
        // source and the rendered layout is taller or a long fence types into a clipped
        // box. commit() puts the rendered height back.
        editingHeight(obj) {
            const renderer = this.host.canvas.renderer;
            const rendered = renderer.measureTextHeight(obj);
            if (!obj.text.markdown) return rendered;
            return Math.max(rendered, renderer.measureTextHeight(obj, { source: true }));
        }

        _onInput() {
            const canvas = this.host.canvas;
            const obj = canvas._byId(this.editing);
            if (!obj) return;

            obj.text.content = this._element.value;
            // Height comes from the renderer's own measurement rather than from the
            // textarea, so the box the canvas will paint and the box being edited
            // agree exactly.
            obj.h = this.editingHeight(obj);
            this.reposition();
            canvas.invalidate();
            canvas._touch();
        }

        _onKeyDown(e) {
            // Escape and Ctrl+Enter commit; everything else belongs to the textarea,
            // including plain Enter for a new line.
            if (e.code === "Escape" || (e.code === "Enter" && e.ctrlKey)) {
                e.preventDefault();
                e.stopPropagation();
                this.host.canvas.stopEditing();
                return;
            }
            const obj = this.host.canvas._byId(this.editing);
            if (obj && obj.text.markdown && this._markdownKey(e)) {
                // about:easel is a parent-process page: without this Ctrl+B/I/K reach
                // Zen's own bindings and Tab moves focus out, which blurs and commits.
                e.preventDefault();
                e.stopPropagation();
                this._onInput();
                return;
            }
            // Stop canvas shortcuts from firing while typing.
            e.stopPropagation();
        }

        // Source-editing conveniences for a Markdown box. Returns true when it handled
        // the key. Everything goes through setRangeText so the textarea's own undo works.
        _markdownKey(e) {
            const area = this._element;
            const ctrl = e.ctrlKey && !e.altKey && !e.shiftKey;

            if (ctrl && (e.code === "KeyB" || e.code === "KeyI" || e.code === "KeyK")) {
                const start = area.selectionStart, end = area.selectionEnd;
                const selected = area.value.slice(start, end);
                if (e.code === "KeyK") {
                    area.setRangeText(`[${selected}](url)`, start, end, "end");
                    // Leave "url" selected so typing replaces it.
                    area.setSelectionRange(start + selected.length + 3, start + selected.length + 6);
                } else {
                    const mark = e.code === "KeyB" ? "**" : "*";
                    area.setRangeText(`${mark}${selected}${mark}`, start, end, "end");
                    area.setSelectionRange(start + mark.length, start + mark.length + selected.length);
                }
                return true;
            }

            if (e.code === "Tab" && !e.ctrlKey && !e.altKey) {
                const start = area.selectionStart, end = area.selectionEnd;
                const lineStart = area.value.lastIndexOf("\n", start - 1) + 1;
                if (e.shiftKey) {
                    const lead = area.value.slice(lineStart, lineStart + 2);
                    const drop = lead === "  " ? 2 : lead[0] === " " ? 1 : 0;
                    if (drop) area.setRangeText("", lineStart, lineStart + drop, "preserve");
                } else if (start === end) {
                    area.setRangeText("  ", start, end, "end");
                } else {
                    area.setRangeText("  ", lineStart, lineStart, "preserve");
                }
                return true;
            }

            if (e.code === "Enter" && !e.ctrlKey && !e.altKey && !e.shiftKey && area.selectionStart === area.selectionEnd) {
                const pos = area.selectionStart;
                const lineStart = area.value.lastIndexOf("\n", pos - 1) + 1;
                const line = area.value.slice(lineStart, pos);
                const m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/);
                if (!m) return false;
                // Enter on an empty item ends the list instead of adding another marker.
                if (!m[5]) {
                    area.setRangeText("", lineStart, pos, "end");
                    return true;
                }
                const num = m[2].match(/^(\d+)([.)])$/);
                const marker = num ? `${parseInt(num[1], 10) + 1}${num[2]}` : m[2];
                area.setRangeText(`\n${m[1]}${marker}${m[3]}${m[4] ? "[ ] " : ""}`, pos, pos, "end");
                return true;
            }
            return false;
        }

        _onBlur(event) {
            if (!this.editing) return;

            // Focus moving into the box's own controls is not the edit finishing. The
            // Aa and size panels sit beside the box precisely so they can be used
            // *while* typing, and committing here closed the editor the moment either
            // was clicked — the panel's own dismiss listener runs at capture on the
            // shadow root, far too late to prevent a blur that has already happened.
            //
            // relatedTarget is the element about to receive focus, and is null when
            // focus is leaving the window altogether. That case still commits, which is
            // the behaviour it has always had.
            const next = event && event.relatedTarget;
            if (next && next.closest &&
                next.closest(".easel-text-controls, .easel-font-panel")) {
                // Handed straight back, or the next keystroke would go nowhere.
                this._element.focus({ preventScroll: true });
                return;
            }

            this.host.canvas.stopEditing();
        }

        // Returns the edited object id, or null. Removes the overlay.
        commit() {
            const area = this._element;
            const id = this.editing;
            if (!area || !id) return null;

            const canvas = this.host.canvas;
            const obj = canvas._byId(id);
            if (obj) {
                obj.text.content = area.value;
                // Rendered height, not the editing height: the source is no longer on show.
                obj.h = canvas.renderer.measureTextHeight(obj);
            }

            area.removeEventListener("input", this._onInput);
            area.removeEventListener("blur", this._onBlur);
            area.removeEventListener("keydown", this._onKeyDown);
            area.remove();

            this._element = null;
            this.editing = null;
            return id;
        }

        destroy() {
            if (this._element) {
                this._element.remove();
                this._element = null;
            }
            this.editing = null;
        }
    }

    window.ZenEaselTextEditor = ZenEaselTextEditor;
})();
