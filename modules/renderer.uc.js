// Zen Easel — canvas renderer.
//
// Replaces the DOM/SVG scene graph. Three canvases, following the split Excalidraw
// uses (StaticCanvas / NewElementCanvas / InteractiveCanvas):
//
//   static   committed objects. Repainted only when the scene or the viewport changes.
//   active   the object currently being drawn or dragged. Repainted every frame,
//            but it holds one object, so a 4000-point stroke never repaints the board.
//   overlay  selection outlines, handles, marquee. Screen space, no world transform.
//
// The split is the whole point: under the old renderer, adding one point to a stroke
// re-laid-out every object on the board.

"use strict";

(function () {
    if (window.ZenEaselRenderer) return;

    const HANDLE_SIZE = 9;
    const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    // The rotate grip floats above the top edge on a short stalk, which is where every
    // canvas tool puts it and is also the only place it cannot be confused with a
    // resize handle. Slightly larger than those, because it has a glyph inside it.
    const ROTATE_HANDLE_SIZE = 13;
    const ROTATE_HANDLE_OFFSET = 24;

    const FONT_DIR = "chrome://sine/content/zen-easel/fonts/";

    // Shared with the text editor overlay. Both have to agree exactly or text shifts
    // when a box is opened for editing.
    const LINE_HEIGHT = 1.35;
    const TEXT_PAD_X = 4;
    const TEXT_PAD_Y = 2;
    // The floating chrome bar: the favicon, title, play/pause and open-link controls that
    // fade in over a card's bottom edge while the pointer is on it. Nothing here is drawn
    // by the canvas — the bar is DOM in the browser window, above the live layer, because
    // a live card's <browser> covers everything this renderer paints. See
    // modules-host/live-host.uc.js. What lives here is only its *geometry*, because the
    // canvas is what hit-tests the clicks: webcardChromeRects() is the single source both
    // sides read.
    const CHROME_BAR_HEIGHT = 34;
    const CHROME_BAR_INSET = 10;
    const CHROME_BUTTON = 24;
    const CHROME_FAVICON = 18;
    const CHROME_GAP = 6;
    const CHROME_PAD = 8;
    // Narrow cards shed parts of the bar rather than losing it: a phone-shaped capture is
    // exactly the case where the controls are least reachable by other means, so dropping
    // the whole bar there was the wrong trade. The title goes first — below this much room
    // it is an ellipsis and nothing else — and then the favicon, leaving a compact pill of
    // just the buttons.
    const CHROME_LABEL_MIN = 36;
    // The floor: a bar with no room for even one button is a strip of tint over a picture,
    // so the card keeps its chrome off entirely and the context menu is the way in.
    const CHROME_MIN_HEIGHT = 64;

    // The hover halo. Held clear of the object's own edge so it still reads around a live
    // card, whose interior belongs to a <browser> drawn above this canvas. See
    // _drawHoverGlow.
    const HOVER_GLOW_OUTSET = 3;
    const HOVER_GLOW_BLUR = 16;

    // Registered through the FontFace API rather than relying on the @font-face rules
    // in chrome.css. Canvas resolves ctx.font against document.fonts, and a face that
    // only exists in an injected stylesheet is not reliably in that set — which shows
    // up as text silently rendering in the fallback family. Excalidraw registers its
    // fonts the same way, for the same reason.
    const FONT_FACES = [
        ["Zen Easel Inter", "Inter-Regular.ttf", { weight: "400" }],
        ["Zen Easel Inter", "Inter-Bold.ttf", { weight: "700" }],
        ["Zen Easel Nunito", "Nunito-Regular.ttf", { weight: "400" }],
        ["Zen Easel Nunito", "Nunito-Bold.ttf", { weight: "700" }],
        ["Zen Easel Nunito", "Nunito-Italic.ttf", { style: "italic" }],
        ["Zen Easel Garamond", "EBGaramond-VariableFont_wght.ttf", { weight: "400 800" }],
        ["Zen Easel Garamond", "EBGaramond-Italic-VariableFont_wght.ttf", { weight: "400 800", style: "italic" }],
        ["Zen Easel Inconsolata", "Inconsolata-Regular.ttf", { weight: "400" }],
        ["Zen Easel Inconsolata", "Inconsolata-Bold.ttf", { weight: "700" }],
        ["Zen Easel Space Mono", "SpaceMono-Regular.ttf", { weight: "400" }],
        ["Zen Easel Space Mono", "SpaceMono-Bold.ttf", { weight: "700" }],
        ["Zen Easel Space Mono", "SpaceMono-Italic.ttf", { style: "italic" }]
    ];

    // Backing stores are allocated in steps of this many layout pixels, and only ever
    // grow while the viewport is moving. See resize().
    const BUFFER_STEP = 128;

    // How much bigger than the viewport a *growing* backing store is made. The point is
    // not the memory, it is that a drag of a split divider stays inside one allocation:
    // this much expansion is already drawn and costs nothing to reveal. Given back by the
    // trim once the size holds still.
    const BUFFER_GROWTH_SLACK = 512;

    // How long the size has to hold still before the slack is given back.
    const BUFFER_TRIM_MS = 250;

    let fontsPromise = null;

    // Resolves once every face is usable. Callers repaint on resolution so the first
    // frame after load is drawn in the real typeface.
    function ensureFonts() {
        if (fontsPromise) return fontsPromise;
        fontsPromise = (async () => {
            const loads = [];
            for (const [family, file, descriptors] of FONT_FACES) {
                try {
                    const face = new FontFace(family, `url("${FONT_DIR}${file}")`, descriptors);
                    document.fonts.add(face);
                    loads.push(face.load().catch(e => {
                        console.error(`[zen-easel] font ${file} failed to load:`, e);
                    }));
                } catch (e) {
                    console.error(`[zen-easel] could not register ${file}:`, e);
                }
            }
            await Promise.all(loads);
        })();
        return fontsPromise;
    }

    class ZenEaselRenderer {
        constructor(host, layers) {
            this.host = host;
            this.Objects = window.ZenEaselObjects;
            this.Freehand = window.ZenEaselFreehand;

            this.staticCanvas = layers.static;
            this.activeCanvas = layers.active;
            this.overlayCanvas = layers.overlay;

            this.staticCtx = this.staticCanvas.getContext("2d");
            this.activeCtx = this.activeCanvas.getContext("2d");
            this.overlayCtx = this.overlayCanvas.getContext("2d");

            this.dpr = 1;
            // The viewport, in layout pixels: what the board is laid out and clamped
            // against, and what decides which objects are on screen.
            this.width = 0;
            this.height = 0;
            // The canvases, which are the same size or larger. See resize().
            this.bufferWidth = 0;
            this.bufferHeight = 0;
            this.bufferDpr = 1;
            this._trimTimer = null;

            // asset name -> HTMLImageElement. Decoding is async; a miss paints a
            // placeholder and repaints when the bitmap lands.
            this._images = new Map();
            // "content|font|size|width" -> string[]. Word wrapping costs a measureText
            // per word, so it is memoised rather than redone every frame.
            this._wrapCache = new Map();
            this._fontsRequested = new Set();
            // object id -> rasterised stroke. See _drawCachedInk.
            this._inkCache = new Map();

            ensureFonts().then(() => {
                this._wrapCache.clear();
                if (this.host.canvas) this.host.canvas.invalidate();
            });
        }

        /* ---------------------------------------------------------------- sizing */

        // Canvases carry a backing store at device resolution and a CSS size in
        // layout pixels. Skipping this is what makes canvas text look soft on HiDPI.
        //
        // Returns null when nothing moved, and otherwise whether the backing stores were
        // replaced — which is the only outcome here that empties them, and so the only one
        // that obliges the caller to repaint. A viewport that merely moved inside the
        // buffer it already has is still looking at a correct picture. See the resize
        // observer in canvas.uc.js.
        resize() {
            const rect = this.staticCanvas.parentNode.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            if (!rect.width || !rect.height) return null;
            if (rect.width === this.width && rect.height === this.height && dpr === this.dpr) {
                return null;
            }

            this.width = rect.width;
            this.height = rect.height;
            this.dpr = dpr;

            // The canvases are allowed to be bigger than the viewport, and while it is
            // moving they only ever grow.
            //
            // Assigning canvas.width reallocates the backing store — three of them, at
            // device resolution, so on a HiDPI board that is tens of megabytes allocated,
            // zeroed and handed to the compositor as new textures. Sized to the rect
            // exactly, that happened on every frame of a drag: the most expensive thing in
            // the resize path by a wide margin, and the only thing in it that throws the
            // pixels already drawn away.
            //
            // Overdrawing instead costs nothing to look at. .easel-viewport is
            // overflow:hidden and the canvases are absolutely positioned at its origin, so
            // the excess is clipped; the board is drawn from that same origin, so the
            // visible pixels are identical either way. Growing in steps means an expanding
            // drag reallocates once every BUFFER_STEP pixels rather than once a frame, and
            // a shrinking one never reallocates at all.
            //
            // Growing takes a wide margin rather than the next step, because the frame that
            // reallocates is the frame that has to repaint, and a repaint during a resize is
            // the one thing that has been observed to flicker. One of them per gesture is a
            // fault you have to be looking for; one per frame is the board strobing. The
            // margin is only paid while the board is being resized — the trim takes it back.
            //
            // Not on the first allocation, where there is no gesture and no previous size to
            // grow from: a board that opens and is never resized holds exactly what it needs.
            //
            // The slack is given back once the size holds still; see _scheduleTrim.
            const slack = this.bufferWidth ? BUFFER_GROWTH_SLACK : 0;
            const width = Math.max(this.bufferWidth, Math.ceil((rect.width + slack) / BUFFER_STEP) * BUFFER_STEP);
            const height = Math.max(this.bufferHeight, Math.ceil((rect.height + slack) / BUFFER_STEP) * BUFFER_STEP);
            let reallocated = false;
            if (width !== this.bufferWidth || height !== this.bufferHeight || dpr !== this.bufferDpr) {
                this._allocate(width, height, dpr);
                reallocated = true;
            }
            this._scheduleTrim();
            return { reallocated };
        }

        // The only place a backing store is assigned, because it is the only operation in
        // the file that destroys what is already drawn: every caller has to be one that
        // repaints immediately afterwards.
        _allocate(width, height, dpr) {
            this.bufferWidth = width;
            this.bufferHeight = height;
            this.bufferDpr = dpr;

            for (const canvas of [this.staticCanvas, this.activeCanvas, this.overlayCanvas]) {
                canvas.width = Math.max(1, Math.round(width * dpr));
                canvas.height = Math.max(1, Math.round(height * dpr));
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
            }
        }

        // A board dragged down to a third of the window would otherwise hold the buffers its
        // full width bought for the life of the tab. Debounced rather than run from resize()
        // so that a drag — where every frame is a new size — never trims, which is the whole
        // point of the buffers only growing.
        _scheduleTrim() {
            if (this._trimTimer) window.clearTimeout(this._trimTimer);
            this._trimTimer = window.setTimeout(() => {
                this._trimTimer = null;
                this._trim();
            }, BUFFER_TRIM_MS);
        }

        _trim() {
            // A snapshot has the buffer fields pointed at its own offscreen bitmap, so
            // reallocating from them would size the canvases to whatever was being exported.
            // Deferred rather than dropped: this is the only thing that ever gives the slack
            // back, and abandoning the one attempt would leave a board that happened to be
            // exporting when the timer fired holding its widest buffers until the next
            // resize — which on a board nobody resizes again is the life of the tab.
            if (this._snapshotting) { this._scheduleTrim(); return; }
            if (!this.width || !this.height) return;
            if (!this.staticCanvas.isConnected) return;

            const width = Math.ceil(this.width / BUFFER_STEP) * BUFFER_STEP;
            const height = Math.ceil(this.height / BUFFER_STEP) * BUFFER_STEP;
            if (width === this.bufferWidth && height === this.bufferHeight) return;

            this._allocate(width, height, this.dpr);
            // Reallocating just emptied all three. Nothing else is going to paint them —
            // this runs from a timer, a quarter of a second after anything last moved — and
            // scheduling the repaint would leave the board blank until the next frame, which
            // is the same one-frame hole the resize observer exists to avoid.
            if (this.host.canvas) this.host.canvas.repaintNow();
        }

        /* -------------------------------------------------------------- snapshot */

        // Paints the whole board into an offscreen bitmap and hands back encoded bytes.
        // Used for the library thumbnail and for export, which differ only in size and
        // format — the framing, the background and the object loop are the same job.
        //
        // The layer canvases are not involved. drawObject already takes a context, so the
        // only thing standing in the way is that width/height/dpr are read as fields by
        // _begin, _viewportBounds and the ink cache; they are swapped for the duration and
        // put back, which is cheaper and far less error-prone than threading them through
        // eight drawing methods.
        async snapshot(objects, {
            maxWidth = 1600, maxHeight = 1600, padding = 48,
            background = null, type = "image/png", quality = 0.92
        } = {}) {
            const box = this.Objects.unionBounds(objects);
            if (!box) return null;

            const worldW = box.w + padding * 2;
            const worldH = box.h + padding * 2;
            const scale = Math.min(maxWidth / worldW, maxHeight / worldH, 1);
            const width = Math.max(1, Math.round(worldW * scale));
            const height = Math.max(1, Math.round(worldH * scale));

            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext("2d");

            const view = {
                zoom: scale,
                panX: (-box.x + padding) * scale,
                panY: (-box.y + padding) * scale
            };

            const saved = {
                width: this.width, height: this.height, dpr: this.dpr,
                bufferWidth: this.bufferWidth, bufferHeight: this.bufferHeight
            };
            this.width = width;
            this.height = height;
            this.dpr = 1;
            // The offscreen bitmap is exactly the size asked for, so for the duration of the
            // snapshot the buffer and the viewport are the same thing — _begin clears
            // against the buffer, and it must not clear beyond the bitmap it was given.
            this.bufferWidth = width;
            this.bufferHeight = height;
            this._snapshotting = true;
            try {
                this._begin(ctx, view);
                if (background) {
                    // Painted in world space, so it has to cover the view rather than the
                    // bitmap: the transform is already applied by _begin.
                    const bounds = this._viewportBounds(view);
                    ctx.fillStyle = background;
                    ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
                }
                for (const obj of objects) this.drawObject(ctx, obj, view);
            } finally {
                this.width = saved.width;
                this.height = saved.height;
                this.dpr = saved.dpr;
                this.bufferWidth = saved.bufferWidth;
                this.bufferHeight = saved.bufferHeight;
                this._snapshotting = false;
            }

            const blob = await canvas.convertToBlob({ type, quality });
            return new Uint8Array(await blob.arrayBuffer());
        }

        _begin(ctx, view) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            // The whole backing store, not the viewport: a buffer can be larger than the
            // board is showing and the excess is only clipped, so clearing to the viewport
            // would leave the previous frame's pixels sitting in it — to be revealed by the
            // next expansion, in the moment before the repaint it schedules has drawn.
            ctx.clearRect(0, 0, this.bufferWidth * this.dpr, this.bufferHeight * this.dpr);
            if (view) {
                const s = view.zoom * this.dpr;
                ctx.setTransform(s, 0, 0, s, view.panX * this.dpr, view.panY * this.dpr);
            } else {
                ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            }
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
        }

        /* ------------------------------------------------------------- culling */

        // World-space rectangle currently on screen, padded so an object whose stroke
        // or shadow overhangs its bounds does not pop in at the edge.
        // The bounds objects are culled against — the *buffer*, not the viewport.
        //
        // The difference is the slack, and drawing into it is the whole reason it exists.
        // A board is drawn from the viewport's origin at a scale a resize does not change,
        // so a canvas drawn out to the buffer's edge stays correct while the viewport moves
        // anywhere inside it: shrinking shows less of it, growing shows more of what is
        // already there. Culled to the viewport instead, the slack would be empty, and every
        // frame of an expanding drag would have to repaint to fill the strip it just
        // revealed — which is the flicker this is here to avoid.
        //
        // The cost is drawing objects that are off screen by up to the slack. On a board
        // where that matters, it is a repaint that already had to walk the object list.
        _viewportBounds(view) {
            const pad = 64 / view.zoom;
            return {
                x: -view.panX / view.zoom - pad,
                y: -view.panY / view.zoom - pad,
                w: this.bufferWidth / view.zoom + pad * 2,
                h: this.bufferHeight / view.zoom + pad * 2
            };
        }

        /* --------------------------------------------------------------- passes */

        renderStatic(objects, view, options = {}) {
            const ctx = this.staticCtx;
            this._begin(ctx, view);

            const bounds = this._viewportBounds(view);
            const skip = options.skip;

            for (const obj of objects) {
                if (skip && skip.has(obj.id)) continue;
                // An animated image is an <img> in the media layer below this canvas,
                // and painting a still frame here would sit underneath it — visible
                // through any transparency, and wrong the moment it moved.
                if (this.isDomRendered(obj)) continue;
                // Culling first: on a large board most objects are off screen, and
                // rejecting them is one rectangle overlap test each.
                if (!this.Objects.intersects(this.Objects.bounds(obj), bounds)) continue;

                // Ink is the expensive case — its outline is recomputed from every
                // sample — so committed strokes are rasterised once and blitted after.
                // Everything else draws fast enough that caching it would cost more in
                // bitmap memory than it saves.
                if (obj.type === "ink" && this._drawCachedInk(ctx, obj, view)) continue;

                this.drawObject(ctx, obj, view);
            }
        }

        // Excalidraw's elementWithCanvasCache idea: rasterise once, redraw as a bitmap
        // until something invalidates it. Keyed by id + geometry + zoom, since a change
        // to any of those changes the pixels. Our objects are plain JSON replaced
        // wholesale on undo, so a Map with an explicit key beats a WeakMap.
        _drawCachedInk(ctx, obj, view) {
            const scale = view.zoom * this.dpr;
            // Every input to the pixels is in the key. Note x/y deliberately are not:
            // the bitmap is rendered relative to the object's own origin, so a move
            // shifts the blit position and reuses the same pixels.
            const key = [
                obj.w, obj.h, obj.ink.points.length, obj.color, obj.ink.strokeWidth,
                window.ZenEaselUtil.prefs["ink-style"], scale.toFixed(3)
            ].join("|");
            let entry = this._inkCache.get(obj.id);

            if (!entry || entry.key !== key) {
                const width = Math.ceil(obj.w * scale);
                const height = Math.ceil(obj.h * scale);
                // Enormous strokes are cheaper to draw directly than to hold as a
                // bitmap; bail and let the normal path handle them.
                if (width < 1 || height < 1 || width * height > 16e6) return false;

                const bitmap = new OffscreenCanvas(width, height);
                const bctx = bitmap.getContext("2d");
                bctx.setTransform(scale, 0, 0, scale, -obj.x * scale, -obj.y * scale);
                bctx.lineJoin = "round";
                bctx.lineCap = "round";
                this._drawInk(bctx, obj);

                entry = { key, bitmap, width, height };
                this._inkCache.set(obj.id, entry);
                this._trimInkCache();
            }

            // The context is in world space; the bitmap is in device pixels, so undo
            // the scale for the blit and put it back afterwards.
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            // Applied to the blit, not baked into the bitmap, and deliberately absent from
            // the cache key: dragging the opacity slider over a board of ink would
            // otherwise re-rasterise every stroke on every frame, to produce pixels that
            // differ only by a constant the compositor can apply for free.
            const opacity = obj.opacity === undefined ? 1 : obj.opacity;
            if (opacity < 1) ctx.globalAlpha = opacity;
            const origin = {
                x: (obj.x * view.zoom + view.panX) * this.dpr,
                y: (obj.y * view.zoom + view.panY) * this.dpr
            };
            ctx.drawImage(entry.bitmap, origin.x, origin.y, entry.width, entry.height);
            ctx.restore();
            return true;
        }

        // Strokes are cached as bitmaps keyed on their colour, so a recolour leaves every one of
        // them painted in the old value. Nothing about the geometry changed, which is exactly why
        // this has to be said explicitly rather than falling out of an invalidation.
        invalidateInkCache() {
            this._inkCache.clear();
        }

        _trimInkCache() {
            if (this._inkCache.size <= 120) return;
            // Insertion-ordered: dropping the oldest quarter approximates an LRU
            // closely enough for a board that is being panned around.
            const drop = Math.ceil(this._inkCache.size / 4);
            let i = 0;
            for (const id of this._inkCache.keys()) {
                if (i++ >= drop) break;
                this._inkCache.delete(id);
            }
        }

        renderActive(objects, view) {
            const ctx = this.activeCtx;
            this._begin(ctx, view);
            if (!objects || !objects.length) return;
            for (const obj of objects) {
                // Same reason as in renderStatic: the media layer is already showing it,
                // and it follows the drag on its own because the layer syncs each frame.
                if (this.isDomRendered(obj)) continue;
                this.drawObject(ctx, obj, view);
            }
        }

        clearActive() {
            const ctx = this.activeCtx;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, this.bufferWidth * this.dpr, this.bufferHeight * this.dpr);
        }

        /* ---------------------------------------------------------- object draw */

        drawObject(ctx, obj, view) {
            ctx.save();
            // Set once here rather than in each _draw* method, for the same reason the
            // rotation is: opacity is a property of the object, not of what it happens to
            // be made of, and a shape, a caption and a capture all have to fade
            // identically. Anything a _draw* method does to globalAlpha afterwards has to
            // multiply into this rather than replace it.
            const opacity = obj.opacity === undefined ? 1 : obj.opacity;
            if (opacity < 1) ctx.globalAlpha = opacity;

            if (obj.rotation) {
                const cx = obj.x + obj.w / 2;
                const cy = obj.y + obj.h / 2;
                ctx.translate(cx, cy);
                ctx.rotate((obj.rotation * Math.PI) / 180);
                ctx.translate(-cx, -cy);
            }

            switch (obj.type) {
                case "shape": this._drawShape(ctx, obj); break;
                case "ink": this._drawInk(ctx, obj); break;
                case "text": this._drawText(ctx, obj); break;
                case "image": this._drawImage(ctx, obj); break;
                case "webcard": this._drawWebcard(ctx, obj); break;
                case "webBrowser": this._drawWebBrowser(ctx, obj); break;
            }
            ctx.restore();
        }

        _drawShape(ctx, obj) {
            const css = this.Objects.colorCss(obj.color);
            const stroke = obj.shape.strokeWidth || 3;
            const inset = stroke / 2;
            const { x, y, w, h } = obj;

            ctx.lineWidth = stroke;
            ctx.strokeStyle = css;
            ctx.fillStyle = css;
            ctx.beginPath();

            switch (obj.shape.kind) {
                case "ellipse":
                    ctx.ellipse(
                        x + w / 2, y + h / 2,
                        Math.max(w / 2 - inset, 0.5), Math.max(h / 2 - inset, 0.5),
                        0, 0, Math.PI * 2
                    );
                    break;

                case "triangle":
                    ctx.moveTo(x + w / 2, y + inset);
                    ctx.lineTo(x + inset, y + h - inset);
                    ctx.lineTo(x + w - inset, y + h - inset);
                    ctx.closePath();
                    break;

                case "line":
                case "arrow": {
                    const [ax, ay] = obj.shape.a, [bx, by] = obj.shape.b;
                    const x1 = x + ax * w, y1 = y + ay * h;
                    const x2 = x + bx * w, y2 = y + by * h;

                    if (obj.shape.kind !== "arrow") {
                        ctx.moveTo(x1, y1);
                        ctx.lineTo(x2, y2);
                        ctx.stroke();
                        return;
                    }

                    const length = Math.hypot(x2 - x1, y2 - y1);
                    if (length < 0.5) return;

                    const ux = (x2 - x1) / length;
                    const uy = (y2 - y1) / length;
                    const head = Math.min(Math.max(stroke * 3.2, 16), length * 0.4);
                    const halfWidth = head * 0.46;

                    // The shaft stops short of the tip. Drawing it all the way there
                    // put a round line cap beyond the point of the head — the little
                    // blob past the arrow — and left the head sitting on top of a
                    // shaft it was meant to terminate.
                    const stopX = x2 - ux * head * 0.92;
                    const stopY = y2 - uy * head * 0.92;
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(stopX, stopY);
                    ctx.stroke();

                    // A clean dart: apex on the endpoint, base square across the shaft.
                    const baseX = x2 - ux * head;
                    const baseY = y2 - uy * head;
                    const nx = -uy, ny = ux;
                    ctx.beginPath();
                    ctx.moveTo(x2, y2);
                    ctx.lineTo(baseX + nx * halfWidth, baseY + ny * halfWidth);
                    ctx.lineTo(baseX - nx * halfWidth, baseY - ny * halfWidth);
                    ctx.closePath();
                    ctx.fill();
                    return;
                }

                case "rectangle":
                default: {
                    const radius = Math.min(6, w / 4, h / 4, Math.max(w, h));
                    this._roundRect(ctx, x + inset, y + inset,
                        Math.max(w - stroke, 0.5), Math.max(h - stroke, 0.5), Math.max(radius, 0));
                    break;
                }
            }

            if (obj.shape.filled) ctx.fill();
            ctx.stroke();
        }

        _roundRect(ctx, x, y, w, h, r) {
            // Gecko has ctx.roundRect, but guard it: this runs in chrome where the
            // build can be older than the API.
            if (typeof ctx.roundRect === "function") {
                ctx.roundRect(x, y, w, h, r);
                return;
            }
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
        }

        _drawInk(ctx, obj) {
            const points = obj.ink.points;
            if (!points.length) return;

            ctx.fillStyle = this.Objects.colorCss(obj.color);
            const uniform = window.ZenEaselUtil.prefs["ink-style"] === "uniform";
            const outline = this.Freehand.getStrokeOutline(points, {
                size: obj.ink.strokeWidth || 4,
                // thinning 0 gives a constant radius, so the uniform style is the same
                // code path with one option changed rather than a second renderer.
                thinning: uniform ? 0 : 0.6,
                streamline: uniform ? 0.32 : 0.5,
                simulatePressure: obj.ink.simulatePressure !== false
            });
            this.Freehand.outlineToPath(ctx, outline);
            ctx.fill();
        }

        _drawText(ctx, obj) {
            const content = obj.text.content || "";
            if (!content) return;

            const font = this._fontString(obj);
            this._ensureFont(font);
            ctx.font = font;
            ctx.textBaseline = "top";
            ctx.textAlign = obj.text.align === "center" ? "center"
                : obj.text.align === "right" ? "right" : "left";

            const fontSize = obj.text.fontSize || 32;
            const lineHeight = fontSize * LINE_HEIGHT;
            const lines = this.wrapText(ctx, content, obj.w - TEXT_PAD_X * 2, font);
            const originX = obj.text.align === "center" ? obj.x + obj.w / 2
                : obj.text.align === "right" ? obj.x + obj.w - 4 : obj.x + 4;

            // Arc's contentHugging fill. The block is drawn per line, sized to that
            // line's measured width, which is what makes it read as a highlighter rather
            // than a coloured panel behind the paragraph. The glyphs then flip to
            // whichever of black or white stays legible on the fill.
            const hugging = obj.text.fill === "hug";
            if (hugging) {
                const fill = this.Objects.colorCss(obj.color);
                ctx.fillStyle = fill;
                const padX = fontSize * 0.22;
                const padY = fontSize * 0.08;
                const radius = Math.min(6, fontSize * 0.18);

                for (let i = 0; i < lines.length; i++) {
                    if (!lines[i]) continue;
                    const width = ctx.measureText(lines[i]).width;
                    const left = obj.text.align === "center" ? originX - width / 2
                        : obj.text.align === "right" ? originX - width : originX;
                    const top = obj.y + TEXT_PAD_Y + i * lineHeight;
                    ctx.beginPath();
                    this._roundRect(ctx, left - padX, top - padY,
                        width + padX * 2, lineHeight + padY * 2, radius);
                    ctx.fill();
                }
                ctx.fillStyle = this.Objects.luminanceOf(fill) > 0.45 ? "#101014" : "#ffffff";
            } else {
                ctx.fillStyle = this.Objects.colorCss(obj.color);
            }

            // Arc's isInDefaultTitleState: a heading still reading the name it was created
            // with is shown as a prompt rather than as content, so an untouched board does
            // not look like someone deliberately wrote "Untitled Easel" on it.
            if (!hugging && this.host.canvas && this.host.canvas.isPlaceholderTitle(obj)) {
                ctx.globalAlpha *= 0.32;
            }

            // Half-leading. A CSS line box centres the glyphs in its line-height, so a
            // 1.35 line puts 0.175em of space above the text; textBaseline="top" puts
            // none. Without this the canvas copy sits higher than the editor's, and the
            // text visibly jumps the moment you double-click it.
            const halfLeading = (lineHeight - fontSize) / 2;

            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], originX, obj.y + TEXT_PAD_Y + halfLeading + i * lineHeight);
            }
        }

        // Animated images are not painted here during normal rendering — they are
        // <img> elements in the media layer below the canvas, because that is the only
        // way they animate. See modules/media-layer.uc.js.
        //
        // A snapshot is the exception and takes this path deliberately: an export or a
        // library thumbnail is a still, there is no DOM layer behind an offscreen
        // bitmap, and a GIF's first frame is the right thing to put in one.
        _drawImage(ctx, obj) {
            const image = this._image(obj.image.asset);
            if (image) {
                ctx.drawImage(image, obj.x, obj.y, obj.w, obj.h);
            } else {
                ctx.fillStyle = "rgba(128,128,128,0.15)";
                ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
            }
        }

        // Full-bleed. The card used to reserve a 30px strip along its bottom for a
        // canvas-drawn title and play control; that strip is now a floating bar that fades
        // in on hover, drawn as DOM above the live layer. Two things follow.
        //
        // The picture gets the whole box back — and it was never given room for the strip in
        // the first place: capture-page._fitSize sizes a card to the screenshot's own aspect
        // ratio, so the cover-fit below was quietly cropping 30px off every capture to make
        // space for chrome.
        //
        // And the tile is no longer inset, so a live card is the site edge to edge.
        _drawWebcard(ctx, obj) {
            // A live card's pixels come from a real <browser> sitting above this canvas.
            // Leave a hole rather than painting the stale screenshot underneath it: a page
            // with any transparency would show the old capture ghosting through.
            // Snapshots are a different question: there is no <browser> over an offscreen
            // bitmap, so a live card has to be painted as the screenshot it was captured
            // from or it comes out as an empty panel.
            // Two questions, and they used to share one answer.
            //
            //   showsTile  are this card's pixels coming from a <browser> right now. Decides
            //              whether to paint the screenshot — a card whose tile is hidden for
            //              any reason (menu over it, mid-drag, scrolled off) needs it back,
            //              or it is a hole.
            //
            // There used to be a second question here — isLive, is the site loaded and
            // running — because the badge glyph turned on it. The badge is DOM now and the
            // bar asks it for itself, so only the painting question is left.
            const showsTile = !this._snapshotting && this.host.live
                ? this.host.live.showsTile(obj.id) : false;

            ctx.save();
            ctx.beginPath();
            this._roundRect(ctx, obj.x, obj.y, obj.w, obj.h, 10);
            ctx.clip();

            // The card body is filled either way. For a live card the <browser> covers
            // the image area from above, so this only shows during the moment before the
            // tile mounts — but without it that moment is a transparent hole.
            ctx.fillStyle = this._panelColor();
            ctx.fillRect(obj.x, obj.y, obj.w, obj.h);

            // The tile covers the whole card now, so there is nothing left underneath it
            // worth painting — the picture is skipped entirely while it shows.
            if (obj.webcard.asset && !showsTile) {
                const image = this._image(obj.webcard.asset);
                if (image) {
                    // Cover, not stretch: captures keep their aspect ratio the way the
                    // old object-fit:cover did. No clip of its own — the picture now fills
                    // the whole card, so the rounded-rect clip above already bounds it, and
                    // a square one inside that only undid the corners.
                    const scale = Math.max(obj.w / image.width, obj.h / image.height);
                    const dw = image.width * scale;
                    const dh = image.height * scale;
                    ctx.drawImage(image, obj.x + (obj.w - dw) / 2, obj.y + (obj.h - dh) / 2, dw, dh);
                }
            }

            // A card with pixels says what it is by showing them, and its title is in the
            // hover bar. A card with only a link has nothing to show, so the label is all
            // there is — it stays canvas-drawn and centred, or the card is a blank panel
            // until you happen to point at it.
            if (!obj.webcard.asset) {
                const label = obj.webcard.title || obj.webcard.url || "";
                if (label) {
                    ctx.font = "13px system-ui, sans-serif";
                    ctx.fillStyle = this._mutedColor();
                    ctx.textBaseline = "middle";
                    ctx.textAlign = "center";
                    ctx.fillText(this._ellipsize(ctx, label, obj.w - 18),
                        obj.x + obj.w / 2, obj.y + obj.h / 2);
                }
            }
            ctx.restore();
        }

        // The floating chrome bar's geometry, in world coordinates, or null for a card too
        // small to carry one.
        //
        // The bar itself is not drawn here — it is DOM in the browser window, because a
        // live card's <browser> sits above every canvas this renderer owns and would bury
        // anything painted into it. What the renderer still owns is *where* the bar and its
        // controls are, because the canvas is what hit-tests the clicks: a pointer over a
        // non-activated tile reaches the page, not the tile, so the board answers for both
        // states with one hit test. One definition, so the thing you click and the thing
        // you see cannot drift apart.
        //
        // Both object types get a bar. A webBrowser's used to be a URL strip pinned across
        // its top; it is the same floating bar at the bottom now, so the two read as one
        // component and there is only one of them to style.
        //
        //   bar      the pill itself
        //   favicon  the site icon disc at its left, or null on a card too narrow for one
        //   label    what is left over for the title, or null when that is nothing useful
        //   play     play when static, pause when live, or null if this card has neither
        //   link     opens the source page in a tab, or null if the card has no link
        //
        // `has` says which buttons the bar carries — an older capture has no live geometry
        // and gets no play button, a card saved without a URL gets no link. It has to be an
        // input rather than something the caller trims afterwards, because everything is
        // packed against one edge or the other: dropping a button moves its neighbour, and a
        // rect built as though both were there would be a control you can see in one place
        // and click in another. The DOM side packs them the same way, from the same flags,
        // which is what the returned nulls are for.
        //
        // The buttons are what the bar is *for*, so they are laid out first and the label
        // and favicon take what is left. A narrow card — a phone-shaped capture, say —
        // therefore keeps its controls and loses its title, rather than losing the bar and
        // with it the only way to play the card without going to the context menu.
        webcardChromeRects(obj, has = { play: true, link: true }) {
            if (!obj) return null;
            if (obj.type !== "webcard" && obj.type !== "webBrowser") return null;
            if (obj.h < CHROME_MIN_HEIGHT) return null;

            const bar = {
                x: obj.x + CHROME_BAR_INSET,
                y: obj.y + obj.h - CHROME_BAR_INSET - CHROME_BAR_HEIGHT,
                w: obj.w - CHROME_BAR_INSET * 2,
                h: CHROME_BAR_HEIGHT
            };

            const midY = bar.y + bar.h / 2;
            const buttonY = midY - CHROME_BUTTON / 2;

            // Right to left, in reverse of the order they appear, so each one lands where
            // the flex row will put it once the absent ones are gone.
            let right = bar.x + bar.w - CHROME_PAD;
            const take = () => {
                const rect = { x: right - CHROME_BUTTON, y: buttonY, w: CHROME_BUTTON, h: CHROME_BUTTON };
                right = rect.x - CHROME_GAP;
                return rect;
            };

            const wanted = (has.link ? 1 : 0) + (has.play ? 1 : 0);
            const buttonsWidth = wanted * CHROME_BUTTON + Math.max(wanted - 1, 0) * CHROME_GAP;
            // Not even one button fits between the paddings, so there is no bar worth
            // drawing. This is the only width that turns the chrome off outright.
            if (bar.w < CHROME_PAD * 2 + buttonsWidth || buttonsWidth === 0) return null;

            const link = has.link ? take() : null;
            const play = has.play ? take() : null;

            // `right` is now one gap to the left of the leftmost button, which is exactly
            // where the content before it has to stop — CHROME_GAP is the flex row's `gap`,
            // and CHROME_PAD only ever applies at the bar's own two edges. Keeping those two
            // distinct is what makes this arithmetic and the stylesheet agree item for item.
            const contentX = bar.x + CHROME_PAD;
            const room = right - contentX;

            // The favicon outlives the title, not the other way round. It identifies the
            // site in 18 units where a title that narrow is three letters and an ellipsis —
            // and the card is a picture of the page anyway, so the title is the part it can
            // most afford to lose.
            const showLabel = room >= CHROME_FAVICON + CHROME_GAP + CHROME_LABEL_MIN;
            const showFavicon = room >= CHROME_FAVICON;

            const favicon = showFavicon ? {
                x: contentX,
                y: midY - CHROME_FAVICON / 2,
                w: CHROME_FAVICON,
                h: CHROME_FAVICON
            } : null;

            const labelX = favicon ? favicon.x + favicon.w + CHROME_GAP : contentX;
            const label = showLabel ? {
                x: labelX,
                y: bar.y,
                w: Math.max(right - labelX, 0),
                h: bar.h
            } : null;

            return { bar, favicon, label, play, link };
        }

        // Arc's webBrowser object. Unlike a webcard there is no screenshot to fall back on:
        // what the canvas paints is the frame, and the page itself is a live tile above it.
        // When no tile is mounted this is all there is, which is why it says what it is
        // waiting for rather than sitting blank.
        //
        // The URL strip that used to run across the top is gone. It existed because the
        // tile was inset below it and it was therefore the one part of the object a live
        // <browser> could not cover; now that the bar floats and is drawn above the tile
        // rather than beside it, a webBrowser wears the same hover bar a webcard does, at
        // the same edge. One component, one place to style it.
        _drawWebBrowser(ctx, obj) {
            ctx.save();
            ctx.beginPath();
            this._roundRect(ctx, obj.x, obj.y, obj.w, obj.h, 10);
            ctx.clip();

            ctx.fillStyle = this._panelColor();
            ctx.fillRect(obj.x, obj.y, obj.w, obj.h);

            // Two questions, and they are not the same question.
            //
            //   isLive     is the site loaded and running. Distinguishes "loaded but not on
            //              screen" from "not loaded" for the placeholder below.
            //   showsTile  are the tile's pixels on screen right now.
            //
            // Keying the placeholder off showsTile alone told you to load a page that was
            // already loaded and running, every time it scrolled off the board.
            const live = this.host.live;
            const isLive = !this._snapshotting && live ? live.isLive(obj.id) : false;
            const showsTile = !this._snapshotting && live ? live.showsTile(obj.id) : false;

            // The last frame this tile was running, if it has ever run. A web tile is not
            // born from a picture the way a webcard is, so for a long time whatever the
            // tile was not painting was a blank panel with a URL on it — which is a poor
            // answer for a video, where the poster frame is most of what identifies it.
            //
            // Cover-fit inside the rounded clip already set above, exactly as a webcard's
            // capture is: the poster was taken at the tile's aspect ratio, and the card can
            // be resized afterwards.
            const poster = !showsTile && obj.webBrowser.poster
                ? this._image(obj.webBrowser.poster) : null;
            if (poster) {
                const scale = Math.max(obj.w / poster.width, obj.h / poster.height);
                const dw = poster.width * scale;
                const dh = poster.height * scale;
                ctx.drawImage(poster, obj.x + (obj.w - dw) / 2, obj.y + (obj.h - dh) / 2, dw, dh);
            }

            // The strip along the bottom that the floating bar will occupy, on a card tall
            // enough to wear one. Nothing the canvas draws may sit in it: the bar is DOM
            // above this canvas and the canvas is never repainted for a hover, so anything
            // put there is not covered up temporarily — it is covered up for as long as the
            // pointer is on the card, which is exactly when it is being read.
            const barStrip = obj.h >= CHROME_MIN_HEIGHT
                ? CHROME_BAR_INSET + CHROME_BAR_HEIGHT : 0;

            // Three states, not two. A web tile has no screenshot to fall back on, so
            // whatever the tile is not painting, this has to say something about.
            //
            // Unless it does now. A poster says what the card is far better than its URL
            // does, so the label is dropped once there is one — but "Click to load this
            // page" stays, because a picture of a stopped site is exactly the thing that
            // needs saying it is stopped. It gets a scrim to sit on rather than being
            // painted straight onto the screenshot, where it would be unreadable as often
            // as not.
            if (!showsTile && poster) {
                // A strip rather than centred type: the words have to be legible over
                // whatever frame the site happened to stop on, and there is no colour that
                // is safe against an arbitrary screenshot. The band is the board's own
                // panel colour, so it reads as the easel's chrome sitting on the card
                // rather than as part of the picture.
                //
                // Stacked on top of the bar's strip rather than at the card's own bottom
                // edge, or the bar would land on the very sentence saying the card is
                // stopped. Cards too short for a bar keep the edge.
                const bottom = obj.y + obj.h - barStrip;
                const band = Math.min(34, bottom - obj.y);
                if (band > 0) {
                    ctx.fillStyle = this._withAlpha(this._panelColor(), 0.82);
                    ctx.fillRect(obj.x, bottom - band, obj.w, band);
                    ctx.font = "13px system-ui, sans-serif";
                    ctx.fillStyle = this._withAlpha(this._mutedColor(), isLive ? 0.55 : 0.85);
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(isLive ? "Running" : "Click to load this page",
                        obj.x + obj.w / 2, bottom - band / 2);
                }
            } else if (!showsTile) {
                // Centred in what is left after the bar's strip rather than in the whole
                // card. Only bites on a card shrunk to under about twice the bar's height,
                // where the card's own middle is inside the strip — but there that is the
                // whole of what the card has to say, vanishing under the bar on hover.
                const middle = obj.y + (obj.h - barStrip) / 2;

                const label = obj.webBrowser.title || obj.webBrowser.url || "";
                if (label) {
                    ctx.font = "12px system-ui, sans-serif";
                    ctx.fillStyle = this._withAlpha(this._mutedColor(), 0.75);
                    ctx.textAlign = "center";
                    ctx.textBaseline = "alphabetic";
                    ctx.fillText(this._ellipsize(ctx, label, obj.w - 24),
                        obj.x + obj.w / 2, middle - 8);
                }

                ctx.font = "13px system-ui, sans-serif";
                ctx.fillStyle = this._withAlpha(this._mutedColor(), isLive ? 0.45 : 0.7);
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillText(isLive ? "Running" : "Click to load this page",
                    obj.x + obj.w / 2, middle + 4);
            }

            ctx.strokeStyle = this._withAlpha(this._mutedColor(), 0.25);
            ctx.lineWidth = 1;
            ctx.beginPath();
            this._roundRect(ctx, obj.x + 0.5, obj.y + 0.5, obj.w - 1, obj.h - 1, 10);
            ctx.stroke();

            ctx.restore();
        }

        _ellipsize(ctx, text, maxWidth) {
            if (ctx.measureText(text).width <= maxWidth) return text;
            let low = 0, high = text.length;
            while (low < high) {
                const mid = Math.ceil((low + high) / 2);
                if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
                else high = mid - 1;
            }
            return `${text.slice(0, low)}…`;
        }

        /* ---------------------------------------------------------------- text */

        _fontString(obj) {
            return `${obj.text.fontSize || 18}px ${this.Objects.fontCss(obj.text.fontFamily)}`;
        }

        // The families themselves are registered once via the FontFace API (see
        // ensureFonts). This nudges the specific size/style combination so metrics are
        // ready before the first measureText, and repaints when it lands.
        _ensureFont(font) {
            if (this._fontsRequested.has(font)) return;
            this._fontsRequested.add(font);
            try {
                if (document.fonts && document.fonts.load) {
                    document.fonts.load(font).then(() => {
                        this._wrapCache.clear();
                        if (this.host.canvas) this.host.canvas.invalidate();
                    }).catch(() => { });
                }
            } catch (e) { }
        }

        // Greedy word wrap, with a hard break for single words wider than the box.
        wrapText(ctx, content, maxWidth, font) {
            const key = `${font}|${maxWidth}|${content}`;
            const cached = this._wrapCache.get(key);
            if (cached) return cached;

            const width = Math.max(maxWidth, 1);
            const lines = [];

            for (const paragraph of content.split("\n")) {
                if (!paragraph) { lines.push(""); continue; }

                let line = "";
                for (const word of paragraph.split(/(\s+)/)) {
                    if (!word) continue;
                    const candidate = line + word;
                    if (line && ctx.measureText(candidate).width > width) {
                        lines.push(line.replace(/\s+$/, ""));
                        line = word.replace(/^\s+/, "");
                    } else {
                        line = candidate;
                    }
                    // A single token longer than the box has to be split mid-word or
                    // it would overflow forever.
                    while (ctx.measureText(line).width > width && line.length > 1) {
                        let cut = line.length - 1;
                        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
                        lines.push(line.slice(0, cut));
                        line = line.slice(cut);
                    }
                }
                lines.push(line);
            }

            // Bounded so a long editing session cannot grow it without limit.
            if (this._wrapCache.size > 400) this._wrapCache.clear();
            this._wrapCache.set(key, lines);
            return lines;
        }

        // Height the object needs at its current width. Used instead of the old
        // offsetHeight read, which forced a synchronous layout every frame.
        measureTextHeight(obj) {
            const ctx = this.staticCtx;
            const font = this._fontString(obj);
            this._ensureFont(font);
            ctx.font = font;
            const lines = this.wrapText(ctx, obj.text.content || "", obj.w - TEXT_PAD_X * 2, font);
            const lineHeight = (obj.text.fontSize || 18) * LINE_HEIGHT;
            return Math.max(lines.length * lineHeight + TEXT_PAD_Y * 2, lineHeight + TEXT_PAD_Y * 2);
        }

        // The metrics the editor overlay has to mirror, so the two cannot drift.
        static get TEXT_METRICS() {
            return { lineHeight: LINE_HEIGHT, padX: TEXT_PAD_X, padY: TEXT_PAD_Y };
        }

        /* -------------------------------------------------------------- images */

        _image(name) {
            if (!name) return null;
            const cached = this._images.get(name);
            if (cached) {
                if (!cached.complete || !cached.naturalWidth) return null;
                // Refreshes the LRU: the Map is insertion-ordered, so re-inserting is
                // what makes _trimImages drop what has not been painted lately rather
                // than whatever happened to load first.
                this._images.delete(name);
                this._images.set(name, cached);
                return cached;
            }

            const url = this.host.store ? this.host.store.resolveAsset(name) : null;
            if (!url) return null;   // store is still reading it; it will call back

            const image = new Image();
            image.onload = () => {
                if (this.host.canvas) this.host.canvas.invalidate();
            };
            image.src = url;
            this._images.set(name, image);
            this._trimImages();
            return null;
        }

        // Only GIFs, decided by the asset's extension. The store files an asset under
        // the extension it was saved with and validate.sys.mjs allows exactly five
        // raster formats, of which GIF is the only animated one — APNG and animated
        // WebP would belong here too if the store ever accepted them, but it does not,
        // so guessing more broadly would only put still images in the holder.
        _isAnimated(name) {
            return /\.gif$/i.test(name || "");
        }

        // Whether this object is rendered by the DOM media layer instead of by the
        // canvas. Only animated images are, and only while actually rendering: a
        // snapshot has no DOM layer behind it and has to paint everything itself.
        //
        // Consulted by renderStatic and renderActive rather than plumbed through as an
        // option, so there is no way for a caller to forget and paint a still frame
        // underneath the live element.
        isDomRendered(obj) {
            return !this._snapshotting && obj.type === "image" &&
                this._isAnimated(obj.image.asset);
        }

        // Decoded bitmaps used to be held for the life of the document — releaseImages
        // only runs on a switch — so a board of a hundred captures kept a hundred of
        // them resident. Bounded the same way the ink cache is, and for the same reason.
        _trimImages() {
            if (this._images.size <= 80) return;
            const drop = Math.ceil(this._images.size / 4);
            let i = 0;
            for (const [name, image] of this._images) {
                if (i++ >= drop) break;
                this._images.delete(name);
            }
        }

        releaseImages() {
            this._images.clear();
            this._wrapCache.clear();
            this._inkCache.clear();
        }

        /* -------------------------------------------------------------- overlay */

        // A soft accent halo around whatever the pointer is resting on.
        //
        // Drawn *outside* the object's box rather than on its boundary, and that is the
        // whole trick: a live card is a <browser> sitting above every canvas here, so a ring
        // painted on the edge would have its inner half buried and read as a different
        // effect on a live card than on a static one. Kept clear of the box, it is the same
        // halo either way.
        //
        // Screen space, like the rest of the overlay, so it stays the same weight at any
        // zoom instead of thickening as the board is magnified.
        _drawHoverGlow(ctx, hover, accent) {
            const box = hover.box;
            const inset = -HOVER_GLOW_OUTSET;

            ctx.save();
            if (hover.rotation) {
                const cx = box.x + box.w / 2;
                const cy = box.y + box.h / 2;
                ctx.translate(cx, cy);
                ctx.rotate((hover.rotation * Math.PI) / 180);
                ctx.translate(-cx, -cy);
            }

            ctx.shadowColor = this._withAlpha(accent, 0.75);
            ctx.shadowBlur = HOVER_GLOW_BLUR;
            ctx.strokeStyle = this._withAlpha(accent, 0.55);
            ctx.lineWidth = 1.5;

            // Twice, because one pass of a shadowed stroke is faint — the blur spreads the
            // ink both ways and most of it lands outside. The second pass is what makes the
            // halo read as a glow rather than a smudge, and it costs one more stroke of a
            // rectangle.
            ctx.beginPath();
            this._roundRect(ctx, box.x + inset, box.y + inset,
                box.w - inset * 2, box.h - inset * 2, 8);
            ctx.stroke();
            ctx.stroke();

            ctx.restore();
        }

        renderOverlay(state) {
            const ctx = this.overlayCtx;
            this._begin(ctx, null);

            const accent = this._accentColor();

            // The hover halo, first — it belongs under everything else the overlay draws,
            // and a marquee sweeping across the board should pass over it rather than under.
            if (state.hover) this._drawHoverGlow(ctx, state.hover, accent);

            if (state.marquee) {
                const m = state.marquee;
                ctx.fillStyle = this._withAlpha(accent, 0.12);
                ctx.strokeStyle = accent;
                ctx.lineWidth = 1;
                ctx.fillRect(m.x, m.y, m.w, m.h);
                ctx.strokeRect(m.x, m.y, m.w, m.h);
            }

            // Alignment guides are drawn before the selection chrome and outside its
            // early return: they belong to the drag, not to the selection, and a drag
            // that snaps while the frame is hidden still needs to show why.
            if (state.guides && state.guides.length) {
                ctx.save();
                ctx.strokeStyle = accent;
                ctx.lineWidth = 1;
                // Half-pixel offset so a 1px line lands on a device pixel instead of
                // straddling two and rendering as a 2px smear.
                ctx.translate(0.5, 0.5);
                for (const guide of state.guides) {
                    ctx.beginPath();
                    ctx.moveTo(Math.round(guide.x1), Math.round(guide.y1));
                    ctx.lineTo(Math.round(guide.x2), Math.round(guide.y2));
                    ctx.stroke();
                }
                ctx.restore();
            }

            if (!state.selection || !state.selection.length || state.editing) return;

            // Rounded outlines and round handles, following Arc: a hard rectangle with
            // square grips reads as a debug overlay next to the rest of the board.
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.5;
            if (state.selection.length > 1) {
                for (const box of state.selection) {
                    ctx.beginPath();
                    this._roundRect(ctx, box.x, box.y, box.w, box.h, 5);
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;

            const frame = state.frame;
            if (!frame) return;

            // A rotated selection gets rotated chrome, drawn by turning the context
            // about the frame's centre and then drawing the upright frame — the same
            // trick drawObject uses, and the reason handleRects can stay axis-aligned.
            // canvas._handleAt undoes exactly this to find what was clicked.
            ctx.save();
            if (state.rotation) {
                const cx = frame.x + frame.w / 2;
                const cy = frame.y + frame.h / 2;
                ctx.translate(cx, cy);
                ctx.rotate((state.rotation * Math.PI) / 180);
                ctx.translate(-cx, -cy);
            }

            ctx.lineWidth = 1.5;
            ctx.beginPath();
            this._roundRect(ctx, frame.x, frame.y, frame.w, frame.h, 6);
            ctx.stroke();

            // Set once for the whole strip: _drawRotateHandle fills with it too rather
            // than picking its own, so the eight grips and the rotate grip are one set.
            ctx.fillStyle = this._handleColor();
            ctx.lineWidth = 1.5;
            for (const handle of this.handleRects(frame)) {
                if (handle.name === "rotate") {
                    this._drawRotateHandle(ctx, handle, frame, accent);
                    continue;
                }
                ctx.beginPath();
                ctx.arc(handle.x + handle.w / 2, handle.y + handle.h / 2, handle.w / 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();
        }

        // The grip, its stalk down to the top edge, and a curved arrow inside it. The
        // stalk matters more than it looks: without it the grip reads as a stray dot
        // floating above the selection rather than as part of it.
        _drawRotateHandle(ctx, handle, frame, accent) {
            const cx = handle.x + handle.w / 2;
            const cy = handle.y + handle.h / 2;
            const r = handle.w / 2;

            ctx.beginPath();
            ctx.moveTo(cx, frame.y);
            ctx.lineTo(cx, cy + r);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Three quarters of a circle with a tick at one end: enough to read as
            // "turn me" at 13px without becoming a smudge.
            ctx.save();
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1.4;
            const inner = r * 0.5;
            ctx.beginPath();
            ctx.arc(cx, cy, inner, Math.PI * 0.35, Math.PI * 1.85);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(cx + inner * 0.55, cy - inner * 0.95);
            ctx.lineTo(cx + inner * 0.95, cy - inner * 0.3);
            ctx.lineTo(cx + inner * 0.2, cy - inner * 0.25);
            ctx.stroke();
            ctx.restore();
        }

        // Handle geometry lives here so the renderer and the hit test cannot disagree
        // about where the handles are — the canvas has no DOM node to click any more.
        //
        // Everything is in the frame's *unrotated* screen space. A rotated selection is
        // drawn by rotating the context about the frame's centre, and hit-tested by
        // rotating the pointer the other way, so neither side needs rotated rectangles.
        handleRects(frame) {
            const half = HANDLE_SIZE / 2;
            const positions = {
                nw: [frame.x, frame.y],
                n: [frame.x + frame.w / 2, frame.y],
                ne: [frame.x + frame.w, frame.y],
                e: [frame.x + frame.w, frame.y + frame.h / 2],
                se: [frame.x + frame.w, frame.y + frame.h],
                s: [frame.x + frame.w / 2, frame.y + frame.h],
                sw: [frame.x, frame.y + frame.h],
                w: [frame.x, frame.y + frame.h / 2]
            };
            const rects = HANDLES.map(name => ({
                name,
                x: positions[name][0] - half,
                y: positions[name][1] - half,
                w: HANDLE_SIZE,
                h: HANDLE_SIZE
            }));

            // Listed last so a reverse-order hit test finds it first. It overlaps
            // nothing today, but it is the only handle outside the frame and the one a
            // near-miss should resolve in favour of.
            rects.push({
                name: "rotate",
                x: frame.x + frame.w / 2 - ROTATE_HANDLE_SIZE / 2,
                y: frame.y - ROTATE_HANDLE_OFFSET - ROTATE_HANDLE_SIZE / 2,
                w: ROTATE_HANDLE_SIZE,
                h: ROTATE_HANDLE_SIZE
            });
            return rects;
        }

        /* --------------------------------------------------------------- colors */

        // Theme values are read from the host element, where _syncZenColors already
        // mirrors Zen's own custom properties.
        _cssVar(name, fallback) {
            const value = window.getComputedStyle(this.host).getPropertyValue(name);
            return value && value.trim() ? value.trim() : fallback;
        }

        _accentColor() { return this._cssVar("--easel-accent", "#2b5fd9"); }
        _mutedColor() { return this._cssVar("--easel-muted", "rgba(0,0,0,0.55)"); }

        // A card body is the board's own colour with the alpha taken off, never the
        // tinted --easel-panel the chrome uses: it paints onto the canvas, and at 50%
        // alpha it is a hole showing the board through the card rather than a card.
        // _applyBackground keeps the property in step, so cards follow Paper to Ink.
        _panelColor() { return this._cssVar("--easel-solid", "#ffffff"); }

        // The grip discs, which are not the board's colour: a handle painted in the
        // board's own tint is a handle you cannot see. --easel-handle flips on
        // data-easel-ink, so the board — not the OS scheme, and not Zen's workspace colour,
        // which is what the floating panels follow — decides. It lands one step *brighter*
        // than the board in both directions so the grip reads as raised off it either way.
        _handleColor() { return this._cssVar("--easel-handle", "#ffffff"); }

        _withAlpha(color, alpha) {
            const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
            if (match) {
                const n = parseInt(match[1], 16);
                return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
            }
            const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color);
            if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
            return color;
        }
    }

    window.ZenEaselRenderer = ZenEaselRenderer;
})();
