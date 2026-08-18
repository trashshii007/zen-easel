// Zen Easel — toolbar, palette and tool state.
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
        image: '<rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke-width="1.8"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4.5 17.5 L9.5 12.5 L13 15.5 L16 13 L19.5 16.5" fill="none" stroke-width="1.8" stroke-linejoin="round"/>'
    };

    // Order follows Arc's own easel toolbar: pointer, image, text, then shapes, then
    // the pen. Shortcut keys are unchanged — only the display order moved.
    const TOOLS = [
        { id: "pointer", label: "Select", key: "KeyV" },
        { id: "image", label: "Image", key: "KeyI" },
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

    // Number-row order matching the palette: 1..9 then 0 for the tenth colour.
    const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5",
        "Digit6", "Digit7", "Digit8", "Digit9", "Digit0"];

    class ZenEaselTools {
        constructor(host, root, menuLayer) {
            this.host = host;
            this.root = root;              // nav.easel-toolbar
            this.menuLayer = menuLayer;    // div.easel-menu-layer
            this.el = window.ZenEaselUtil.el;

            this.active = "pointer";
            this.color = "black";
            this.strokeWidth = 8;
            // Whether a newly drawn shape is a solid block or an outline. Set from the
            // floating shape controls, the way fontSize is set from the text ones.
            this.shapeFilled = false;
            // Arc's Body size. A text box on a 3600px-wide board at fit-width zoom is
            // being read at roughly half size, so the old 24 landed at about 11px on
            // screen — legible, but nothing like the confident lettering Arc's easels
            // have.
            this.fontSize = 32;
            this.fontFamily = "system";

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

            // A single swatch that opens the palette, rather than ten inline circles.
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

            this._syncActive();
        }

        // Palette and stroke width together: both describe the next mark, and keeping
        // them in one popup means the toolbar stays one row high at any window size.
        _openStylePopup() {
            const Objects = window.ZenEaselObjects;
            const swatches = this.el("div", { className: "easel-popup-swatches" });
            for (const color of Objects.PALETTE) {
                swatches.appendChild(this.el("button", {
                    className: `easel-swatch${color.key === this.color ? " is-active" : ""}`,
                    type: "button",
                    title: color.label,
                    style: { "--swatch": color.css },
                    onclick: () => { this.closePopup(); this.setColor(color.key); }
                }));
            }

            const widths = this.el("div", { className: "easel-popup-widths" });
            for (const width of STROKE_WIDTHS) {
                widths.appendChild(this.el("button", {
                    className: `easel-width${width === this.strokeWidth ? " is-active" : ""}`,
                    type: "button",
                    title: `Stroke ${width}px`,
                    onclick: () => { this.closePopup(); this.setStrokeWidth(width); }
                }, [this.el("span", { style: { width: `${width + 6}px`, height: `${width + 6}px` } })]));
            }

            this._showPopup(this._colorButton, [swatches, widths]);
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
            // A video is 16:9. Anything else gets the default card, which is close
            // enough to a page's shape to be a reasonable starting point.
            obj.w = size.w;
            obj.h = embed ? Math.round(size.w * 9 / 16) + 28 : size.h;
            this.host.canvas.addObjects([obj]);
        }

        _export(format) {
            this.host.canvas.exportImage(format).catch(e => {
                console.error("[zen-easel] export failed:", e);
                this.host.toast("The easel could not be exported");
            });
        }

        // The toolbar's colour dot resolves through the active palette, so it has to be
        // repainted when the board switches palette even though this.color has not changed.
        syncPalette() {
            this.closePopup();
            this._syncActive();
        }

        _syncActive() {
            for (const [id, button] of this._buttons) {
                button.classList.toggle("is-active", id === this.active);
            }
            if (this._colorButton) {
                const dot = this._colorButton.firstElementChild;
                dot.style.background = window.ZenEaselObjects.colorCss(this.color);
                // The stroke width is shown as the size of the dot, so the one button
                // reports both things it controls.
                const size = 10 + this.strokeWidth;
                dot.style.width = `${size}px`;
                dot.style.height = `${size}px`;
            }
            this.host.viewport.dataset.tool = this.active;
        }

        /* -------------------------------------------------------------- popups */

        // Anchored above the toolbar. The toolbar is the positioned ancestor, so this
        // needs no viewport-relative coordinates of its own.
        _showPopup(anchor, children) {
            const wasOpen = this._popup && this._popup.anchor === anchor;
            this.closePopup();
            if (wasOpen) return;

            const popup = this.el("div", { className: "easel-popup" }, children);
            anchor.parentNode.appendChild(popup);
            popup.style.left = `${anchor.offsetLeft}px`;

            this._popup = { element: popup, anchor };
            anchor.classList.add("is-open");
            this.host.shadowRoot.addEventListener("pointerdown", this._onDocPointerDown, true);
        }

        closePopup() {
            if (!this._popup) return;
            this._popup.element.remove();
            this._popup.anchor.classList.remove("is-open");
            this._popup = null;
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
                this.host.capture.pickImageFile().catch(err => {
                    console.error("[zen-easel]", err);
                    // An unsupported file type is a decision the user made and needs to
                    // hear about; failing silently just looks like the picker did nothing.
                    this.host.toast(err && err.message ? err.message : "Could not add that image");
                });
                return;
            }
            this.active = id;
            this._syncActive();
            this.host.viewport.focus({ preventScroll: true });
        }

        // The palette sets the colour for what you draw next AND repaints whatever is
        // selected. It used to only do the former, because a freshly drawn object stayed
        // selected and a swatch click would silently repaint the thing you had just
        // finished. That is no longer true — _finishCreated commits with select:false —
        // so the swatch can mean the obvious thing, and recolouring no longer has to be
        // hunted for in the context menu.
        setColor(key) {
            this.color = key;
            this.host.canvas.setSelectionColor(key);
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
                this.setColor(window.ZenEaselObjects.PALETTE[index].key);
                return true;
            }
            return false;
        }

        /* ---------------------------------------------------------- context menu */

        showContextMenu(screenPoint, hit, worldPoint) {
            this.closeMenu();

            const canvas = this.host.canvas;
            const items = [];

            // A swatch strip for the board background, on empty canvas only. Object
            // colours used to have a strip here too; they have moved back to the
            // toolbar palette, which now repaints the selection, so a second way to do
            // the same thing would only be somewhere else to look for it. The board
            // background stays because the toolbar has no control for it.
            if (!hit) {
                items.push({
                    swatches: window.ZenEaselObjects.BACKGROUNDS,
                    current: canvas.background,
                    onPick: key => canvas.setBackground(key)
                });
                items.push({ separator: true });
            }

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
                    items.push({ label: "Open source page", action: () => this.host.capture.openWebcard(hit) });
                    items.push({
                        label: "Copy source link",
                        action: () => this._copyText(hit.webcard.url)
                    });
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
                items.push({ label: "Duplicate", hint: "Ctrl+D", action: () => canvas.duplicateSelection() });
                items.push({ label: "Copy", hint: "Ctrl+C", action: () => canvas.copySelection() });
                items.push({ separator: true });
                items.push({ label: "Bring to front", hint: "Ctrl+]", action: () => canvas.reorderSelection(1) });
                items.push({ label: "Send to back", hint: "Ctrl+[", action: () => canvas.reorderSelection(-1) });
                items.push({ separator: true });
                items.push({
                    label: "Delete", danger: true, hint: "Del",
                    action: () => canvas.removeObjects([...canvas.selection])
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
                // Arc stores the palette on the document, so it is a property of the board
                // rather than a preference — two easels can read differently.
                for (const name of window.ZenEaselObjects.PALETTE_NAMES) {
                    items.push({
                        label: `${name[0].toUpperCase()}${name.slice(1)} colours`,
                        checked: canvas.palette === name,
                        action: () => canvas.setPalette(name)
                    });
                }
                items.push({ separator: true });
                // Arc's CanvasMode, per board. Off by default — see the note in
                // canvas.uc.js. Named for what it does rather than for the mechanism:
                // "Reflow with the window" described the implementation and left the
                // choice unreadable, which is most of why the mode went unused.
                items.push({
                    label: "Fit the board to the window",
                    checked: canvas.reflowing,
                    action: () => canvas.setCanvasMode(
                        canvas.reflowing ? "fixed" : "verticallyScrolling"
                    )
                });
                items.push({ separator: true });
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
                if (item.swatches) {
                    menu.appendChild(this._swatchRow(item));
                    continue;
                }
                menu.appendChild(this.el("button", {
                    className: `easel-menu-item${item.danger ? " is-danger" : ""}` +
                        `${item.checked ? " is-checked" : ""}`,
                    type: "button",
                    disabled: item.disabled ? "true" : undefined,
                    onclick: () => {
                        this.closeMenu();
                        if (!item.disabled) item.action();
                    }
                }, [
                    this.el("span", { className: "easel-menu-label", textContent: item.label }),
                    // A tick occupies the same slot as a shortcut hint: an item never has
                    // both, and sharing the slot keeps every row the same shape.
                    item.checked
                        ? this.el("span", { className: "easel-menu-hint", textContent: "✓" })
                        : item.hint
                            ? this.el("span", { className: "easel-menu-hint", textContent: item.hint })
                            : null
                ]));
            }

            this.menuLayer.appendChild(menu);
            this._menu = menu;

            // Keep the menu inside the overlay when opened near an edge.
            const layerRect = this.menuLayer.getBoundingClientRect();
            const menuRect = menu.getBoundingClientRect();
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
            this.host.live?.suppressOverlapping({
                x: parseFloat(menu.style.left) || 0,
                y: parseFloat(menu.style.top) || 0,
                w: menuRect.width,
                h: menuRect.height
            });

            // Capture phase: the canvas' own pointerdown would otherwise start a
            // marquee behind the menu before the menu ever saw the click.
            this.host.shadowRoot.addEventListener("pointerdown", this._onDocPointerDown, true);
        }

        // A row of round swatches. Used for both palettes; the only difference is what
        // onPick does. The "follow theme" background has no colour of its own, so it is
        // drawn as a split light/dark disc rather than a flat fill.
        //
        // `swatch` before `css`: board backgrounds are tints, and an 18px disc filled at
        // half alpha reads as no colour at all — the row would be nine near-identical
        // ghosts. Object colours have no `swatch` and fall through to `css` unchanged.
        _swatchRow({ swatches, current, onPick }) {
            const row = this.el("div", { className: "easel-menu-swatches" });
            for (const entry of swatches) {
                const fill = entry.swatch || entry.css;
                row.appendChild(this.el("button", {
                    className: `easel-menu-swatch${entry.key === current ? " is-active" : ""}${fill ? "" : " is-theme"}`,
                    type: "button",
                    title: entry.label,
                    style: fill ? { "--swatch": fill } : null,
                    onclick: () => {
                        this.closeMenu();
                        onPick(entry.key);
                    }
                }));
            }
            return row;
        }

        _onDocPointerDown(e) {
            if (this._popup && !this._popup.element.contains(e.target) && !this._popup.anchor.contains(e.target)) {
                this.closePopup();
            }
            if (this._menu && !this._menu.contains(e.target)) {
                this.closeMenu();
                e.preventDefault();
                e.stopPropagation();
            }
        }

        closeMenu() {
            if (!this._menu) return;
            this._menu.remove();
            this._menu = null;
            // Whatever the menu was covering comes back.
            this.host.live?.releaseSuppressed();
            if (!this._popup) {
                this.host.shadowRoot.removeEventListener("pointerdown", this._onDocPointerDown, true);
            }
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
