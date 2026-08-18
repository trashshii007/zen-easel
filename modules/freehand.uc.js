// Zen Easel — freehand stroke geometry.
//
// Turns a list of recorded pointer samples into a filled outline whose width varies
// with speed (or with real pen pressure when the device reports it). A stroked
// constant-width path — what this mod used to draw — reads as mechanical next to it,
// because real ink thins as the pen accelerates.
//
// This is an independent implementation of the approach described by perfect-freehand
// (Steve Ruiz, MIT), which is what Excalidraw uses. No code was copied; the pieces that
// matter are the streamline filter, the pressure-to-radius easing, and emitting a
// closed polygon rather than a stroke.

"use strict";

(function () {
    if (window.ZenEaselFreehand) return;

    const DEFAULTS = {
        size: 8,            // stroke diameter at neutral pressure
        thinning: 0.6,      // 0 = uniform width, 1 = maximum speed response
        streamline: 0.5,    // input smoothing, 0..1
        smoothing: 0.5,     // outline smoothing
        simulatePressure: true
    };

    // Pressure chases its target rather than snapping to it, so a single fast sample
    // cannot pinch the stroke to nothing.
    const RATE_OF_CHANGE = 0.275;
    const CAP_SEGMENTS = 8;

    const easeOutSine = t => Math.sin((t * Math.PI) / 2);
    const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

    // Radius at a given pressure. thinning === 0 collapses this to a constant size/2,
    // which is how the uniform ink style is expressed without a second code path.
    function radiusAt(size, thinning, pressure) {
        return size * easeOutSine(clamp01(0.5 - thinning * (0.5 - pressure)));
    }

    // Low-pass filter over the input. Pointer samples are noisy — especially from a
    // mouse, which reports integer coordinates — and drawing them literally gives the
    // wobbly look. Each point is pulled toward its predecessor by `streamline`.
    function streamlinePoints(points, streamline) {
        if (points.length < 2) return points.map(p => p.slice());

        const factor = 1 - clamp01(streamline);
        const out = [points[0].slice()];
        let prev = out[0];

        for (let i = 1; i < points.length; i++) {
            const p = points[i];
            const x = prev[0] + (p[0] - prev[0]) * factor;
            const y = prev[1] + (p[1] - prev[1]) * factor;
            // Drop samples that land on top of each other: a zero-length segment has
            // no direction, and normalising it would produce NaN normals.
            if (Math.abs(x - prev[0]) < 1e-4 && Math.abs(y - prev[1]) < 1e-4) continue;
            const next = [x, y, p.length > 2 ? p[2] : 0.5];
            out.push(next);
            prev = next;
        }

        // The filter lags the input by design, so the smoothed path stops short of
        // where the pen actually lifted — a visible gap at the end of every stroke,
        // and bounds that do not enclose the last sample. Anchor the true final point.
        const final = points[points.length - 1];
        if (Math.hypot(final[0] - prev[0], final[1] - prev[1]) > 1e-4) {
            out.push([final[0], final[1], final.length > 2 ? final[2] : 0.5]);
        }
        return out;
    }

    // Per-point radii. Without a real pressure signal, speed stands in for it: the
    // further the pen travelled since the last sample, the faster it is moving, and
    // the thinner the line gets.
    function computeRadii(points, options) {
        const { size, thinning, simulatePressure } = options;
        const radii = new Array(points.length);
        let pressure = 0.5;

        for (let i = 0; i < points.length; i++) {
            if (simulatePressure) {
                const prev = points[i - 1] || points[i];
                const distance = Math.hypot(points[i][0] - prev[0], points[i][1] - prev[1]);
                const speed = Math.min(1, distance / size);
                const target = 1 - speed;
                pressure = Math.min(1, pressure + (target - pressure) * (speed * RATE_OF_CHANGE));
            } else {
                pressure = points[i].length > 2 ? points[i][2] : 0.5;
            }
            radii[i] = radiusAt(size, thinning, pressure);
        }

        // No artificial taper on the opening points. It pinched the first few radii to
        // a fifth of full width, so the round start cap was drawn at almost no radius
        // and the stroke appeared to begin with a clipped, blunt stub. Excalidraw does
        // not taper the start either; the speed-to-pressure model shapes the line.
        return radii;
    }

    // Unit normal at each point, from a central difference so corners stay smooth
    // rather than flipping between adjacent segment directions.
    function normalAt(points, i) {
        const prev = points[Math.max(0, i - 1)];
        const next = points[Math.min(points.length - 1, i + 1)];
        let dx = next[0] - prev[0];
        let dy = next[1] - prev[1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) return [0, 0];
        dx /= length;
        dy /= length;
        return [-dy, dx];
    }

    // Returns a closed polygon: one side out, the other side back, round caps at both
    // ends. Callers fill it — they never stroke it.
    function getStrokeOutline(inputPoints, opts = {}) {
        const options = { ...DEFAULTS, ...opts };
        const points = streamlinePoints(inputPoints, options.streamline);
        if (!points.length) return [];

        // A single sample is a dot, drawn as a full circle.
        if (points.length === 1) {
            const r = radiusAt(options.size, 0, 0.5);
            const [x, y] = points[0];
            const dot = [];
            for (let i = 0; i < CAP_SEGMENTS * 2; i++) {
                const a = (i / (CAP_SEGMENTS * 2)) * Math.PI * 2;
                dot.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
            }
            return dot;
        }

        const radii = computeRadii(points, options);
        const left = [];
        const right = [];
        // Kept so the caps can be swept along a known outward direction rather than
        // inferred from the offset points, which is ambiguous at 180°.
        const normals = [];

        for (let i = 0; i < points.length; i++) {
            const normal = normalAt(points, i);
            normals.push(normal);
            const [nx, ny] = normal;
            const r = radii[i];
            left.push([points[i][0] + nx * r, points[i][1] + ny * r]);
            right.push([points[i][0] - nx * r, points[i][1] - ny * r]);
        }

        // Half-circle cap swept from +normal to -normal, bulging along the perpendicular
        // — which is to say, away from the stroke.
        //
        // Deriving the sweep from the two endpoint angles cannot work: they are 180°
        // apart, so the arc between them is ambiguous, and forcing the sweep positive
        // picks a direction with no relation to which way the line runs. Both caps then
        // folded back over the stroke, which is the hook that appeared at each end.
        // Sweeping along an explicit outward vector removes the ambiguity entirely.
        const capAt = (index, nx, ny) => {
            const [cx, cy] = points[index];
            const r = radii[index];
            if (!r || (!nx && !ny)) return [];

            // Perpendicular to the normal, pointing out of the end of the stroke.
            const fx = ny, fy = -nx;
            const arc = [];
            for (let i = 1; i < CAP_SEGMENTS; i++) {
                const t = (Math.PI * i) / CAP_SEGMENTS;
                const c = Math.cos(t), s = Math.sin(t);
                arc.push([cx + (nx * c + fx * s) * r, cy + (ny * c + fy * s) * r]);
            }
            return arc;
        };

        const last = points.length - 1;

        // The end cap runs +normal to -normal and bulges forwards; the start cap is the
        // same arc with the normal flipped, so it bulges backwards. Both are built
        // before `right` is reversed, and the reversal is taken on a copy.
        const endCap = capAt(last, normals[last][0], normals[last][1]);
        const startCap = capAt(0, -normals[0][0], -normals[0][1]);

        return [...left, ...endCap, ...right.slice().reverse(), ...startCap];
    }

    // Builds the outline into a context path using quadratic segments through the
    // midpoints, which softens the polygon without needing more sample points.
    function outlineToPath(ctx, outline) {
        if (outline.length < 3) return;
        ctx.beginPath();

        const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        let start = mid(outline[outline.length - 1], outline[0]);
        ctx.moveTo(start[0], start[1]);

        for (let i = 0; i < outline.length; i++) {
            const current = outline[i];
            const next = outline[(i + 1) % outline.length];
            const m = mid(current, next);
            ctx.quadraticCurveTo(current[0], current[1], m[0], m[1]);
        }
        ctx.closePath();
    }

    // Bounding box of the painted stroke, so hit-testing and the selection box agree
    // with what is actually on screen rather than with the raw sample points.
    function outlineBounds(outline) {
        if (!outline.length) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of outline) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    window.ZenEaselFreehand = { getStrokeOutline, outlineToPath, outlineBounds, DEFAULTS };
})();
