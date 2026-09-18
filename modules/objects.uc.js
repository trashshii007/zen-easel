// Zen Easel — object model.
//
// Mirrors the object taxonomy Arc's own binary exposes (EaselTextViewController,
// EaselShapeViewController, EaselImageViewController, EaselWebCardViewController,
// plus freehand ink), and keeps every object individually addressable rather than
// flattening the board into a paint buffer.
//
// This module is pure: it constructs objects, validates them on load, and answers
// geometry questions about them. It owns no state and touches no DOM — painting is
// ZenEaselRenderer's job, and hit-testing runs here against the model rather than
// through DOM dispatch, which is what let the DOM scene graph be removed outright.

"use strict";

(function () {
    if (window.ZenEaselObjects) return;

    /* ----------------------------------------------------------------- colour */

    // Arc's eleven easel colour names, in Arc's own order, read out of the colour renditions in ARCClients_BaseAssets.bundle/Assets.car.
    // Arc's "pink" is a coral and its "purple" is a magenta — the names are Arc's, not a mislabelling here.
    const COLOR_ORDER = [
        ["black", "Black"],
        ["gray", "Grey"],
        ["white", "White"],
        ["pink", "Pink"],
        ["red", "Red"],
        ["yellow", "Yellow"],
        ["lightGreen", "Light green"],
        ["darkGreen", "Dark green"],
        ["lightBlue", "Light blue"],
        ["darkBlue", "Dark blue"],
        ["purple", "Purple"]
    ];

    // Arc shipped these as two switchable palettes; they are now simply the picker's two standard rows.
    const VIBRANT = ["#000000", "#BBBBBB", "#FFFFFF", "#FF994E", "#F53714", "#FFD335",
        "#34E895", "#107A00", "#00C7F3", "#3139FB", "#C0009F"];
    const CHILL = ["#000000", "#BBBBBB", "#FFFFFF", "#F2C2AC", "#D74807", "#C2A12A",
        "#D0D87F", "#1D5914", "#55A2BD", "#3139FB", "#A6729D"];

    const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

    // Any accepted spelling of a hex colour, reduced to the one form this mod stores — or null.
    function normalizeColor(value) {
        const match = HEX_RE.exec(String(value || "").trim());
        if (!match) return null;
        const hex = match[1].length === 3 ? match[1].split("").map(c => c + c).join("") : match[1];
        return "#" + hex.toLowerCase();
    }

    const DEFAULT_COLOR = "#000000";

    // What reads as "no colour chosen yet" against Zen's own chrome: white on a dark theme, black
    // on a light one. Both the pen's starting colour and the board's fall through this, so a fresh
    // easel is legible without anyone having picked anything.
    const themeColor = dark => (dark ? "#ffffff" : DEFAULT_COLOR);

    // Chill's other four entries are byte-identical to vibrant's, so row two would otherwise show four redundant pairs.
    const CHILL_ONLY = [3, 4, 5, 6, 7, 8, 10];

    // `key` is the hex itself, so the swatch row's active test and its onPick both work without a lookup table.
    const swatchOf = (hex, label) => ({ key: normalizeColor(hex), label, css: normalizeColor(hex) });
    const STANDARD_ROWS = [
        COLOR_ORDER.map(([, label], i) => swatchOf(VIBRANT[i], label)),
        CHILL_ONLY.map(i => swatchOf(CHILL[i], `${COLOR_ORDER[i][1]} (chill)`))
    ];

    // Documents written before colours became hex store a palette name and a colour key; this is the only thing that still reads them.
    // Null-prototype: the key being looked up comes off disk, and a plain object answers "constructor" or "toString" from Object.prototype.
    const legacyMap = values => {
        const map = Object.create(null);
        COLOR_ORDER.forEach(([key], i) => { map[key] = normalizeColor(values[i]); });
        return map;
    };
    const LEGACY_PALETTES = { vibrant: legacyMap(VIBRANT), chill: legacyMap(CHILL) };

    // The single point a stored colour becomes something a canvas or a stylesheet can use.
    const colorCss = value =>
        normalizeColor(value) || LEGACY_PALETTES.vibrant[value] || DEFAULT_COLOR;

    // How many colours the picker's "recently used" row remembers, capped on both read and write.
    // The same count as the favourites beside it, so the two rows are the same width.
    const RECENT_LIMIT = 4;

    // Board backgrounds, stored per easel. Every one of them is a *tint*, not a fill:
    // `css` carries an alpha, nothing between the board and Zen's window paints, and
    // what you see is the window wearing the board's colour. "theme" means paint
    // nothing here and let the stylesheet's light-dark() tint show through, so an easel
    // left alone still follows Zen between light and dark mode; "transparent" goes
    // further and declines to tint at all — see _applyBackground in canvas.uc.js.
    //
    // How see-through that actually reads depends on browser.tabs.allow_transparent_browser,
    // which Zen's transparency themes set and this mod deliberately does not touch. With
    // the flag the wallpaper comes through; without it the tint composites against the
    // window's own colour, which still looks deliberate rather than broken.
    //
    // `swatch` is the same colour opaque. Three things need a solid version and cannot
    // use a tint: the menu dot (a 18px disc at 50% alpha reads as no colour at all), a
    // rasterised export, and the canvas-painted chrome — card bodies and selection
    // handles — which would otherwise be holes onto the board.
    //
    // `image` is an optional list of gradients layered under the grid. Arc's easels sit
    // on a pale multi-colour wash rather than flat paper, and it is most of why they
    // read as soft rather than clinical. Their stops carry alpha too, for the same
    // reason the fills do.
    //
    // A list rather than one comma-joined string on purpose. It used to be a string
    // that _applyGrid split back apart on top-level commas, and the regex it used could
    // not tell a separator from the commas inside rgba(). Each gradient was shredded
    // into three fragments, the joined background-image was invalid, and CSSOM drops an
    // invalid assignment silently — so the property kept its previous value and the grid
    // froze in place. Never reassembling the list is what makes that unrepeatable.
    const BACKGROUNDS = [
        {
            key: "arc", label: "Arc", swatch: "#FAFAFC", css: "rgba(250, 250, 252, 0.44)",
            image: [
                "radial-gradient(120% 90% at 0% 0%, rgba(239,232,255,0.42) 0%, rgba(239,232,255,0) 55%)",
                "radial-gradient(120% 90% at 100% 100%, rgba(228,245,233,0.42) 0%, rgba(228,245,233,0) 55%)",
                "radial-gradient(140% 120% at 100% 0%, rgba(253,240,246,0.42) 0%, rgba(253,240,246,0) 60%)"
            ]
        },
        { key: "theme", label: "Follow theme", css: "" },
        // The one board with no colour of its own: nothing paints, and Zen's window is
        // the board.
        { key: "transparent", label: "Transparent", css: "transparent" },
        { key: "white", label: "White", swatch: "#FFFFFF", css: "rgba(255, 255, 255, 0.48)" },
        { key: "paper", label: "Paper", swatch: "#F6F2E9", css: "rgba(246, 242, 233, 0.50)" },
        { key: "mist", label: "Mist", swatch: "#E9EDF1", css: "rgba(233, 237, 241, 0.50)" },
        { key: "slate", label: "Slate", swatch: "#2A2E35", css: "rgba(42, 46, 53, 0.52)" },
        { key: "ink", label: "Ink", swatch: "#161B2E", css: "rgba(22, 27, 46, 0.54)" },
        { key: "black", label: "Black", swatch: "#0B0B0C", css: "rgba(11, 11, 12, 0.54)" }
    ];

    const BACKGROUND_BY_KEY = new Map(BACKGROUNDS.map(b => [b.key, b]));

    // What a board with no colour of its own is. "theme" rather than a fixed paper
    // colour so a new easel arrives already matching Zen: the stylesheet's light-dark()
    // tint resolves to the pale wash under a light browser and the dark one under a
    // dark browser, and it keeps following if the scheme changes underneath it. Any of
    // the named boards is one menu click away for someone who wants a fixed colour.
    //
    // background/store.sys.mjs writes this key into every new document and cannot
    // import this file — it is a background module, and this one is per window — so the
    // literal is repeated there with a pointer back to this constant.
    const DEFAULT_BACKGROUND = "theme";

    // Backgrounds that have been renamed or dropped. Applied on load so an existing
    // board moves across instead of silently reverting to the default.
    const BACKGROUND_ALIASES = new Map([["sage", "transparent"]]);

    // What a custom board is worth with no usable alpha of its own — opaque, the end of the scale the picker opens on.
    const DEFAULT_BG_ALPHA = 1;

    // Below this a custom board has effectively no colour of its own, and is treated the way "transparent" is.
    const SHEER_BG_ALPHA = 0.2;

    // A board painted in a colour no preset carries. One string, so nothing about the document schema changes.
    const CUSTOM_BG_RE = /^custom:(#[0-9a-f]{6}):([01](?:\.\d{1,2})?)$/i;

    function customBackground(hex, alpha) {
        const value = Number(alpha);
        const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_BG_ALPHA;
        return `custom:${normalizeColor(hex) || DEFAULT_COLOR}:${clamped.toFixed(2)}`;
    }

    function parseCustomBackground(value) {
        const match = CUSTOM_BG_RE.exec(String(value || "").trim());
        if (!match) return null;
        return { color: match[1].toLowerCase(), alpha: Math.min(1, Math.max(0, parseFloat(match[2]))) };
    }

    // The one place a stored background key is turned into a live one.
    function resolveBackground(key) {
        const custom = parseCustomBackground(key);
        if (custom) return customBackground(custom.color, custom.alpha);
        const aliased = BACKGROUND_ALIASES.get(key) || key;
        return BACKGROUND_BY_KEY.has(aliased) ? aliased : DEFAULT_BACKGROUND;
    }

    // How much of itself a board paints, read back off a preset's own css. null means the board has no colour of its own.
    function alphaOf(css) {
        const value = String(css || "").trim();
        if (!value) return null;
        if (value === "transparent") return 0;
        const match = /rgba\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,/]+([\d.]+)\s*\)/i.exec(value);
        return match ? Number(match[1]) : 1;
    }

    // What a background value paints, for a preset key and a custom colour alike — the single seam every consumer reads through.
    function backgroundPreset(value) {
        const custom = parseCustomBackground(value);
        if (!custom) {
            const preset = BACKGROUND_BY_KEY.get(resolveBackground(value));
            // Carries its own alpha out with it, so the picker can show what a preset actually
            // is. `sheer` is stated rather than left off: both halves of this function return
            // the same shape, so a caller testing it does not have to know which branch it got.
            // A named board is never sheer — that is a thing only a dragged alpha can be.
            return preset ? { ...preset, alpha: alphaOf(preset.css), sheer: false } : null;
        }

        const rgb = rgbOf(custom.color) || [0, 0, 0];
        return {
            // Rebuilt from the parsed parts rather than re-running resolveBackground over the
            // string it was just handed: same canonical result, one regex instead of two.
            key: customBackground(custom.color, custom.alpha),
            label: "Custom",
            // A zero-alpha board declines to tint at all, which is what the "transparent" preset means.
            css: custom.alpha > 0 ? `rgba(${rgb.join(", ")}, ${custom.alpha})` : "transparent",
            swatch: custom.color,
            alpha: custom.alpha,
            sheer: custom.alpha < SHEER_BG_ALPHA,
            image: []
        };
    }

    // The colour to paint under a rasterised board — an export or a library
    // thumbnail — or null for "paint nothing". Both "theme" and "transparent" mean
    // nothing: a theme board has no colour of its own, and a transparent one has
    // deliberately declined to have one. Callers that cannot express transparency
    // (JPEG, and the library tile) substitute their own opaque default, which is why
    // this answers null rather than handing back "transparent" for them to paint.
    //
    // The opaque `swatch`, not the tint: a PNG dropped into another app has no Zen
    // window behind it to tint, so the alpha would come out as a half-erased board.
    function backgroundFill(key) {
        const preset = backgroundPreset(key);
        // A board dragged almost all the way to transparent has no colour to export, the same as the "transparent" preset.
        if (!preset || preset.sheer) return null;
        if (preset.swatch) return preset.swatch;
        return preset.css && preset.css !== "transparent" ? preset.css : null;
    }

    // The rgb triple of a computed or authored colour, or null. Split out of
    // luminanceOf because the board's chrome needs the channels themselves: the topbar
    // and the floating panels are the board's own colour at a different alpha, and
    // "same hue, different alpha" cannot be expressed by reusing one resolved value.
    function rgbOf(cssColor) {
        const value = String(cssColor || "").trim();

        const fn = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
        if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];

        // The palette is stored as hex, so a helper that only understood rgb() would
        // silently return null for every swatch — and a caller choosing a contrasting
        // ink would always pick the same one.
        const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
        if (!hex) return null;
        const h = hex[1].length === 3 ? hex[1].split("").map(c => c + c).join("") : hex[1];
        return [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map(p => parseInt(p, 16));
    }

    // Arc's own Easel typefaces, minus the ones that are commercially licensed and
    // could not be redistributed — see fonts/LICENSE.md. Each stack ends in a generic
    // family so text still renders sensibly if a file is ever missing.
    const FONTS = [
        { key: "system", label: "System", css: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
        { key: "inter", label: "Inter", css: '"Zen Easel Inter", system-ui, sans-serif' },
        { key: "nunito", label: "Nunito", css: '"Zen Easel Nunito", system-ui, sans-serif' },
        { key: "garamond", label: "EB Garamond", css: '"Zen Easel Garamond", Georgia, serif' },
        { key: "inconsolata", label: "Inconsolata", css: '"Zen Easel Inconsolata", ui-monospace, monospace' },
        { key: "spacemono", label: "Space Mono", css: '"Zen Easel Space Mono", ui-monospace, monospace' }
    ];

    const FONT_BY_KEY = new Map(FONTS.map(f => [f.key, f]));
    const fontCss = key => (FONT_BY_KEY.get(key) || FONTS[0]).css;

    // Arc's five paragraph styles — EaselTextStyle is body, h2, h1, h0, ultra. They are
    // presets over fontSize rather than a separate axis, so the free stepper keeps working
    // and a box nudged off a preset is simply "custom", which is what the stepper already
    // produced before these existed. The ramp continues the ~1.5x progression the first
    // three already used.
    const TEXT_STYLES = [
        { key: "body", label: "Body", size: 32 },
        { key: "h2", label: "H2", size: 52 },
        { key: "h1", label: "H1", size: 80 },
        { key: "h0", label: "H0", size: 120 },
        { key: "ultra", label: "Ultra", size: 180 }
    ];
    const TEXT_STYLE_BY_KEY = new Map(TEXT_STYLES.map(s => [s.key, s]));

    // The style an easel's heading is created at. One named constant rather than a size
    // repeated across the store, the canvas and the migration path.
    const TITLE_STYLE = "h0";

    // EaselFillStyle. "hug" is Arc's highlighter: a filled block that hugs the measured
    // bounds of each line rather than the object's box, so it reads as marker over text
    // instead of a coloured rectangle behind it.
    const TEXT_FILLS = ["none", "hug"];

    // In Arc mode the board is a page read like a PDF: the width of the window, top edge
    // at y = 0, extending downward as content is added. How much empty room to leave
    // below the lowest object, in multiples of the window height — enough to work into
    // without the page being endlessly, uselessly long.
    const PAGE_TRAILING_SCREENS = 3;

    // A board's canvasMode is "verticallyScrolling" (Arc mode: the page above, reflowing
    // with the window) or "infinite" (an unbounded plane, Excalidraw-style). New boards
    // start in Arc mode: a board that is exactly the window is what someone opening a
    // blank easel expects. See the note on canvasMode in canvas.uc.js. Repeated as a
    // literal in background/store.sys.mjs, which writes it into every new document and
    // cannot import this file.
    const DEFAULT_CANVAS_MODE = "verticallyScrolling";

    // Relative luminance of a computed color string, used to decide whether the grid
    // should be drawn dark-on-light or light-on-dark. Alpha is ignored on purpose: a
    // board tint is judged by the colour it is, not by how much of it is showing.
    function luminanceOf(cssColor) {
        const rgb = rgbOf(cssColor);
        if (!rgb) return 1;

        const channel = raw => {
            const v = Number(raw) / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    }

    // HSV rather than HSL, because that is what the wheel is: angle is hue, radius is saturation, and the slider is value.
    function hexToHsv(value) {
        const [r, g, b] = (rgbOf(colorCss(value)) || [0, 0, 0]).map(c => c / 255);
        const max = Math.max(r, g, b);
        const delta = max - Math.min(r, g, b);

        let h = 0;
        if (delta) {
            if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / delta + 2;
            else h = (r - g) / delta + 4;
            h *= 60;
        }
        return { h, s: max ? delta / max : 0, v: max };
    }

    function hsvToHex(h, s, v) {
        const channel = n => {
            const k = (n + h / 60) % 6;
            return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
        };
        return "#" + [channel(5), channel(3), channel(1)]
            .map(c => c.toString(16).padStart(2, "0")).join("");
    }

    /* ------------------------------------------------------------ construction */

    const uuid = () => {
        try { return crypto.randomUUID(); } catch { }
        return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    };

    // How see-through an object is drawn, as a fraction. Every object carries one — a
    // capture and a pen stroke fade the same way — so it lives beside x/y/rotation rather
    // than inside any one type's sub-object.
    //
    // The floor is not zero on purpose. A fully invisible object is still on the board,
    // still selectable and still in the way, and the only thing it tells you is that
    // something has gone wrong; MIN leaves a ghost you can find again and drag the slider
    // back up. STEP is what the slider moves in, kept here so the control and the
    // validator cannot disagree about which values are representable.
    const OPACITY = { min: 0.1, max: 1, step: 0.05 };

    const clampOpacity = value => {
        if (typeof value !== "number" || !Number.isFinite(value)) return 1;
        return Math.min(OPACITY.max, Math.max(OPACITY.min, value));
    };

    const DEFAULT_SIZE = {
        text: { w: 240, h: 40 },
        shape: { w: 160, h: 120 },
        ink: { w: 0, h: 0 },
        image: { w: 320, h: 200 },
        webcard: { w: 400, h: 260 },
        // Wider than a card: this one is a page being read, not a clipping being shown.
        webBrowser: { w: 560, h: 400 }
    };

    function createObject(type, props = {}) {
        const now = Date.now();
        const size = DEFAULT_SIZE[type] || { w: 160, h: 120 };
        const obj = {
            id: uuid(),
            type,
            x: 0, y: 0,
            w: size.w, h: size.h,
            rotation: 0,
            opacity: 1,
            // Pinned to the board: the pointer passes straight through it, so it cannot be
            // hovered, selected, dragged, resized or edited. Right-click still finds it —
            // that is the only way back to one, and the only way to unlock it.
            locked: false,
            color: DEFAULT_COLOR,
            createdAt: now,
            updatedAt: now,
            ...props
        };

        if (type === "text" && !obj.text) {
            obj.text = { content: "", fontSize: 24, fontFamily: "system", align: "left" };
        }
        if (type === "shape" && !obj.shape) {
            obj.shape = { kind: "rectangle", strokeWidth: 6, filled: false };
        }
        if (type === "ink" && !obj.ink) {
            obj.ink = { points: [], strokeWidth: 8 };
        }
        // Lines and arrows carry their endpoints as fractions of their own bounding
        // box. Storing a bare box would lose which diagonal was drawn, so a line
        // dragged up-and-right would silently flip to down-and-right on reload.
        if (type === "shape" && (obj.shape.kind === "line" || obj.shape.kind === "arrow")) {
            if (!obj.shape.a) obj.shape.a = [0, 0];
            if (!obj.shape.b) obj.shape.b = [1, 1];
        }
        return obj;
    }

    // Objects are stored with non-negative width and height so every consumer can
    // assume x,y is the top-left corner. Drags that run right-to-left or bottom-to-top
    // are normalised here rather than at each call site.
    function normalize(obj) {
        if (obj.w < 0) { obj.x += obj.w; obj.w = -obj.w; flipEndpoints(obj, "x"); }
        if (obj.h < 0) { obj.y += obj.h; obj.h = -obj.h; flipEndpoints(obj, "y"); }
        return obj;
    }

    function flipEndpoints(obj, axis) {
        if (obj.type !== "shape" || !obj.shape || !obj.shape.a) return;
        const i = axis === "x" ? 0 : 1;
        obj.shape.a[i] = 1 - obj.shape.a[i];
        obj.shape.b[i] = 1 - obj.shape.b[i];
    }

    /* ---------------------------------------------------------------- geometry */

    const bounds = obj => ({ x: obj.x, y: obj.y, w: obj.w, h: obj.h });

    function unionBounds(objects) {
        if (!objects.length) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const obj of objects) {
            minX = Math.min(minX, obj.x);
            minY = Math.min(minY, obj.y);
            maxX = Math.max(maxX, obj.x + obj.w);
            maxY = Math.max(maxY, obj.y + obj.h);
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    const intersects = (a, b) =>
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    function distanceToSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        // Degenerate segment: a zero-length line is just its start point.
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
        const cx = x1 + t * dx, cy = y1 + t * dy;
        return Math.hypot(px - cx, py - cy);
    }

    // Rotates a point about a centre. The one primitive every rotation-aware caller
    // needs, and the reason none of them has to know how the renderer applies it.
    function rotatePoint(x, y, cx, cy, degrees) {
        if (!degrees) return { x, y };
        const radians = (degrees * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const dx = x - cx;
        const dy = y - cy;
        return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    }

    // The point in the object's own unrotated frame. The renderer draws a rotated
    // object by rotating the context about its centre and then drawing it as if it
    // were upright, so undoing exactly that transform lets every test below stay the
    // axis-aligned one it already was.
    function toLocal(obj, wx, wy) {
        if (!obj.rotation) return { x: wx, y: wy };
        return rotatePoint(wx, wy, obj.x + obj.w / 2, obj.y + obj.h / 2, -obj.rotation);
    }

    // Hit tests take a tolerance in world units so the caller can widen the target as
    // the canvas zooms out — a 3px stroke at 10% zoom is otherwise unclickable.
    function hitTest(obj, wx, wy, tolerance = 6) {
        const b = bounds(obj);

        // Rotation is undone once, here, rather than in each of the four branches
        // below — every one of them is a comparison against the object's own upright
        // box, which is precisely what the local frame restores.
        ({ x: wx, y: wy } = toLocal(obj, wx, wy));

        if (obj.type === "shape" && obj.shape && (obj.shape.kind === "line" || obj.shape.kind === "arrow")) {
            const [ax, ay] = obj.shape.a, [bx, by] = obj.shape.b;
            const x1 = b.x + ax * b.w, y1 = b.y + ay * b.h;
            const x2 = b.x + bx * b.w, y2 = b.y + by * b.h;
            const width = (obj.shape.strokeWidth || 3) / 2;
            return distanceToSegment(wx, wy, x1, y1, x2, y2) <= width + tolerance;
        }

        if (obj.type === "ink" && obj.ink && obj.ink.points.length) {
            const width = (obj.ink.strokeWidth || 4) / 2;
            const limit = width + tolerance;
            const pts = obj.ink.points;
            if (pts.length === 1) return Math.hypot(wx - pts[0][0], wy - pts[0][1]) <= limit;
            for (let i = 1; i < pts.length; i++) {
                if (distanceToSegment(wx, wy, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= limit) {
                    return true;
                }
            }
            return false;
        }

        if (obj.type === "shape" && obj.shape && obj.shape.kind === "ellipse") {
            const rx = b.w / 2 + tolerance, ry = b.h / 2 + tolerance;
            if (rx <= 0 || ry <= 0) return false;
            const nx = (wx - (b.x + b.w / 2)) / rx;
            const ny = (wy - (b.y + b.h / 2)) / ry;
            return nx * nx + ny * ny <= 1;
        }

        return wx >= b.x - tolerance && wx <= b.x + b.w + tolerance &&
            wy >= b.y - tolerance && wy <= b.y + b.h + tolerance;
    }

    /* ------------------------------------------------------------- ink pathing */

    /* ------------------------------------------------------------------ ink */

    // Bounds come from the painted outline rather than the raw samples, so a thick
    // variable-width stroke is fully inside its own box and the selection rectangle
    // matches what is on screen.
    function recomputeInkBounds(obj) {
        const points = obj.ink.points;
        if (!points.length) return obj;

        const Freehand = window.ZenEaselFreehand;
        let box = null;

        if (Freehand) {
            box = Freehand.outlineBounds(Freehand.getStrokeOutline(points, {
                size: obj.ink.strokeWidth || 4,
                thinning: window.ZenEaselUtil.prefs["ink-style"] === "uniform" ? 0 : 0.6,
                simulatePressure: obj.ink.simulatePressure !== false
            }));
        }

        if (!box) {
            // Fallback if the stroke module is unavailable: pad the sample extents by
            // half the nominal width.
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of points) {
                if (p[0] < minX) minX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] > maxY) maxY = p[1];
            }
            const pad = (obj.ink.strokeWidth || 4) / 2 + 1;
            box = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
        }

        obj.x = box.x;
        obj.y = box.y;
        obj.w = box.w;
        obj.h = box.h;
        return obj;
    }

    /* ------------------------------------------------------------- migration */

    // Flattens v0.1's contenteditable markup to plain text. Deliberately not a DOM
    // parse: this runs over every text object at load, and the markup it has to handle
    // is only ever what contenteditable produced — line breaks and escaped entities.
    function htmlToText(html) {
        return html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(div|p|li)>/gi, "\n")
            .replace(/<[^>]*>/g, "")
            .replace(/&nbsp;/gi, " ")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/g, "'")
            // Ampersand last, or "&amp;lt;" would decode twice.
            .replace(/&amp;/gi, "&")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/\s+$/, "");
    }

    /* ------------------------------------------------------------ validation */

    // Shared with the background store, which enforces the same rules on the far side
    // of the page boundary — and with the live-tile loader. Three call sites drifting
    // apart is how the hole reopens, so there is exactly one definition, and it lives
    // in an ES module because that is the only form both a window script and a
    // background module can reach.
    const { isSafeId, isSafeAssetName, safeExternalUrl, safeFaviconUrl } =
        ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/validate.sys.mjs");

    /* ------------------------------------------------------------- embedding */

    // YouTube's own hosts. Matched exactly rather than by suffix: "youtube.com.evil.tld"
    // ends with the string and is not YouTube, and this decides what gets rewritten into
    // a URL we then load.
    const YOUTUBE_HOSTS = new Set([
        "youtube.com", "www.youtube.com", "m.youtube.com",
        "music.youtube.com", "youtu.be", "www.youtu.be"
    ]);

    // A video id is eleven characters of YouTube's own alphabet. Checked before it is
    // interpolated into a URL, so nothing from a link can add path segments or a query.
    const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

    // A watch page inside a 560px tile is mostly chrome — comments, sidebar, a consent
    // banner — and many of those pages decline to be framed at all. The embed player is
    // the part anyone wants on a board, and it is what Arc uses too: its Easel YouTube
    // support goes through YouTubePlayerKit's bundled YouTubePlayer.html, which is an
    // IFrame player, not a native decoder.
    //
    // Returns the embed URL, or null when this is not a YouTube video — callers treat
    // null as "use the URL you already had".
    function youtubeEmbedUrl(raw) {
        const spec = safeExternalUrl(raw);
        if (!spec) return null;

        let uri;
        try {
            uri = new URL(spec);
        } catch (e) {
            return null;
        }
        if (!YOUTUBE_HOSTS.has(uri.host)) return null;

        let id = null;
        if (uri.host === "youtu.be" || uri.host === "www.youtu.be") {
            id = uri.pathname.slice(1).split("/")[0];
        } else if (uri.pathname === "/watch") {
            id = uri.searchParams.get("v");
        } else {
            // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id> — all the same shape.
            const match = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(uri.pathname);
            if (match) id = match[1];
        }

        if (!id || !YOUTUBE_ID_RE.test(id)) return null;

        // A start offset is the one parameter worth carrying across, because a link
        // shared at a timestamp was shared *for* the timestamp. Read as an integer so
        // nothing else can ride along in it.
        const start = parseInt(uri.searchParams.get("t") || uri.searchParams.get("start"), 10);
        const query = Number.isInteger(start) && start > 0 ? `?start=${start}` : "";

        // Re-validated on the way out like everything else, even though it was just
        // built from constants — the gate is not skipped because the caller is us.
        return safeExternalUrl(`https://www.youtube.com/embed/${id}${query}`);
    }

    // The geometry a live web card is reconstructed from: the viewport size and scroll
    // offset at capture time, plus the captured rectangle in viewport coordinates.
    // Returns null — meaning "this card cannot go live" — rather than repairing a partial
    // record, because a half-believed crop would render the wrong region of a real
    // website, which is worse than showing the screenshot it already has.
    function sanitizeCapture(capture) {
        if (!capture || typeof capture !== "object") return null;

        const size = readSize(capture.webContentSize);
        const offset = readPoint(capture.webContentOffset);
        const frame = readRect(capture.frameRelativeToViewport);
        if (!size || !offset || !frame) return null;

        return {
            type: capture.type === "fullWindow" ? "fullWindow" : "partialPage",
            webContentSize: size,
            // Optional, and null for every capture taken before it existed. The layout box
            // above excludes the scrollbar gutter; this one includes it, and it is the box
            // media queries and vw units are resolved against. A card without it lays out
            // exactly as it always did — which is what keeps older boards working — so this
            // is read as "unknown", never as "there was no gutter".
            viewport: readSize(capture.viewport),
            webContentOffset: offset,
            frameRelativeToViewport: frame
        };

        function finite(v) { return typeof v === "number" && Number.isFinite(v); }
        function readSize(v) {
            return v && finite(v.w) && finite(v.h) && v.w > 0 && v.h > 0 ? { w: v.w, h: v.h } : null;
        }
        function readPoint(v) {
            return v && finite(v.x) && finite(v.y) ? { x: v.x, y: v.y } : null;
        }
        function readRect(v) {
            return v && finite(v.x) && finite(v.y) && finite(v.w) && finite(v.h) && v.w > 0 && v.h > 0
                ? { x: v.x, y: v.y, w: v.w, h: v.h } : null;
        }
    }

    // A scroll position, or null. Same shape as a capture's webContentOffset but without a
    // capture around it — a web tile has no crop, only a place it was last left.
    //
    // x is allowed to be negative and y is not. That is not an inconsistency: window.scrollX
    // is negative on an RTL document, which is an ordinary page and not a corrupt record,
    // while a negative scrollY has no meaning anywhere. Rejecting both threw away the whole
    // offset for every right-to-left site, and disagreed with readPoint, which the capture's
    // own offset goes through and which allows either sign.
    function readOffset(v) {
        const finite = n => typeof n === "number" && Number.isFinite(n);
        if (!v || typeof v !== "object" || !finite(v.x) || !finite(v.y)) return null;
        if (v.y < 0) return null;
        return { x: Math.round(v.x), y: Math.round(v.y) };
    }

    // Ceilings on what a single object may contain.
    //
    // Every field below was type-checked but unbounded, which is a different question from
    // whether it is well-formed. A document is local, user-owned data — this is not a trust
    // boundary — but it can be hand-edited, restored from a backup, or truncated by a crash,
    // and the failure mode of an unbounded one is that opening the board wedges the page with
    // no way back to it. These turn "the easel will not open" into "the easel opens, with one
    // object degraded", which is the outcome the rest of this function is already written for.
    //
    // Generous on purpose: a long note and a dense ink stroke both stay well inside these.
    const MAX_TEXT_LENGTH = 100_000;
    const MAX_INK_POINTS = 100_000;

    // Documents are read back from disk that a future version may have written, or
    // that a crash may have truncated. Anything that survives JSON.parse is coerced
    // into a shape the renderers can handle rather than trusted outright.
    // `legacyPalette` names which of Arc's two palettes an unmigrated colour key should resolve through — see _hydrate.
    function sanitize(obj, legacyPalette) {
        if (!obj || typeof obj !== "object") return null;
        if (!obj.id || typeof obj.id !== "string") return null;
        if (!["text", "shape", "ink", "image", "webcard", "webBrowser"].includes(obj.type)) return null;

        const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
        obj.x = num(obj.x, 0);
        obj.y = num(obj.y, 0);
        obj.w = Math.max(num(obj.w, 10), 0);
        obj.h = Math.max(num(obj.h, 10), 0);
        obj.rotation = num(obj.rotation, 0);
        // Clamped rather than rejected. A document written before opacity existed has no
        // field at all, and every one of those objects is meant to be fully opaque — so
        // the missing case and the malformed case both land on 1.
        obj.opacity = clampOpacity(obj.opacity);
        // Coerced rather than trusted, for the same reason shape.filled is: hit-testing
        // branches on it, and a truthy non-boolean read back from a hand-edited file would
        // make an object unclickable for a reason nothing in the UI could then explain.
        // A document written before locking existed has no field, which reads as unlocked.
        obj.locked = obj.locked === true;
        // Hex on every board written since colours stopped being palette keys; the legacy lookup is what carries an older one across.
        obj.color = normalizeColor(obj.color) ||
            (LEGACY_PALETTES[legacyPalette] || LEGACY_PALETTES.vibrant)[obj.color] ||
            DEFAULT_COLOR;

        if (obj.type === "text") {
            if (!obj.text || typeof obj.text !== "object") obj.text = {};
            // v0.1 stored contenteditable markup. Canvas text is plain, one font and
            // size per box, so anything written by the old renderer is converted on
            // load. No formatting commands were ever wired up, so this loses nothing
            // beyond stray markup.
            if (typeof obj.text.content !== "string") {
                obj.text.content = typeof obj.text.html === "string" ? htmlToText(obj.text.html) : "";
            }
            // Truncated rather than rejected: the box keeps its position and styling, and
            // what is lost is text that could not have been read on a board anyway. Word
            // wrapping is O(length) per repaint, so this is what keeps a pathological
            // document from making the canvas unresponsive.
            if (obj.text.content.length > MAX_TEXT_LENGTH) {
                obj.text.content = obj.text.content.slice(0, MAX_TEXT_LENGTH);
            }
            delete obj.text.html;
            obj.text.fontSize = num(obj.text.fontSize, 32);
            if (!FONT_BY_KEY.has(obj.text.fontFamily)) obj.text.fontFamily = "system";
            if (!TEXT_FILLS.includes(obj.text.fill)) obj.text.fill = "none";
            // Coerced like locked: the renderer branches on it, and a hand-edited "yes" must not count.
            obj.text.markdown = obj.text.markdown === true;
        } else if (obj.type === "shape") {
            if (!obj.shape || typeof obj.shape !== "object") obj.shape = {};
            if (!["rectangle", "ellipse", "triangle", "line", "arrow"].includes(obj.shape.kind)) {
                obj.shape.kind = "rectangle";
            }
            obj.shape.strokeWidth = num(obj.shape.strokeWidth, 6);
            // Coerced rather than trusted. The renderer branches on it directly, and a
            // truthy non-boolean read back from a hand-edited file would make a shape solid
            // for reasons nothing in the UI could then explain or undo.
            obj.shape.filled = obj.shape.filled === true;
            if (obj.shape.kind === "line" || obj.shape.kind === "arrow") {
                if (!Array.isArray(obj.shape.a) || obj.shape.a.length !== 2) obj.shape.a = [0, 0];
                if (!Array.isArray(obj.shape.b) || obj.shape.b.length !== 2) obj.shape.b = [1, 1];
            }
        } else if (obj.type === "ink") {
            if (!obj.ink || typeof obj.ink !== "object") obj.ink = {};
            obj.ink.points = Array.isArray(obj.ink.points)
                // Capped before filtering, not after: filter() walks the whole array, and
                // the array is the thing that might be enormous.
                ? obj.ink.points.slice(0, MAX_INK_POINTS)
                    .filter(p => Array.isArray(p) && p.length >= 2 &&
                        Number.isFinite(p[0]) && Number.isFinite(p[1]))
                : [];
            obj.ink.strokeWidth = num(obj.ink.strokeWidth, 8);
            if (!obj.ink.points.length) return null; // an ink object with no stroke is invisible and unselectable
        } else if (obj.type === "image") {
            if (!obj.image || typeof obj.image !== "object") return null;
            // An asset name that is not a plain filename is dropped rather than
            // corrected: there is no benign way for one to contain a path separator,
            // so the only thing a repair would achieve is loading whatever it points at.
            if (!isSafeAssetName(obj.image.asset)) return null;
        } else if (obj.type === "webcard") {
            if (!obj.webcard || typeof obj.webcard !== "object") return null;
            if (!isSafeAssetName(obj.webcard.asset)) obj.webcard.asset = "";
            // Store the canonical spec, so what is on disk is already normalised and
            // gets re-validated on every load.
            obj.webcard.url = safeExternalUrl(obj.webcard.url) || "";
            // The favicon is loaded as a plain <img> by the floating card bar, which is
            // chrome-privileged DOM in the browser window. screenshot-hook already keeps
            // only local icons when a capture is taken; this is the same gate applied on the
            // way back in, so a hand-edited board file cannot turn every render of a card
            // into a request to somebody's server.
            obj.webcard.favicon = safeFaviconUrl(obj.webcard.favicon);
            obj.webcard.capture = sanitizeCapture(obj.webcard.capture);
            obj.webcard.useLiveWebCard = obj.webcard.useLiveWebCard === true;
            // The container the capture was taken in. Cookies are keyed on this, so a card
            // that forgets it shows the site signed out — or signed in as somebody else.
            // Absent on every card taken before this shipped, which reads as the default
            // container and is the behaviour those cards already had.
            obj.webcard.userContextId =
                Number.isInteger(obj.webcard.userContextId) && obj.webcard.userContextId > 0
                    ? obj.webcard.userContextId : 0;
            // Unlike useLiveWebCard this one *is* honoured on load, because the only thing
            // it can do is make a board quieter.
            obj.webcard.muted = obj.webcard.muted === true;
            // Needs either pixels or a link; with neither there is nothing to show.
            if (!obj.webcard.asset && !obj.webcard.url) return null;
        } else if (obj.type === "webBrowser") {
            // Arc's webBrowser object: a live site embedded in the board, as opposed to a
            // webcard, which is a screenshot that can be *made* live. There is no crop —
            // the tile is simply a window onto the page at the object's own size.
            if (!obj.webBrowser || typeof obj.webBrowser !== "object") return null;
            obj.webBrowser.url = safeExternalUrl(obj.webBrowser.url) || "";
            if (!obj.webBrowser.url) return null;
            if (typeof obj.webBrowser.title !== "string") obj.webBrowser.title = "";
            obj.webBrowser.muted = obj.webBrowser.muted === true;
            // The last frame this tile was running, written when it stops. Unlike a
            // webcard's asset it is not what the object *is* — a tile with no poster is
            // still a tile, so a bad name is cleared rather than rejecting the object.
            //
            // Gated on the same name test every other asset goes through: it is
            // interpolated into a file path under the easel's own assets directory, and a
            // board file is hand-editable.
            if (!isSafeAssetName(obj.webBrowser.poster)) obj.webBrowser.poster = "";
            // Set when the user took the poster deliberately, with the refresh button. An
            // automatic capture will not overwrite one of these — which is the whole point,
            // since an automatic capture cannot tell a logged-in page from a login wall. It
            // is spent when the tile is browsed off the page it was taken of, so it survives
            // a reload of the board but not a change of subject.
            obj.webBrowser.posterPinned = obj.webBrowser.posterPinned === true;
            // Where in the page the refresh button was pressed, so a web tile reopens where
            // it was left rather than at the top. Unlike a webcard there is no crop to
            // reproduce, so this is a preference rather than a contract: an unreproducible
            // one costs a scroll position, not a wrong picture.
            obj.webBrowser.scrollOffset = readOffset(obj.webBrowser.scrollOffset);
        }

        return obj;
    }

    window.ZenEaselObjects = {
        STANDARD_ROWS,
        DEFAULT_COLOR,
        RECENT_LIMIT,
        normalizeColor,
        hexToHsv,
        hsvToHex,
        TITLE_STYLE,
        BACKGROUNDS,
        DEFAULT_BACKGROUND,
        DEFAULT_BG_ALPHA,
        themeColor,
        customBackground,
        parseCustomBackground,
        backgroundPreset,
        resolveBackground,
        backgroundFill,
        FONTS,
        FONT_BY_KEY,
        TEXT_STYLES,
        TEXT_STYLE_BY_KEY,
        TEXT_FILLS,
        DEFAULT_SIZE,
        OPACITY,
        clampOpacity,
        PAGE_TRAILING_SCREENS,
        DEFAULT_CANVAS_MODE,
        fontCss,
        luminanceOf,
        rgbOf,
        colorCss,
        uuid,
        createObject,
        normalize,
        bounds,
        unionBounds,
        intersects,
        hitTest,
        rotatePoint,
        toLocal,
        distanceToSegment,
        recomputeInkBounds,
        htmlToText,
        youtubeEmbedUrl,
        isSafeId,
        isSafeAssetName,
        safeExternalUrl,
        sanitize
    };
})();
