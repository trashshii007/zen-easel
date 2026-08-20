// Zen Easel — animated images.
//
// A GIF is drawn as a real <img> element rather than painted to the canvas, and that is
// the only arrangement that actually animates.
//
// `ctx.drawImage` paints an image's *current* frame, and an image only has a current
// frame while Gecko is ticking it — which it does for images it is laying out, driven by
// the frame that displays them. An <img> built solely to be a drawImage source has no
// such frame and stays on frame 0 for ever. Two attempts were made to get around that
// and both failed: a hidden-but-rendered 1px holder, and decoding every frame through
// ImageDecoder and running our own clock (ImageDecoder is not reliably available in this
// build). zen-library, which shows GIFs correctly in its media grid, simply puts a normal
// <img> in the page — so that is what this does.
//
// The layer sits *below* the canvases, not above:
//
//   viewport background (grid + wash)
//   → this layer            ← animated images
//   → static canvas         ← every other object
//   → active / overlay canvas
//
// which means an animated image covers the grid, as an image should, and everything on
// the board draws over it. That ordering is deliberate. An easel is a thing you annotate,
// so a shape or a caption placed on top of a GIF has to be visible; the cost is that a
// GIF cannot be brought in front of another image, which is much the rarer want.
//
// It is also cheaper than painting would be. The compositor animates these for free, so
// nothing here drives a repaint — where the canvas approach would have meant redrawing
// the whole static layer twenty times a second for as long as a GIF was on screen.

"use strict";

(function () {
    if (window.ZenEaselMediaLayer) return;

    class ZenEaselMediaLayer {
        constructor(host, root) {
            this.host = host;
            this.root = root;                 // div.easel-media-layer
            // objectId -> { element, asset, signature }
            this._items = new Map();
        }

        // Called from the canvas's paint, on the same frame as everything else, so an
        // animated image never lags the board it is sitting on. Same contract as
        // live-layer's sync, and for the same reason.
        sync() {
            const canvas = this.host.canvas;
            if (!canvas || !canvas.doc) return this.clear();

            const renderer = this.host.renderer;
            const view = canvas.view;
            const seen = new Set();

            for (const obj of canvas.objects) {
                if (!renderer.isDomRendered(obj)) continue;
                // The textarea is showing this one, or a gesture has moved it to the
                // active canvas — neither applies to an image, but the check keeps this
                // honest against the canvas's own skip rules.
                seen.add(obj.id);
                this._place(obj, view);
            }

            for (const id of [...this._items.keys()]) {
                if (!seen.has(id)) this._remove(id);
            }
        }

        _place(obj, view) {
            const asset = obj.image.asset;
            let item = this._items.get(obj.id);

            // A changed asset means a different file behind the same object, so the
            // element is rebuilt rather than re-pointed — src is what holds the decoded
            // frames, and swapping it mid-animation is not worth the saving.
            if (item && item.asset !== asset) {
                this._remove(obj.id);
                item = null;
            }

            if (!item) {
                const url = this.host.store ? this.host.store.resolveAsset(asset) : null;
                // Still being read off disk. The store calls back on arrival and the
                // canvas repaints, which brings us back here.
                if (!url) return;

                const element = document.createElement("img");
                element.src = url;
                element.setAttribute("aria-hidden", "true");
                element.className = "easel-media-item";
                this.root.appendChild(element);
                item = { element, asset, signature: "" };
                this._items.set(obj.id, item);
            }

            const topLeft = this.host.canvas.toScreen(obj.x, obj.y);
            const w = obj.w * view.zoom;
            const h = obj.h * view.zoom;
            const rotation = obj.rotation || 0;
            // A GIF is the one object the canvas never paints, so the renderer's
            // globalAlpha does not reach it. The compositor fades the element instead,
            // which is the same result for free.
            const opacity = obj.opacity === undefined ? 1 : obj.opacity;

            // Compared before writing: this runs on every painted frame, and assigning
            // six style properties per image per frame is a style invalidation for
            // values that only change when the board moves.
            const signature = `${topLeft.x}|${topLeft.y}|${w}|${h}|${rotation}|${opacity}`;
            if (signature === item.signature) return;
            item.signature = signature;

            const style = item.element.style;
            style.left = `${topLeft.x}px`;
            style.top = `${topLeft.y}px`;
            style.width = `${Math.max(0, w)}px`;
            style.height = `${Math.max(0, h)}px`;
            style.transform = rotation ? `rotate(${rotation}deg)` : "";
            style.opacity = opacity < 1 ? String(opacity) : "";
        }

        _remove(id) {
            const item = this._items.get(id);
            if (!item) return;
            item.element.remove();
            this._items.delete(id);
        }

        // Switching easel, or closing the last one. The elements belong to the document
        // being left behind.
        clear() {
            if (!this._items.size) return;
            for (const item of this._items.values()) item.element.remove();
            this._items.clear();
        }

        destroy() {
            this.clear();
        }
    }

    window.ZenEaselMediaLayer = ZenEaselMediaLayer;
})();
