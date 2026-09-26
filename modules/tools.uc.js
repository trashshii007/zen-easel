// Zen Easel — toolbar, colour and tool state.
//
// Tool names double as shape kinds: the canvas dispatches anything that is not
// pointer/pen/text/image straight into _shapeToolDown with the tool name as the kind,
// so adding a shape means adding one entry to TOOLS and one case to renderShape.
//
// Single-key shortcuts follow the order of Arc's own toolbar icons
// (EaselIconPointer, EaselIconText, EaselIconRectangle, EaselIconTriangle,
// EaselIconLine, EaselIconShapes, the pencil cursor, EaselIconImage).

"use strict";

(function () {
    if (window.ZenEaselTools) return;

    const ICONS = {
        pointer: '<path d="M5 3 L5 19 L9 15 L11.5 20.5 L14 19.4 L11.6 14.2 L17.5 13.8 Z"/>',
        text: '<path d="M5 6 V4 H19 V6 M12 4 V20 M9 20 H15" fill="none" stroke-width="1.8"/>',
        rectangle: '<rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke-width="1.8"/>',
        ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" fill="none" stroke-width="1.8"/>',
        triangle: '<path d="M12 4.5 L20.5 19 L3.5 19 Z" fill="none" stroke-width="1.8" stroke-linejoin="round"/>',
        line: '<path d="M4.5 19.5 L19.5 4.5" fill="none" stroke-width="1.8" stroke-linecap="round"/>',
        arrow: '<path d="M4.5 19.5 L19.5 4.5 M19.5 4.5 L12.5 5.5 M19.5 4.5 L18.5 11.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        pen: '<path d="M4 20 L4.8 16.2 L15.5 5.5 L18.5 8.5 L7.8 19.2 Z M14 7 L17 10" fill="none" stroke-width="1.8" stroke-linejoin="round"/>',
        image: '<rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke-width="1.8"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4.5 17.5 L9.5 12.5 L13 15.5 L16 13 L19.5 16.5" fill="none" stroke-width="1.8" stroke-linejoin="round"/>',
        // The two faces of the mode toggle: the plane you are on, and the page you would go to.
        infinite: '<path d="M12 12 C9.5 8.5 4 8.5 4 12 C4 15.5 9.5 15.5 12 12 C14.5 8.5 20 8.5 20 12 C20 15.5 14.5 15.5 12 12 Z" fill="none" stroke-width="1.8" stroke-linejoin="round"/>',
        page: '<rect x="5.5" y="3.5" width="13" height="17" rx="2" fill="none" stroke-width="1.8"/><path d="M12 8 V16 M9 13 L12 16 L15 13" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
    };

    // Order follows Arc's own easel toolbar: pointer, image, text, then shapes, then
    // the pen. Shortcut keys are unchanged — only the display order moved.
    const TOOLS = [
        { id: "pointer", label: "Select", key: "KeyV" },
        // Still "image" by id — the icon, the shortcut and the CSS rule are keyed on it —
        // but the picker behind it takes any file.
        { id: "image", label: "File", key: "KeyI" },
        { id: "text", label: "Text", key: "KeyT" },
        { id: "ellipse", label: "Ellipse", key: "KeyO" },
        { id: "rectangle", label: "Rectangle", key: "KeyR" },
        { id: "triangle", label: "Triangle", key: "KeyY" },
        { id: "line", label: "Line", key: "KeyL" },
        { id: "arrow", label: "Arrow", key: "KeyA" },
        { id: "pen", label: "Pen", key: "KeyP" }
    ];

    // Heavier than the first pass. At 100% zoom on a high-DPI display the old 2/4/8
    // set read as hairlines against Arc's soft background.
    const STROKE_WIDTHS = [4, 8, 14];

    // Number-row order matching the picker's first standard row: 1..9 then 0 for the tenth colour.
    const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5",
        "Digit6", "Digit7", "Digit8", "Digit9", "Digit0"];

    class ZenEaselTools {
        constructor(host, root, menuLayer) {
            this.host = host;
            this.root = root;              // nav.easel-toolbar
            this.menuLayer = menuLayer;    // div.easel-menu-layer
            this.el = window.ZenEaselUtil.el;

            this.active = "pointer";
            // White on a dark Zen theme, black on a light one. A fixed black default was invisible
            // on a dark board, which is the board a dark browser comes up on.
            this.color = this._themeColor();
            this.strokeWidth = 8;
            // Fully opaque, like every object created before there was a slider. Kept as
            // a toolbar default alongside colour and stroke width, so the next thing drawn
            // inherits whatever the last thing was set to.
            this.opacity = 1;
            // Whether a newly drawn shape is a solid block or an outline. Set from the
            // floating shape controls, the way fontSize is set from the text ones.
            this.shapeFilled = false;
            // Arc's Body size. The old 24 was legible, but nothing like the confident
            // lettering Arc's easels have.
            this.fontSize = 32;
            this.fontFamily = "system";
            // Whether the next text box renders its content as Markdown; set from the text controls like the font.
            this.markdown = false;

            this._buttons = new Map();
            this._menu = null;
            this._popup = null;
            this._onDocPointerDown = this._onDocPointerDown.bind(this);
        }

        /* ------------------------------------------------------------- rendering */

        render() {
            this.root.replaceChildren();

            const tools = this.el("div", { className: "easel-tool-group" });
            for (const tool of TOOLS) {
                const button = this.el("button", {
                    className: "easel-tool",
                    type: "button",
                    title: `${tool.label} (${tool.key.replace("Key", "")})`,
                    dataset: { tool: tool.id },
                    onclick: () => this.setActive(tool.id)
                }, [this._icon(ICONS[tool.id])]);
                tools.appendChild(button);
                this._buttons.set(tool.id, button);
            }

            // A single swatch that opens the picker, rather than ten inline circles.
            // Arc's toolbar is a compact strip of tools; colour is a property of what
            // you are about to draw, so it belongs one level down.
            this._colorButton = this.el("button", {
                className: "easel-color-button",
                type: "button",
                title: "Colour and stroke",
                onclick: e => { e.stopPropagation(); this._openStylePopup(); }
            }, [this.el("span", { className: "easel-color-dot" })]);

            this.root.append(
                tools,
                this.el("div", { className: "easel-toolbar-divider" }),
                this._colorButton
            );

            // The infinite / Arc mode toggle, in the viewport's top-right corner rather
            // than in this strip: it is about the board, not about the next mark, and it
            // has to stay put when the topbar is hidden. render() can run again, so any
            // earlier button goes first.
            const viewport = this.host.viewport;
            viewport.querySelector(".easel-mode-toggle")?.remove();
            this._modeToggle = this.el("button", {
                className: "easel-mode-toggle",
                type: "button",
                onclick: e => { e.stopPropagation(); this.host.canvas.toggleCanvasMode(); }
            });
            viewport.appendChild(this._modeToggle);
            // A fresh button knows nothing; the compare in syncMode must not skip it.
            this._modeState = null;

            this._syncActive();
            this.syncMode();
        }

        // The toggle shows the mode you would go to, and while the frame pick is armed it
        // becomes the cancel. Called by the canvas whenever the mode or the pick changes,
        // and on every board open.
        syncMode() {
            const button = this._modeToggle;
            const canvas = this.host.canvas;
            if (!button || !canvas) return;

            const picking = canvas.picking;
            const infinite = canvas.infinite;
            const state = picking ? "picking" : infinite ? "infinite" : "arc";
            if (state === this._modeState) return;
            this._modeState = state;

            button.replaceChildren(this._icon(ICONS[infinite ? "page" : "infinite"]));
            button.title = picking
                ? "Cancel (Esc)"
                : infinite
                    ? "Arc mode — drag the area to keep at the top of the board, or click for the current view"
                    : "Infinite canvas";
            button.classList.toggle("is-infinite", infinite);
            button.classList.toggle("is-picking", picking);
            button.setAttribute("aria-pressed", infinite ? "true" : "false");
        }

        // Colour and stroke width together: both describe the next mark, and keeping
        // them in one popup means the toolbar stays one row high at any window size.
        _openStylePopup() {
            const Objects = window.ZenEaselObjects;

            const widths = this.el("div", { className: "easel-popup-widths" });
            for (const width of STROKE_WIDTHS) {
                widths.appendChild(this.el("button", {
                    className: `easel-width${width === this.strokeWidth ? " is-active" : ""}`,
                    type: "button",
                    title: `Stroke ${width}px`,
                    onclick: () => { this.closePopup(); this.setStrokeWidth(width); }
                }, [this.el("span", { style: { width: `${width + 6}px`, height: `${width + 6}px` } })]));
            }

            // Whatever is selected wins over the toolbar's remembered default: the panel is about to *change* those objects, so
            // it has to start where they are. A mixed selection has no single answer and falls back to the default.
            const picker = new window.ZenEaselColorPicker({
                color: this._selectionColor() ?? this.color,
                alpha: this._selectionOpacity() ?? this.opacity,
                alphaLabel: "Opacity",
                // The floor is not zero: a fully invisible object is still on the board and still in the way — see OPACITY.
                alphaMin: Math.round(Objects.OPACITY.min * 100),
                alphaStep: Math.round(Objects.OPACITY.step * 100),
                standardRows: Objects.STANDARD_ROWS,
                recents: this.host.canvas ? this.host.canvas.recentColors : [],
                extraRows: [widths],
                onColor: (hex, live) => this.setColor(hex, live),
                onAlpha: (value, live) => this.setOpacity(value, live),
                onRestore: (hex, value) => this.restoreStyle(hex, value)
            });

            this._showPopup(this._colorButton, [picker.element]);
        }

        // Whether Zen's own chrome is dark, which is what the easel's defaults are pitched
        // against. _syncZenColors resolves that once and leaves it on the host; the OS scheme is
        // the fallback for a page with no chrome window to read.
        _themeColor() {
            const ink = this.host.getAttribute("data-easel-chrome-ink");
            const dark = ink
                ? ink === "dark"
                : window.matchMedia("(prefers-color-scheme: dark)").matches;
            return window.ZenEaselObjects.themeColor(dark);
        }

        // The selection's colour, or null when it is empty or disagrees with itself. The wheel
        // opens on this for the same reason the slider opens on the selection's opacity: it is
        // about to change those objects, so it has to start where they already are.
        _selectionColor() {
            const canvas = this.host.canvas;
            if (!canvas || !canvas.selection.size) return null;
            let value = null;
            for (const id of canvas.selection) {
                const obj = canvas._byId(id);
                if (!obj) continue;
                if (value === null) value = obj.color;
                else if (value !== obj.color) return null;
            }
            return value;
        }

        // The selection's opacity, or null when it is empty or disagrees with itself.
        _selectionOpacity() {
            const canvas = this.host.canvas;
            if (!canvas || !canvas.selection.size) return null;
            let value = null;
            for (const id of canvas.selection) {
                const obj = canvas._byId(id);
                if (!obj) continue;
                const opacity = obj.opacity === undefined ? 1 : obj.opacity;
                if (value === null) value = opacity;
                else if (value !== opacity) return null;
            }
            return value;
        }

        // Icons are authored as SVG markup so they stay readable; parsing beats forty
        // createElementNS calls. Same approach zen-library uses for its sidebar icons.
        _icon(inner) {
            const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="easel-icon" fill="currentColor" stroke="currentColor">${inner}</svg>`;
            const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
            const node = parsed.documentElement;
            node.removeAttribute("xmlns");
            return node;
        }

        // Arc's URLInputView is a proper inline field; a prompt is the honest v1 of it, and
        // it keeps the whole feature to one method rather than another floating panel.
        _addWebTile(worldPoint) {
            const Objects = window.ZenEaselObjects;
            const input = { value: "" };
            let ok;
            try {
                ok = Services.prompt.prompt(
                    window, "Add a web tile", "Address:", input, null, { value: false }
                );
            } finally {
                // The prompt takes focus with it; without this the board stops answering
                // keyboard shortcuts afterwards.
                this.host.viewport.focus({ preventScroll: true });
            }
            if (!ok || !input.value.trim()) return;

            // Bare hostnames are what people type. Anything that is still not an acceptable
            // URL after this is rejected by the same gate everything else goes through.
            const typed = input.value.trim();
            const entered = Objects.safeExternalUrl(
                /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`
            );
            if (!entered) {
                this.host.toast("That address cannot be loaded in an easel");
                return;
            }

            // A YouTube watch page becomes its embed player. A watch page in a 560px
            // tile is mostly sidebar, and a good many of them decline to be framed at
            // all — the embed is the part that belongs on a board.
            const embed = Objects.youtubeEmbedUrl(entered);
            const url = embed || entered;

            // A tile that will not load explains itself now rather than by sitting
            // blank. http is fine to store and to open in a tab, but loading it inside
            // an easel is a downgrade the user did not ask for, so live.allow-http
            // gates it — and until now the tile was created anyway and simply failed.
            if (url.startsWith("http://") && !window.ZenEaselUtil.prefs["live.allow-http"]) {
                this.host.toast(
                    "Insecure http:// pages are not loaded in easels — set " +
                    "zen.easel.live.allow-http to change that"
                );
                return;
            }

            const size = Objects.DEFAULT_SIZE.webBrowser;
            const obj = Objects.createObject("webBrowser", {
                x: Math.round(worldPoint.x),
                y: Math.round(worldPoint.y),
                // Titled from what was typed, not from the embed URL it may have become:
                // "youtube.com/embed/dQw4w9WgXcQ" is a worse label than the address the
                // user actually gave.
                webBrowser: { url, title: entered.replace(/^https?:\/\//, "") }
            });
            // A video is 16:9, and nothing more. It used to carry another 28 units for the
            // URL strip the renderer drew across a web tile's top, back when the tile was
            // inset below it; that strip is a floating bar now and the tile is the whole
            // object, so the same arithmetic leaves the player letterboxed. Kept in step
            // with capture-page's _addVideoTile, which is the dropped-link path to the
            // same object.
            //
            // Anything else gets the default card, which is close enough to a page's shape
            // to be a reasonable starting point.
            obj.w = size.w;
            obj.h = embed ? Math.round(size.w * 9 / 16) : size.h;
            this.host.canvas.addObjects([obj]);
        }

        _export(format) {
            this.host.canvas.exportImage(format).catch(e => {
                console.error("[zen-easel] export failed:", e);
                this.host.toast("The easel could not be exported");
            });
        }

        _syncActive() {
            for (const [id, button] of this._buttons) {
                button.classList.toggle("is-active", id === this.active);
            }
            this._syncColorDot();
            this.host.viewport.dataset.tool = this.active;
            // A tool is picked from a keystroke as often as from the button, and neither
            // moves the pointer — so nothing else would tell the canvas that what it is
            // resting on has stopped being something you can pick. Without this, arming the
            // rectangle tool over a web card leaves the hover halo and the floating bar
            // sitting on it, with buttons that no longer answer because a press now goes to
            // the tool. Re-derived rather than cleared, so going back to select restores
            // them just as readily.
            this.host.canvas?.refreshHover();
        }

        // The dot is a preview of the next mark, so it wears all three of the things the
        // button controls: the colour it will be, the width it will be drawn at, and how
        // far through it you will see.
        _syncColorDot() {
            if (!this._colorButton) return;
            const dot = this._colorButton.firstElementChild;
            dot.style.background = window.ZenEaselObjects.colorCss(this.color);
            const size = 10 + this.strokeWidth;
            dot.style.width = `${size}px`;
            dot.style.height = `${size}px`;
            dot.style.opacity = this.opacity < 1 ? String(this.opacity) : "";
        }

        /* -------------------------------------------------------------- popups */

        // A client rect with the entry animation held off. Every panel here opens on a
        // keyframe that starts from a transform — easel-rise from translateY(8px) scale(0.97),
        // easel-pop from scale(0.94) — and `both` applies that the moment the element is
        // styled, so a rect read at insertion is of a box that is smaller and lower than the
        // one that will settle. Every clamp below measures at exactly that moment, and each
        // was under-correcting by its share of the transform. Clearing the override afterwards
        // starts the animation from the position that was actually chosen.
        //
        // Only the panel's own box needs this. An anchor inside a menu is measured on a click,
        // by which time that menu's 130ms is long over.
        _measure(element) {
            element.style.animation = "none";
            const rect = element.getBoundingClientRect();
            element.style.animation = "";
            return rect;
        }

        // Anchored above the toolbar. The toolbar is the positioned ancestor, so this
        // needs no viewport-relative coordinates of its own.
        _showPopup(anchor, children) {
            const wasOpen = this._popup && this._popup.anchor === anchor;
            this.closePopup();
            if (wasOpen) return;

            const popup = this.el("div", { className: "easel-popup" }, children);
            anchor.parentNode.appendChild(popup);
            popup.style.left = `${anchor.offsetLeft}px`;

            // Clamped against the viewport, not against the offset parent: the toolbar is only as
            // wide as its buttons and overflows visibly, so clamping to it would shove a wide
            // panel left at every window size. Measured in page coordinates, then converted back
            // to the toolbar-relative left the popup is actually positioned in.
            const bounds = this.host.viewport.getBoundingClientRect();
            const rect = this._measure(popup);
            const overflow = rect.right - (bounds.right - 8);
            if (overflow > 0) {
                const parentLeft = anchor.parentNode.getBoundingClientRect().left;
                popup.style.left = `${Math.max(bounds.left + 8 - parentLeft, anchor.offsetLeft - overflow)}px`;
            }

            // And vertically. The stylesheet opens these upward from a toolbar pinned near the
            // bottom edge, which was fine for three short rows; the colour panel is a wheel
            // plus five, and in a short window — or a narrow split — its top ran off the
            // viewport. Pushed back down by however much it overshot, still measured against
            // the viewport rather than the toolbar.
            const above = (bounds.top + 8) - rect.top;
            if (above > 0) {
                const parentBottom = anchor.parentNode.getBoundingClientRect().bottom;
                const bottom = parseFloat(window.getComputedStyle(popup).bottom) || 0;
                // Never below the viewport's own floor. .easel-color-panel caps its own height
                // against the window, so this only has to catch what that cap cannot.
                popup.style.bottom = `${Math.max(parentBottom - bounds.bottom + 8, bottom - above)}px`;
            }

            this._popup = { element: popup, anchor };
            anchor.classList.add("is-open");
            this.host.chromeChanged();
            this.host.shadowRoot.addEventListener("pointerdown", this._onDocPointerDown, true);
        }

        closePopup() {
            if (!this._popup) return;
            // A slider's `change` and a wheel's `pointerup` never arrive if the popup goes away
            // under the gesture (Escape, a tool shortcut, switching easel), which would leave
            // the canvas holding an open mutation. This is the one place every route out passes
            // through, and both are no-ops unless a drag really was in flight.
            this.host.canvas?.endOpacityDrag();
            this.host.canvas?.endColorDrag();
            this._popup.element.remove();
            this._popup.anchor.classList.remove("is-open");
            this._popup = null;
            this.host.chromeChanged();
            if (!this._menu) {
                this.host.shadowRoot.removeEventListener("pointerdown", this._onDocPointerDown, true);
            }
        }

        /* ------------------------------------------------------------ tool state */

        setActive(id) {
            // Text and image are actions rather than modes — picking either does the
            // thing straight away instead of arming a tool and waiting for a second
            // click on the board. For the image button that second click was pure
            // friction: there is nothing to aim, because the picker is a dialog and the
            // file lands in the middle of the view either way.
            if (id === "text") {
                this.active = "pointer";
                this._syncActive();
                this.host.canvas.placeTextBox();
                return;
            }
            if (id === "image") {
                this.active = "pointer";
                this._syncActive();
                // Refusals are toasted inside _addFile; this catch is for the picker itself.
                this.host.capture.pickFile().catch(err => {
                    console.error("[zen-easel]", err);
                    this.host.toast(err && err.message ? err.message : "Could not add that file");
                });
                return;
            }
            this.active = id;
            this._syncActive();
            this.host.viewport.focus({ preventScroll: true });
        }

        // The picker sets the colour for what you draw next AND repaints whatever is
        // selected. It used to only do the former, because a freshly drawn object stayed
        // selected and a swatch click would silently repaint the thing you had just
        // finished. That is no longer true — _finishCreated commits with select:false —
        // so the swatch can mean the obvious thing, and recolouring no longer has to be
        // hunted for in the context menu.
        //
        // `live` is the wheel being dragged, and behaves as it does in setOpacity below: only
        // the dot is repainted, and focus is left where it is rather than being pulled back to
        // the board mid-gesture — which would also empty the hex field the moment you touched
        // the wheel.
        setColor(color, live = false) {
            this.color = color;
            this.host.canvas.setSelectionColor(color, live);
            if (live) {
                this._syncColorDot();
                return;
            }
            this._syncActive();
            this.host.viewport.focus({ preventScroll: true });
        }

        // The slider's counterpart to setColor. Two differences, both from it being a
        // drag rather than a click: focus is left where it is (pulling it back to the
        // board mid-drag would end the gesture the pointer is still making), and `live`
        // is passed straight through so the canvas can keep one undo entry open.
        setOpacity(opacity, live = false) {
            this.opacity = window.ZenEaselObjects.clampOpacity(opacity);
            this.host.canvas.setSelectionOpacity(this.opacity, live);
            // Only the dot is repainted while the thumb is moving. A full _syncActive
            // rewrites nine buttons' active classes and the viewport's tool dataset, none
            // of which depend on the opacity, and this runs on every pointermove.
            this._syncColorDot();
            if (!live) this.host.viewport.focus({ preventScroll: true });
        }

        // Both halves of a favourite, through one mutation. Going via setColor and setOpacity
        // put two entries on the undo stack for a single click, the first of them a look that
        // was half the old colour and half the new opacity. The board's own panel folds the
        // same pair into one setBackground; setSelectionStyle is the objects' version of that.
        restoreStyle(color, opacity) {
            this.color = color;
            this.opacity = window.ZenEaselObjects.clampOpacity(opacity);
            this.host.canvas.setSelectionStyle(this.color, this.opacity);
            this._syncActive();
            this.host.viewport.focus({ preventScroll: true });
        }

        setStrokeWidth(width) {
            this.strokeWidth = width;
            this.host.canvas.setSelectionStroke(width);
            this._syncActive();
            this.host.viewport.focus({ preventScroll: true });
        }

        // Called by the canvas once a drawn object is committed. The pen stays armed
        // for continuous sketching; everything else drops back to the pointer so the
        // new object can be moved immediately.
        afterCreate() {
            if (this.active !== "pen") this.setActive("pointer");
        }

        handleShortcutKey(e) {
            const tool = TOOLS.find(t => t.key === e.code);
            if (tool) {
                this.setActive(tool.id);
                return true;
            }

            const index = DIGIT_CODES.indexOf(e.code);
            if (index !== -1) {
                this.setColor(window.ZenEaselObjects.STANDARD_ROWS[0][index].key);
                return true;
            }
            return false;
        }

        /* ---------------------------------------------------------- context menu */

        showContextMenu(screenPoint, hit, worldPoint) {
            this.closeMenu();

            const canvas = this.host.canvas;
            const items = [];

            // What the object items below act on. Normally the selection, because
            // right-clicking an unselected object selects it first — but a locked object is
            // never selected, so for one of those the menu speaks for the object it was
            // opened on and nothing else. Right-click is the only way to reach a locked
            // object at all, so this is the list every item there has to use.
            const locked = !!(hit && hit.locked);
            const targets = locked ? [hit.id] : [...canvas.selection];

            if (hit) {
                if (hit.type === "webcard" && hit.webcard.url) {
                    const live = this.host.live;
                    // Only offered on cards captured with the geometry to support it. An
                    // older card has no crop recorded, so there is nothing to be live
                    // *about* — saying so by omission beats an item that fails on click.
                    if (live && live.isLive(hit.id)) {
                        items.push({
                            label: "Show screenshot instead",
                            action: () => live.makeStatic(hit)
                        });
                    } else if (live && live.canGoLive(hit)) {
                        items.push({
                            label: "Show live website",
                            action: () => live.requestLive(hit).catch(e => {
                                console.error("[zen-easel] could not go live:", e);
                                this.host.toast("This card could not be made live");
                            })
                        });
                    }
                    this._pushMuteItem(items, hit);
                    items.push({ label: "Open source page", action: () => this.host.capture.openWebcard(hit) });
                    items.push({
                        label: "Copy source link",
                        action: () => this._copyText(hit.webcard.url)
                    });
                    items.push({ separator: true });
                }

                // The same pair for a web tile. It has no screenshot to go back to, so the
                // wording is about the site rather than the picture — and unlike a webcard
                // this is not a convenience: a running web tile can only be stopped from
                // here or from the floating bar's pause control.
                if (hit.type === "webBrowser" && hit.webBrowser.url) {
                    const live = this.host.live;
                    if (live && live.isLive(hit.id)) {
                        items.push({
                            label: "Stop this web tile",
                            action: () => live.makeStatic(hit)
                        });
                    } else if (live && live.canGoLive(hit)) {
                        items.push({
                            label: "Load this web tile",
                            action: () => live.requestLive(hit).catch(e => {
                                console.error("[zen-easel] could not load the tile:", e);
                                this.host.toast("This web tile could not be loaded");
                            })
                        });
                    }
                    this._pushMuteItem(items, hit);
                    items.push({
                        label: "Copy link",
                        action: () => this._copyText(hit.webBrowser.url)
                    });
                    items.push({ separator: true });
                }
                // Playback from the menu as well as the glyph: the one route that works
                // with the glyph covered, or on a card too small to carry it.
                if (hit.type === "media" && this.host.media) {
                    const media = this.host.media;
                    items.push({
                        label: media.isPlaying(hit.id) ? "Pause" : "Play",
                        action: () => media.toggle(hit.id)
                    });
                    if (hit.media.path) {
                        items.push({
                            label: "Show in folder",
                            action: () => this.host.capture.revealFile(hit)
                        });
                    }
                    items.push({ separator: true });
                }
                if (hit.type === "file") {
                    const pdf = /\.pdf$/i.test(hit.file.title || hit.file.asset || "");
                    items.push({
                        label: pdf ? "Open PDF" : "Open file",
                        action: () => this.host.capture.openFile(hit, null)
                    });
                    if (window.ZenEaselObjects.isFileLinked(hit)) {
                        items.push({
                            label: "Show in folder",
                            action: () => this.host.capture.revealFile(hit)
                        });
                    }
                    items.push({ separator: true });
                }
                // Arc's updateTitleObject(_:). Offered on any text box that is not already
                // the heading, which is how a deleted heading is put back.
                if (hit.type === "text" && canvas.doc && hit.id !== canvas.doc.titleObjectId) {
                    items.push({
                        label: "Use as easel title",
                        action: () => canvas.useAsTitle(hit)
                    });
                    items.push({ separator: true });
                }
                items.push({ label: "Duplicate", hint: "Ctrl+D", action: () => canvas.duplicateObjects(targets) });
                items.push({ label: "Copy", hint: "Ctrl+C", action: () => canvas.copyObjects(targets) });
                items.push({ separator: true });
                items.push({ label: "Bring to front", hint: "Ctrl+]", action: () => canvas.reorderObjects(targets, 1) });
                items.push({ label: "Send to back", hint: "Ctrl+[", action: () => canvas.reorderObjects(targets, -1) });
                items.push({ separator: true });
                // No shortcut hint, and deliberately no keystroke behind it. A key that
                // locks would be a key that makes the thing you just pressed it on stop
                // answering the pointer, with nothing on screen to say why; the menu is
                // where you find locking and the menu is where you undo it.
                items.push({
                    label: locked ? "Unlock" : "Lock",
                    action: () => canvas.setLocked(targets, !locked)
                });
                items.push({ separator: true });
                items.push({
                    label: "Delete", danger: true, hint: "Del",
                    action: () => canvas.removeObjects(targets)
                });
            } else {
                items.push({
                    label: "Paste here", hint: "Ctrl+V",
                    // canPaste, not _clipboard.length: the system clipboard is a source now
                    // too, so an image copied from a tab must not leave this greyed out.
                    disabled: !canvas.canPaste(),
                    action: () => canvas.pasteFromClipboard(worldPoint)
                        .catch(e => console.error("[zen-easel] paste failed:", e))
                });
                items.push({ label: "Select all", hint: "Ctrl+A", action: () => canvas.selectAll() });
                items.push({ separator: true });
                // Arc's webBrowser object — a live site embedded in the board rather than a
                // screenshot of one.
                items.push({
                    label: "Add a web tile…",
                    action: () => this._addWebTile(worldPoint)
                });
                items.push({ separator: true });
                // With the topbar off there is no switcher, so this is the only way left to
                // reach another board, or to make and delete one.
                if (this.host.topbarHidden) {
                    items.push({
                        label: "Easels",
                        submenu: true,
                        action: anchor => this._openEaselPanel(anchor)
                    });
                    items.push({ separator: true });
                }
                // The board's own colour, in the same wheel the toolbar uses. A submenu rather than a swatch strip because the
                // board is no longer a choice from nine presets, and because the toolbar has no control for it.
                items.push({
                    label: "Background",
                    submenu: true,
                    action: anchor => this._openBackgroundPanel(anchor)
                });
                items.push({ separator: true });
                // No canvas-mode item: Arc mode always fits the board to the window now, and
                // the infinite canvas is the toggle in the viewport's top-right corner.
                items.push({ label: "Zoom to fit", hint: "Ctrl+1", action: () => canvas.zoomToFit() });
                items.push({ label: "Reset zoom", hint: "Ctrl+0", action: () => canvas.resetZoom() });
                items.push({ separator: true });
                items.push({
                    label: "Export as PNG…", hint: "Ctrl+Shift+S",
                    action: () => this._export("png")
                });
                items.push({ label: "Export as JPEG…", action: () => this._export("jpeg") });
            }

            const menu = this.el("div", {
                className: "easel-menu",
                style: { left: `${screenPoint.x}px`, top: `${screenPoint.y}px` }
            });

            for (const item of items) {
                if (item.separator) {
                    menu.appendChild(this.el("div", { className: "easel-menu-separator" }));
                    continue;
                }
                const button = this.el("button", {
                    className: `easel-menu-item${item.danger ? " is-danger" : ""}` +
                        `${item.checked ? " is-checked" : ""}`,
                    type: "button",
                    disabled: item.disabled ? "true" : undefined,
                    // A submenu keeps its menu standing — the panel it opens is a branch of this
                    // one, and dismissing the parent would take the flyout with it.
                    onclick: () => {
                        if (item.disabled) return;
                        if (item.submenu) {
                            item.action(button);
                            return;
                        }
                        this.closeMenu();
                        item.action();
                    }
                }, [
                    this.el("span", { className: "easel-menu-label", textContent: item.label }),
                    // A tick occupies the same slot as a shortcut hint: an item never has
                    // both, and sharing the slot keeps every row the same shape.
                    item.checked
                        ? this.el("span", { className: "easel-menu-hint", textContent: "✓" })
                        : item.submenu
                            ? this.el("span", { className: "easel-menu-hint", textContent: "›" })
                            : item.hint
                                ? this.el("span", { className: "easel-menu-hint", textContent: item.hint })
                                : null
                ]);
                menu.appendChild(button);
            }

            this.menuLayer.appendChild(menu);
            this._menu = menu;

            // Keep the menu inside the overlay when opened near an edge. Measured with the
            // animation held off for the same reason the popup is — see _measure.
            const layerRect = this.menuLayer.getBoundingClientRect();
            const menuRect = this._measure(menu);
            if (menuRect.right > layerRect.right) {
                menu.style.left = `${Math.max(0, screenPoint.x - menuRect.width)}px`;
            }
            if (menuRect.bottom > layerRect.bottom) {
                menu.style.top = `${Math.max(0, screenPoint.y - menuRect.height)}px`;
            }

            // A live tile is a <browser> in the browser window, above this page's whole
            // content area, so nothing drawn in here can be on top of one — right-
            // clicking a live card put the menu behind the website. The menu cannot be
            // raised, so any tile it covers is hidden until the menu closes and the
            // canvas paints that card's screenshot again in the meantime.
            //
            // Read after the clamping above, so it is the menu's final position.
            this._suppressUnderMenu();

            // Capture phase: the canvas' own pointerdown would otherwise start a
            // marquee behind the menu before the menu ever saw the click.
            this.host.shadowRoot.addEventListener("pointerdown", this._onDocPointerDown, true);
        }

        // Hides any live tile the menu is standing on. Its own method because releaseSuppressed
        // is all-or-nothing, so closing a flyout has to put this back — see _closeFlyout.
        //
        // offsetWidth/Height rather than a client rect: this runs while the menu is still
        // animating up from scale(0.94), and the layout metrics ignore that transform where a
        // rect would report the shrunk box and leave a strip of the tile showing.
        _suppressUnderMenu() {
            if (!this._menu) return;
            this.host.live?.suppressOverlapping({
                x: parseFloat(this._menu.style.left) || 0,
                y: parseFloat(this._menu.style.top) || 0,
                w: this._menu.offsetWidth,
                h: this._menu.offsetHeight
            });
        }

        // The board's colour, in the same panel the toolbar uses. Opacity here is the board's own
        // alpha over Zen's window: 100% is a solid board, 0% is one that declines to tint at all.
        _openBackgroundPanel(anchor) {
            const Objects = window.ZenEaselObjects;
            const canvas = this.host.canvas;
            const custom = Objects.parseCustomBackground(canvas.background);
            const preset = Objects.backgroundPreset(canvas.background);

            // The wheel opens on the board that is actually in force, so reopening this panel
            // after picking a preset shows that preset rather than a neutral. Presets carry an
            // opaque `swatch` for exactly this. The two that have no colour of their own —
            // "theme" and "transparent" — fall through to the Zen default, which is also what a
            // brand new easel is sitting on.
            const color = custom ? custom.color
                : Objects.normalizeColor(preset && preset.swatch) || this._themeColor();

            // A preset's own alpha, where it has one. The two boards with no colour of their
            // own have none either, and open fully opaque.
            //
            // Zero counts as "none": "theme" reports null because its css is empty, but
            // "transparent" reports 0, and taking that literally opened the panel with the
            // slider on the floor — every wheel drag then wrote a fully transparent custom
            // board and the wheel appeared to do nothing at all.
            // Named apart from objects.uc.js' own alphaOf, which takes a css string rather than a preset.
            const presetAlpha = p => ((p && p.alpha) || Objects.DEFAULT_BG_ALPHA);

            let alpha = custom ? custom.alpha : presetAlpha(preset);
            let picked = custom ? custom.color : null;

            const setBoard = (hex, value, live) => {
                alpha = value;
                picked = hex;
                canvas.setBackground(Objects.customBackground(hex, value), live);
            };

            // The Standard row matches on the background key, so it has to be told after every
            // apply — picking a colour turns the board custom and should clear the preset's
            // ring. On live frames too: the ring belongs to a board that stopped being in force
            // on the drag's first move, and leaving it lit until release says otherwise.
            //
            // syncStandard rather than sync: this runs on every pointermove of a wheel drag, and
            // the full re-seed would repaint a panel the wheel had already repainted.
            const reflect = () => picker.syncStandard(canvas.background);

            const picker = new window.ZenEaselColorPicker({
                color,
                alpha,
                alphaLabel: "Opacity",
                standardRows: [Objects.BACKGROUNDS],
                standardCurrent: canvas.background,
                recents: canvas.recentColors,
                // The alpha counterpart of the lift in _wheelTo: a board at zero opacity has
                // nothing for a hue to be visible in, so reaching for the wheel is the moment
                // to give it some — otherwise the drag paints an invisible board and the wheel
                // looks broken. Reached by reopening the panel on a board the slider was
                // deliberately dragged to nothing; the slider moves with it so the panel never
                // reports an opacity the board is not on.
                onColor: (hex, live) => {
                    if (!alpha) picker.sync({ alpha: Objects.DEFAULT_BG_ALPHA });
                    setBoard(hex, alpha || Objects.DEFAULT_BG_ALPHA, live);
                    reflect();
                },
                onAlpha: (value, live) => { setBoard(picker.color, value, live); reflect(); },
                // One call, so restoring a favourite is a single undo step rather than a colour
                // change followed by an opacity change through a board nobody chose.
                onRestore: (hex, value) => { setBoard(hex, value, false); reflect(); },
                // A named board is a whole board rather than a colour — it carries an alpha too —
                // so the panel is re-seeded from what actually landed. Nothing about it belongs
                // in recents, which is why `picked` is cleared rather than set.
                onPreset: key => {
                    picked = null;
                    canvas.setBackground(key);
                    const applied = Objects.backgroundPreset(canvas.background);
                    alpha = presetAlpha(applied);
                    picker.sync({
                        color: Objects.normalizeColor(applied && applied.swatch) || this._themeColor(),
                        alpha,
                        standardCurrent: canvas.background
                    });
                }
            });

            // Recorded when the panel closes rather than on every commit: a slider release is not
            // a colour anyone chose, and one session would otherwise fill the whole row.
            this._showFlyout(anchor, picker.element, () => {
                if (picked) canvas._noteRecentColor(picked);
            });
        }

        // The topbar's switcher, rehoused in the menu for when that bar is turned off.
        _openEaselPanel(anchor) {
            this._showFlyout(anchor, this.host.library.buildPicker(() => this.closeMenu()));
        }

        // A panel branching off a menu item. Positioned in the menu layer beside the item, and
        // clamped to it the way the menu itself is.
        _showFlyout(anchor, element, onClose) {
            this._closeFlyout();

            const flyout = this.el("div", { className: "easel-popup is-flyout" }, [element]);
            this.menuLayer.appendChild(flyout);
            this._flyout = flyout;
            this._flyoutClose = onClose;

            const layerRect = this.menuLayer.getBoundingClientRect();
            const anchorRect = anchor.getBoundingClientRect();
            // Layout metrics, not a rect: this is measured while the flyout is still at
            // scale(0.94), and a width 6% short is enough to keep it on the right when it does
            // not fit there — see _measure.
            const width = flyout.offsetWidth;
            const height = flyout.offsetHeight;

            let left = anchorRect.right - layerRect.left + 6;
            if (left + width > layerRect.width) {
                left = Math.max(0, anchorRect.left - layerRect.left - width - 6);
            }
            const top = Math.max(0, Math.min(
                anchorRect.top - layerRect.top,
                layerRect.height - height
            ));

            flyout.style.left = `${left}px`;
            flyout.style.top = `${top}px`;

            // A second call, not a merged rect: suppressOverlapping accumulates, and the menu
            // has already registered its own.
            this.host.live?.suppressOverlapping({ x: left, y: top, w: width, h: height });
        }

        _closeFlyout() {
            if (!this._flyout) return;
            // The wheel's pointerup never arrives if the flyout goes away under the drag, so the
            // gesture is closed out before anything reads the value it settled on.
            this.host.canvas?.endBackgroundDrag();
            this._flyout.remove();
            this._flyout = null;

            // The flyout's own suppression rect goes with it. releaseSuppressed is all-or-
            // nothing, so the menu's is re-registered straight after: without the release, a
            // tile the flyout covered stayed hidden until the whole menu closed; without the
            // re-register, one the menu is still standing on would come back too early.
            // Skipped when the menu is on its way out, which clears _menu before calling here.
            if (this._menu) {
                this.host.live?.releaseSuppressed();
                this._suppressUnderMenu();
            }

            const done = this._flyoutClose;
            this._flyoutClose = null;
            if (done) done();
        }

        _onDocPointerDown(e) {
            if (this._popup && !this._popup.element.contains(e.target) && !this._popup.anchor.contains(e.target)) {
                this.closePopup();
            }
            // The flyout is part of the menu, so a click inside it is a click inside the menu.
            if (this._menu && !this._menu.contains(e.target) &&
                !(this._flyout && this._flyout.contains(e.target))) {
                this.closeMenu();
                e.preventDefault();
                e.stopPropagation();
            }
        }

        closeMenu() {
            if (!this._menu) return;
            const menu = this._menu;
            // Cleared before the flyout, so _closeFlyout does not re-register a suppression
            // rect for a menu that is about to be removed — and so a row handler calling back
            // in here through its dismiss() finds nothing left to close.
            this._menu = null;
            this._closeFlyout();
            menu.remove();
            // Whatever the menu was covering comes back.
            this.host.live?.releaseSuppressed();
            if (!this._popup) {
                this.host.shadowRoot.removeEventListener("pointerdown", this._onDocPointerDown, true);
            }
        }

        // Offered on both card types, and only where it can do anything. A tile that is
        // running off-screen keeps its audio by default, so this is the per-card override
        // for the one that turns out to be noisy — and the card has no tab in the tab
        // strip, so there is nowhere else this could live.
        _pushMuteItem(items, hit) {
            const live = this.host.live;
            if (!live || !live.canGoLive(hit)) return;
            const muted = live.isMuted(hit);
            items.push({
                label: muted ? "Unmute this card" : "Mute this card",
                action: () => live.setMuted(hit, !muted)
            });
        }

        _copyText(text) {
            try {
                Cc["@mozilla.org/widget/clipboardhelper;1"]
                    .getService(Ci.nsIClipboardHelper)
                    .copyString(text);
            } catch (e) {
                console.error("[zen-easel] clipboard copy failed:", e);
            }
        }

        destroy() {
            this.closeMenu();
            this.closePopup();
        }
    }

    window.ZenEaselTools = ZenEaselTools;
})();
