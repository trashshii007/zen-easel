// Zen Easel — the colour wheel panel.
//
// One panel, two callers. The toolbar opens it for the colour of the next mark, and the board
// menu opens it for the board's own colour; the only differences are what the second slider
// means, which swatches sit under "Standard", and what an extra row of controls is.
//
// Colour is HSV here and hex everywhere else: the wheel is angle = hue, radius = saturation,
// and value is a slider, which is the one decomposition that makes a round picker legible.
// The conversions live in objects.uc.js beside rgbOf, so this module owns no colour maths.

"use strict";

(function () {
    if (window.ZenEaselColorPicker) return;

    // The wheel's drawn size. Read back through getBoundingClientRect for the pointer maths,
    // so this only has to agree with the stylesheet, not drive it.
    const WHEEL_SIZE = 130;

    // How many slots the Recently used and Favourites rows each hold. Both are drawn full even
    // when they hold less than that: a row that grows as you use it moves the rows under it, and
    // a favourite's slot is its identity — you replace slot three, not "the third one there is".
    const SLOTS = window.ZenEaselObjects.RECENT_LIMIT;

    const FAVORITES_PREF = "zen.easel.favorites";

    // Favourites are a personal palette rather than a property of one board, so unlike the
    // recents they live in a pref and follow you between easels. Alpha rides along with the
    // colour because the whole point of the row is to put back a look you had, and half of a
    // washed-out board is its opacity.
    function readFavorites() {
        let raw;
        try {
            // Straight off the pref, not out of ZenEaselUtil.prefs: that cache is refreshed by an
            // observer and exists to keep pointer-move handlers off XPCOM, neither of which
            // applies here. Reading it directly means a favourite is on disk and readable the
            // instant it is saved, with nothing in between to go stale.
            raw = JSON.parse(window.ZenEaselUtil.prefStr(FAVORITES_PREF, "[]") || "[]");
        } catch (e) {
            return [];
        }
        if (!Array.isArray(raw)) return [];

        // Mapped rather than filtered: a hole has to stay in its slot, or replacing the fourth
        // favourite while the second is empty would silently rewrite the wrong one.
        return raw.slice(0, SLOTS).map(entry => {
            const color = window.ZenEaselObjects.normalizeColor(entry && entry.color);
            if (!color) return null;
            const alpha = Number(entry.alpha);
            return { color, alpha: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1 };
        });
    }

    function writeFavorites(list) {
        try {
            Services.prefs.setStringPref(FAVORITES_PREF, JSON.stringify(list.slice(0, SLOTS)));
        } catch (e) {
            console.error("[zen-easel] could not save favourites:", e);
        }
    }

    class ZenEaselColorPicker {
        // `onColor` and `onAlpha` both take (value, live); live is a gesture still in flight.
        constructor({
            color, alpha = 1, alphaLabel = "Opacity", alphaMin = 0, alphaStep = 1,
            standardRows = [], standardCurrent, recents = [], extraRows = [],
            onColor, onAlpha, onPreset, onRestore
        }) {
            this.el = window.ZenEaselUtil.el;
            this.Objects = window.ZenEaselObjects;

            this.onColor = onColor;
            this.onAlpha = onAlpha;
            // Board presets are keys, not colours; without this they would be handed to onColor as a hex it cannot parse.
            this.onPreset = onPreset;
            // Putting a favourite back is one action, so it is offered as one callback. Applying
            // the colour and the opacity through their own callbacks left two entries on the undo
            // stack for a single click, the first of them a state nobody asked for.
            this.onRestore = onRestore;

            // Every swatch this panel drew, so the active ring can be re-derived whenever the
            // colour moves — a swatch is a control that reports state, not just one that sets it.
            this._swatches = [];
            // What the Standard row compares against. The board's panel matches on a background
            // key, which is not a colour at all; the toolbar's matches on the colour itself.
            this._standardCurrent = standardCurrent;

            this.color = this.Objects.normalizeColor(color) || this.Objects.DEFAULT_COLOR;
            // Reported as it is, including a brightness of zero for black: the panel's job on
            // opening is to show the colour actually in force, not a tidier one. What keeps a
            // black colour from making the wheel inert is the lift in _wheelTo.
            this.hsv = this.Objects.hexToHsv(this.color);
            // Tracked, not just forwarded: saving a favourite has to know what the slider is on.
            // The floor matters because a favourite saved from the board can carry an alpha the
            // toolbar's own slider cannot reach — objects stop at OPACITY.min, boards do not.
            this._alphaMin = alphaMin / 100;
            this.alpha = Math.max(this._alphaMin, Math.min(1, alpha));

            // this.alpha, not the raw config: the slider and the value the panel reports have to
            // be the same number, or a favourite saved straight after opening records something
            // the thumb was never on.
            this.element = this._render({
                alpha: this.alpha, alphaLabel, alphaMin, alphaStep,
                standardRows, recents, extraRows
            });
            this._syncActiveSwatches();
        }

        /* ---------------------------------------------------------------- syncing */

        // Re-seed from outside. The board can change under this panel — a Standard preset is a
        // whole board, not a colour — and when it does the wheel, the brightness and the opacity
        // all have to follow it, or the panel is describing something that is no longer there.
        sync({ color, alpha, standardCurrent } = {}) {
            if (color !== undefined) {
                this.color = this.Objects.normalizeColor(color) || this.color;
                this.hsv = this.Objects.hexToHsv(this.color);
            }
            if (alpha !== undefined) this._setAlpha(alpha);
            if (standardCurrent !== undefined) this._standardCurrent = standardCurrent;
            this._syncReadouts();
        }

        // Just the Standard row's ring. Its own entry point because the board's panel has to
        // clear that ring on every live frame of a wheel drag, and routing it through sync()
        // ran the whole of _syncReadouts a second time per pointermove — six style writes and
        // a pass over every swatch in the panel, all of them already done a moment earlier.
        syncStandard(current) {
            this._standardCurrent = current;
            this._syncActiveSwatches();
        }

        // Moves the slider without firing it. Every path that changes opacity from somewhere
        // other than the thumb — a preset, a favourite, a re-seed — goes through here.
        _setAlpha(alpha) {
            this.alpha = Math.max(this._alphaMin, Math.min(1, alpha));
            if (!this._alpha) return;
            const percent = Math.round(this.alpha * 100);
            this._alpha.value = String(percent);
            if (this._alphaReadout) this._alphaReadout.textContent = `${percent}%`;
        }

        _syncActiveSwatches() {
            for (const { entry, button, match } of this._swatches) {
                button.classList.toggle("is-active", match(entry.key));
            }
        }

        /* ------------------------------------------------------------- rendering */

        _render({ alpha, alphaLabel, alphaMin, alphaStep, standardRows, recents, extraRows }) {
            const rows = [this._topRow({ alpha, alphaLabel, alphaMin, alphaStep })];

            // Side by side, and both always drawn full. Empty slots are black rather than absent
            // so the two rows keep their shape — and so a favourite's slot is somewhere you can
            // aim at before there is anything in it.
            const favorites = readFavorites();
            this._favoriteSlots = [];

            rows.push(this.el("div", { className: "easel-swatch-columns" }, [
                this._section("Recently used", [this._slotRow({
                    entries: recents.map(hex => ({ color: hex })),
                    title: entry => (entry ? entry.color : "No colour used yet"),
                    // An empty slot is inert, for the same reason it is left out of the active
                    // ring: it is a placeholder that happens to be drawn black, not a black
                    // colour anyone chose, and clicking one used to apply black.
                    onPick: entry => { if (entry) this._commitColor(entry.color); }
                })]),
                this._section("Favourites", [this._slotRow({
                    entries: favorites,
                    records: this._favoriteSlots,
                    title: entry => (entry ? `${entry.color} — right-click to replace`
                        : "Empty — right-click to save the current colour"),
                    onPick: entry => this._commitFavorite(entry),
                    onSave: index => this._saveFavorite(index)
                })])
            ]));

            // Matched live rather than against a snapshot, so picking a swatch moves the ring.
            rows.push(this._section("Standard", standardRows.map(entries => this._swatchRow({
                swatches: entries,
                match: key => key === (this._standardCurrent ?? this.color),
                onPick: key => this._pickStandard(key)
            }))));

            for (const row of extraRows) rows.push(row);

            return this.el("div", { className: "easel-color-panel" }, rows);
        }

        // The wheel, the three ways of reading the colour it is pointing at, and both sliders.
        _topRow({ alpha, alphaLabel, alphaMin, alphaStep }) {
            this._handle = this.el("div", { className: "easel-wheel-handle" });
            this._wheel = this.el("div", {
                className: "easel-wheel",
                onpointerdown: e => this._wheelDown(e)
            }, [this._handle]);

            this._hexField = this.el("input", {
                className: "easel-hex-field",
                type: "text",
                spellcheck: "false",
                title: "Hex colour",
                "aria-label": "Hex colour",
                value: this.color,
                // Enter and blur only. Committing per keystroke would repaint the board from "#8", "#83", "#833"…
                onkeydown: e => {
                    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
                    else if (e.key === "Escape") {
                        e.preventDefault();
                        // Put back by hand, not through _syncReadouts: that one deliberately
                        // leaves a focused field alone so the caret does not jump on every
                        // repaint, so calling it here left the typed text standing and the
                        // blur below committed it. Escape has to cancel, not apply.
                        e.target.value = this.color;
                        e.target.blur();
                    }
                    e.stopPropagation();
                },
                onchange: e => this._commitHexField(e.target),
                onblur: e => this._commitHexField(e.target)
            });

            this._preview = this.el("div", { className: "easel-color-preview" });
            this._rgb = this.el("div", { className: "easel-rgb-readout" });

            this._syncReadouts();

            // Both sliders live in this column beside the wheel rather than as full-width rows
            // under the swatches. Brightness is the wheel's third axis and belongs next to it;
            // opacity follows it so the panel ends on the swatches instead of on two more rows.
            const brightness = this._slider({
                label: "Brightness",
                value: Math.round(this.hsv.v * 100),
                // Kept in _syncReadouts, because a swatch, the hex field and the wheel can all move value out from under it.
                ref: "_brightness",
                oninput: (value, live) => {
                    this.hsv.v = value / 100;
                    this._applyHsv(live);
                }
            });

            const opacity = this._slider({
                label: alphaLabel,
                value: Math.round(alpha * 100),
                min: alphaMin,
                step: alphaStep,
                readout: true,
                // Driven from sync() as well as by hand, because a Standard preset carries an
                // alpha of its own and picking one has to move this.
                ref: "_alpha",
                oninput: (value, live) => {
                    this.alpha = value / 100;
                    this.onAlpha(this.alpha, live);
                }
            });

            return this.el("div", { className: "easel-color-top" }, [
                this._wheel,
                this.el("div", { className: "easel-color-readouts" }, [
                    this.el("span", { className: "easel-panel-label", textContent: "Hex" }),
                    this.el("div", { className: "easel-hex-row" }, [this._hexField, this._preview]),
                    this.el("span", { className: "easel-panel-label", textContent: "RGB" }),
                    this._rgb,
                    this.el("div", { className: "easel-slider-stacks" }, [brightness, opacity])
                ])
            ]);
        }

        _section(label, children) {
            return this.el("div", { className: "easel-swatch-section" }, [
                this.el("span", { className: "easel-panel-label", textContent: label }),
                ...children
            ]);
        }

        // A fixed-width row of slots — Recently used and Favourites. Always SLOTS buttons, with
        // an unfilled one drawn black, so neither row reflows as it fills up.
        //
        // `onSave` makes a slot writable: right-clicking one stores whatever the wheel and the
        // opacity slider are currently on. The default menu is suppressed because this panel can
        // be a flyout inside the board's own context menu, and the board would otherwise open a
        // second one underneath it.
        _slotRow({ entries, records, title, onPick, onSave }) {
            const row = this.el("div", { className: "easel-swatch-row" });

            for (let i = 0; i < SLOTS; i++) {
                // `value` is read at click time, never captured: a slot can be written by a
                // right-click after it is drawn, and a handler holding the entry it was built
                // with would still be answering for the empty slot it used to be.
                //
                // `entry.key` is what the active ring matches on. Only a filled slot can be the
                // active one — an empty slot is a placeholder that happens to be black, not a
                // black colour anyone chose.
                const record = {
                    value: entries[i] || null,
                    entry: { key: entries[i] ? entries[i].color : null }
                };
                const button = this.el("button", {
                    className: "easel-swatch",
                    type: "button",
                    title: title(record.value),
                    style: { "--swatch": record.value ? record.value.color : this.Objects.DEFAULT_COLOR },
                    onclick: () => onPick(record.value, i),
                    oncontextmenu: onSave
                        ? e => { e.preventDefault(); e.stopPropagation(); onSave(i); }
                        : null
                });

                record.button = button;
                record.match = key => key !== null && key === this.color;
                this._swatches.push(record);
                if (records) records.push(record);
                row.appendChild(button);
            }
            return row;
        }

        // Left-clicking a favourite puts back the whole look, not just the hue: the wheel, the
        // brightness that follows from it, and the opacity it was saved at.
        _commitFavorite(entry) {
            // Nothing saved in this slot yet. Inert rather than applying the black it is drawn
            // in — right-clicking is how an empty slot is meant to be used.
            if (!entry) return;
            this.color = entry.color;
            this.hsv = this.Objects.hexToHsv(this.color);
            this._setAlpha(entry.alpha);
            this._syncReadouts();

            // this.alpha, not entry.alpha — the floor in _setAlpha may have raised it.
            if (this.onRestore) this.onRestore(this.color, this.alpha);
            else {
                this.onColor(this.color, false);
                this.onAlpha(this.alpha, false);
            }
        }

        _saveFavorite(index) {
            const list = readFavorites();
            while (list.length < SLOTS) list.push(null);
            list[index] = { color: this.color, alpha: this.alpha };
            writeFavorites(list);

            // Repainted in place rather than by rebuilding the row, so the panel does not flicker
            // and nothing else in it loses its state.
            const slot = this._favoriteSlots[index];
            if (slot) {
                // value first: it is what the click handler reads, and leaving it behind is what
                // made a freshly saved favourite apply black.
                slot.value = list[index];
                slot.entry.key = list[index].color;
                slot.button.style.setProperty("--swatch", list[index].color);
                slot.button.title = `${list[index].color} — right-click to replace`;
            }
            this._syncActiveSwatches();
        }

        // A row of round swatches, used for both standard rows and the board presets. The
        // "Follow theme" board has no colour of its own and is drawn as a split light/dark disc
        // instead.
        _swatchRow({ swatches, match, onPick }) {
            const row = this.el("div", { className: "easel-swatch-row" });
            for (const entry of swatches) {
                const fill = entry.swatch || entry.css;
                const button = this.el("button", {
                    className: `easel-swatch${fill ? "" : " is-theme"}`,
                    type: "button",
                    title: entry.label,
                    style: fill ? { "--swatch": fill } : null,
                    onclick: () => onPick(entry.key)
                });
                this._swatches.push({ entry, button, match });
                row.appendChild(button);
            }
            return row;
        }

        // Brightness and the alpha slider are the same control; only what they drive differs.
        // Caption above rather than beside, because the column they sit in is too narrow to
        // give a label, a track and a readout a row each of their own.
        _slider({ label, value, readout, oninput, min = 0, step = 1, ref }) {
            const value$ = readout
                ? this.el("span", { className: "easel-slider-value", textContent: `${value}%` })
                : null;

            const slider = this.el("input", {
                className: "easel-slider",
                type: "range",
                min: String(min),
                max: "100",
                step: String(step),
                value: String(value),
                title: label,
                "aria-label": label,
                // input fires per pixel of the drag, change once it ends — so the board follows the
                // thumb and the undo stack gets one entry for the whole gesture.
                oninput: e => {
                    if (value$) value$.textContent = `${e.target.value}%`;
                    oninput(Number(e.target.value), true);
                },
                onchange: e => oninput(Number(e.target.value), false)
            });

            if (ref) {
                this[ref] = slider;
                this[`${ref}Readout`] = value$;
            }

            return this.el("div", { className: "easel-slider-stack" }, [
                this.el("div", { className: "easel-slider-caption" }, [
                    this.el("span", { className: "easel-panel-label", textContent: label }),
                    value$
                ]),
                slider
            ]);
        }

        /* ---------------------------------------------------------------- wheel */

        _wheelDown(e) {
            e.preventDefault();
            e.stopPropagation();
            this._wheel.setPointerCapture(e.pointerId);

            const move = event => this._wheelTo(event, true);
            const up = event => {
                this._wheel.removeEventListener("pointermove", move);
                this._wheel.removeEventListener("pointerup", up);
                this._wheel.removeEventListener("pointercancel", up);
                this._wheelTo(event, false);
            };
            this._wheel.addEventListener("pointermove", move);
            this._wheel.addEventListener("pointerup", up);
            this._wheel.addEventListener("pointercancel", up);

            this._wheelTo(e, true);
        }

        // Angle is hue counter-clockwise from +x, radius is saturation. Matches the conic
        // gradient in the stylesheet, which starts at +x and runs the same way.
        _wheelTo(e, live) {
            const rect = this._wheel.getBoundingClientRect();
            const radius = rect.width / 2;
            const dx = e.clientX - (rect.left + radius);
            const dy = e.clientY - (rect.top + radius);

            const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
            this.hsv.h = (angle + 360) % 360;
            this.hsv.s = Math.min(1, Math.hypot(dx, dy) / radius);
            // A black colour has no brightness for a hue to be visible at, so reaching for the
            // wheel at all is the moment to give it one — otherwise the drag paints black.
            if (!this.hsv.v) this.hsv.v = 1;
            this._applyHsv(live);
        }

        _applyHsv(live) {
            this.color = this.Objects.hsvToHex(this.hsv.h, this.hsv.s, this.hsv.v);
            this._syncReadouts();
            this.onColor(this.color, live);
        }

        /* --------------------------------------------------------------- picking */

        // A swatch is a click, not a drag, so it commits outright — and it moves the wheel with
        // it, or the handle would sit somewhere unrelated to the colour now selected.
        _commitColor(hex) {
            this.color = this.Objects.normalizeColor(hex) || this.Objects.DEFAULT_COLOR;
            this.hsv = this.Objects.hexToHsv(this.color);
            this._syncReadouts();
            this.onColor(this.color, false);
        }

        // Board presets are keys rather than colours, so they go back untouched — and the panel
        // stays open, because a preset carries a colour *and* an alpha and the point of clicking
        // one is to see both land. The caller re-seeds through sync() once it has applied it.
        _pickStandard(key) {
            if (this.Objects.normalizeColor(key)) {
                this._commitColor(key);
                return;
            }
            (this.onPreset || this.onColor)(key, false);
        }

        _commitHexField(field) {
            const hex = this.Objects.normalizeColor(field.value);
            if (!hex) {
                this._syncReadouts();
                return;
            }
            this.color = hex;
            this.hsv = this.Objects.hexToHsv(hex);
            this._syncReadouts();
            this.onColor(hex, false);
        }

        // Everything that reports the current colour, in one place: the field, the chip, the
        // channels, the wheel's own brightness veil and where its handle sits.
        _syncReadouts() {
            const radius = WHEEL_SIZE / 2;
            const angle = this.hsv.h * Math.PI / 180;
            const x = radius + Math.cos(angle) * this.hsv.s * radius;
            const y = radius - Math.sin(angle) * this.hsv.s * radius;

            this._wheel.style.setProperty("--easel-wheel-v", String(this.hsv.v));
            this._handle.style.left = `${x}px`;
            this._handle.style.top = `${y}px`;
            this._handle.style.background = this.color;

            this._preview.style.background = this.color;
            this._rgb.textContent = (this.Objects.rgbOf(this.color) || [0, 0, 0]).join(", ");
            // Absent on the first call, which runs while the top row is still being built.
            if (this._brightness) this._brightness.value = String(Math.round(this.hsv.v * 100));
            this._syncActiveSwatches();
            // Left alone while it is being typed into, or the caret would jump on every repaint.
            if (this._hexField !== this._hexField.ownerDocument.activeElement) {
                this._hexField.value = this.color;
            }
        }
    }

    window.ZenEaselColorPicker = ZenEaselColorPicker;
})();
