// Zen Easel — animated images, video and audio.
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
// A video is the same case with sound: a <video> element here, positioned like the GIF,
// and the compositor plays it. An audio file has no picture, so its card is painted by
// the canvas like any other object; the <audio> element in this layer is only the
// engine behind it, with no box of its own.
//
// The layer sits *below* the canvases, not above:
//
//   viewport background (grid + wash)
//   → this layer            ← animated images, video
//   → static canvas         ← every other object
//   → active / overlay canvas
//
// which means an animated image covers the grid, as an image should, and everything on
// the board draws over it. That ordering is deliberate. An easel is a thing you annotate,
// so a shape or a caption placed on top of a GIF has to be visible; the cost is that a
// GIF cannot be brought in front of another image, which is much the rarer want.
//
// It also decides how a video is controlled: the layer takes no pointer events, so a
// native control bar could never be clicked. The canvas draws a play/pause glyph and a
// progress bar on its overlay from the geometry in renderer.mediaControlRects, hit-tests
// them itself, and calls toggle() here — the same arrangement as the floating card bar,
// for the same reason.
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
            // objectId -> { element, asset, signature, kind }
            this._items = new Map();
            // Set by the canvas: a playback state change on this object id, so it can
            // repaint the overlay if that object's controls are showing.
            this.onMediaChange = null;
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
                // An <audio> has no box, so it is not "DOM rendered" — the canvas paints
                // its card — but it still has to exist here to be played.
                const audio = obj.type === "media" && renderer.mediaKind(obj) === "audio";
                if (!audio && !renderer.isDomRendered(obj)) continue;
                // The textarea is showing this one, or a gesture has moved it to the
                // active canvas — neither applies to an image, but the check keeps this
                // honest against the canvas's own skip rules.
                seen.add(obj.id);
                this._place(obj, view, audio);
            }

            for (const id of [...this._items.keys()]) {
                if (!seen.has(id)) this._remove(id);
            }
        }

        _place(obj, view, audio) {
            // A linked media object has no asset; its path is the key, and the store resolves it.
            const asset = obj.type === "media" ? (obj.media.asset || obj.media.path) : obj.image.asset;
            let item = this._items.get(obj.id);

            // A changed asset means a different file behind the same object, so the
            // element is rebuilt rather than re-pointed — src is what holds the decoded
            // frames, and swapping it mid-animation is not worth the saving.
            if (item && item.asset !== asset) {
                this._remove(obj.id);
                item = null;
            }

            if (!item) {
                const store = this.host.store;
                const url = !store ? null
                    : obj.type === "media" && obj.media.path ? store.resolveLinked(obj.media.path)
                    : store.resolveAsset(asset);
                // Still being read off disk. The store calls back on arrival and the
                // canvas repaints, which brings us back here.
                if (!url) return;

                const kind = obj.type === "media" ? (audio ? "audio" : "video") : "image";
                const element = document.createElement(kind === "image" ? "img" : kind);
                if (kind !== "image") {
                    // metadata, not auto: one decoder and buffer set per video on a board
                    // is enough, and play() fetches the rest. No controls — see the header.
                    element.preload = "metadata";
                    element.setAttribute("playsinline", "");
                    const changed = () => { if (this.onMediaChange) this.onMediaChange(obj.id); };
                    for (const type of ["play", "pause", "ended", "timeupdate", "loadedmetadata"]) {
                        element.addEventListener(type, changed);
                    }
                }
                element.src = url;
                element.setAttribute("aria-hidden", "true");
                element.className = "easel-media-item";
                this.root.appendChild(element);
                item = { element, asset, signature: "", kind };
                this._items.set(obj.id, item);
            }

            // Nothing to lay out for an engine with no picture.
            if (audio) return;

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

        /* ------------------------------------------------------------- playback */

        // The element behind a media object, or null while it is still loading. The
        // renderer draws a video's current frame from it for an export.
        elementFor(id) {
            const item = this._items.get(id);
            return item && item.kind !== "image" ? item.element : null;
        }

        isPlaying(id) {
            const el = this.elementFor(id);
            return !!el && !el.paused && !el.ended;
        }

        // { current, duration } in seconds; duration is 0 until the metadata is in.
        progress(id) {
            const el = this.elementFor(id);
            if (!el) return { current: 0, duration: 0 };
            const duration = Number.isFinite(el.duration) ? el.duration : 0;
            return { current: el.currentTime || 0, duration };
        }

        // play() returns a promise, and it rejects for two reasons worth telling apart:
        // a pause that interrupted it (AbortError — a fast second click, nothing to say)
        // and a file the engine cannot decode (NotSupportedError — an HEVC MP4, ALAC in
        // an .m4a). The second is the user's file and they should hear so; the object
        // stays on the board either way, to be moved or deleted.
        toggle(id) {
            const el = this.elementFor(id);
            if (!el) return;
            if (!el.paused && !el.ended) {
                el.pause();
                return;
            }
            const attempt = el.play();
            if (attempt && typeof attempt.catch === "function") {
                attempt.catch(err => {
                    if (err && err.name === "AbortError") return;
                    console.error("[zen-easel] could not play the media object:", err);
                    this.host.toast("This file can't be played here");
                });
            }
        }

        /* ------------------------------------------------------------- lifetime */

        // Removal releases the file, not just the element. A media element with a src
        // keeps its stream — and on Windows the file handle — open for as long as the
        // element lives, and a removed element can live on in a closure. This is the
        // standard release sequence, and it is what lets the asset sweep delete the file
        // of a deleted object instead of hitting a sharing violation for a day.
        _release(item) {
            const el = item.element;
            if (item.kind !== "image") {
                try { el.pause(); } catch (e) { }
                el.removeAttribute("src");
                try { el.load(); } catch (e) { }
            }
            el.remove();
        }

        _remove(id) {
            const item = this._items.get(id);
            if (!item) return;
            this._release(item);
            this._items.delete(id);
        }

        // Switching easel, or closing the last one. The elements belong to the document
        // being left behind.
        clear() {
            if (!this._items.size) return;
            for (const item of this._items.values()) this._release(item);
            this._items.clear();
        }

        destroy() {
            this.clear();
        }
    }

    window.ZenEaselMediaLayer = ZenEaselMediaLayer;
})();
