// Zen Easel — alignment guides.
//
// Arc does not snap to a grid. It snaps objects to each other, along six axes — the two
// outer edges and the centre, on each of the two dimensions — and shows a thin line
// through whatever it lined up with. That is what makes an Arc easel feel tidy without
// ever feeling like it is fighting you, and it is the piece a grid cannot replicate: a
// grid aligns things to the page, and what you actually want is for them to align to
// each other.
//
// Two gates keep it from being annoying, both taken from Arc's constants:
//
//   * distance — a candidate only counts within snapDistancePixels of the anchor, in
//     screen pixels, so the pull feels the same at every zoom level
//   * velocity — a fast drag does not snap at all. Without this, flinging an object
//     across the board stutters as it passes every other object on the way.

"use strict";

(function () {
    if (window.ZenEaselGuides) return;

    // Screen pixels, so the feel is zoom-independent.
    const SNAP_DISTANCE_PX = 6;

    // World units per millisecond. Above this the drag is a throw, not a placement.
    const SNAP_MAX_VELOCITY = 1.6;

    // Anchors, in the order Arc names them. Each returns a coordinate on its axis.
    const X_ANCHORS = [
        ["leftEdge", box => box.x],
        ["centerX", box => box.x + box.w / 2],
        ["rightEdge", box => box.x + box.w]
    ];
    const Y_ANCHORS = [
        ["topEdge", box => box.y],
        ["centerY", box => box.y + box.h / 2],
        ["bottomEdge", box => box.y + box.h]
    ];

    class ZenEaselGuides {
        constructor(host) {
            this.host = host;
            this.Objects = window.ZenEaselObjects;
            this.active = [];       // guide lines to draw, in world coordinates
        }

        get enabled() {
            return window.ZenEaselUtil.prefs["snap"] === "guides";
        }

        clear() {
            this.active = [];
        }

        // Given where the dragged selection would land, returns the small correction that
        // lines it up with something nearby — or zero, plus the lines to draw.
        //
        // movingBox is the union bounds of the selection at its unsnapped position;
        // candidates are the objects it might align to. Both in world coordinates.
        adjust(movingBox, candidates, velocity) {
            this.active = [];
            if (!this.enabled) return { dx: 0, dy: 0 };
            if (velocity > SNAP_MAX_VELOCITY) return { dx: 0, dy: 0 };

            const zoom = this.host.canvas.view.zoom || 1;
            const threshold = SNAP_DISTANCE_PX / zoom;

            const x = this._bestAlignment(movingBox, candidates, X_ANCHORS, threshold);
            const y = this._bestAlignment(movingBox, candidates, Y_ANCHORS, threshold);

            if (x) this.active.push(this._lineFor(x, movingBox, "x"));
            if (y) this.active.push(this._lineFor(y, movingBox, "y"));

            return { dx: x ? x.delta : 0, dy: y ? y.delta : 0 };
        }

        // The closest pairing of one of the moving box's three anchors with one of a
        // candidate's three, on a single axis. Ties go to whichever was found first,
        // which puts edges ahead of centres — the same precedence Arc's ordering implies.
        _bestAlignment(movingBox, candidates, anchors, threshold) {
            let best = null;

            for (const [, read] of anchors) {
                const from = read(movingBox);
                for (const candidate of candidates) {
                    const box = this.Objects.bounds(candidate);
                    for (const [name, readOther] of anchors) {
                        const to = readOther(box);
                        const distance = Math.abs(to - from);
                        if (distance > threshold) continue;
                        if (best && distance >= best.distance) continue;
                        best = { name, distance, delta: to - from, position: to, box };
                    }
                }
            }
            return best;
        }

        // The line runs from the further extent of the two boxes to the other, so it
        // visibly connects the thing being moved to the thing it lined up with rather
        // than spanning the whole board.
        _lineFor(match, movingBox, axis) {
            if (axis === "x") {
                return {
                    axis: "x",
                    position: match.position,
                    from: Math.min(movingBox.y, match.box.y),
                    to: Math.max(movingBox.y + movingBox.h, match.box.y + match.box.h)
                };
            }
            return {
                axis: "y",
                position: match.position,
                from: Math.min(movingBox.x, match.box.x),
                to: Math.max(movingBox.x + movingBox.w, match.box.x + match.box.w)
            };
        }
    }

    window.ZenEaselGuides = ZenEaselGuides;
})();
