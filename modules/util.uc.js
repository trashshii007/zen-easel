// Zen Easel — shared utilities.
//
// Loaded into two very different globals: the browser window (where the host lives) and
// the about:easel page. Everything here binds to whichever window it was loaded into,
// which is exactly what makes it work in both — el() builds nodes in the page's document
// when the page loads it, and in browser.xhtml when the host does.

"use strict";

(function () {
    if (window.ZenEaselUtil) return;

    /* ------------------------------------------------------------------ prefs */

    // Each pref is read in its own try: Services.prefs.get*Pref throws when the pref
    // exists with the wrong type, and the default argument only covers the missing case.
    // Sharing one try block would let a single bad about:config entry silently reset
    // every later pref to its default.
    const prefBool = (name, def) => { try { return Services.prefs.getBoolPref(name, def); } catch { return def; } };
    const prefInt = (name, def) => { try { return Services.prefs.getIntPref(name, def); } catch { return def; } };
    const prefStr = (name, def) => { try { return Services.prefs.getStringPref(name, def); } catch { return def; } };

    // Every pref below used to be read through Services.prefs from inside pointer
    // handlers — _snap() read two of them per object per pointermove, and _applyTransform
    // read two more per wheel tick. That is an XPCOM call in the innermost loop of a
    // drag. They are read once here and refreshed by an observer, so hot paths touch a
    // plain object.
    const PREF_BRANCH = "zen.easel.";
    const PREF_SPEC = {
        "grid": ["str", "dots"],
        "grid-size": ["int", 24],
        "snap": ["str", "guides"],
        "snap-to-grid": ["bool", false],
        "wheel": ["str", "zoom"],
        "ink-style": ["str", "variable"],
        "autosave-ms": ["int", 500],
        "debug": ["bool", false],
        "live.enabled": ["bool", true],
        "live.max-tiles": ["int", 3],
        "live.allow-http": ["bool", false],
        "live.container": ["int", 0],
        "live.private": ["bool", false]
    };

    const prefs = Object.create(null);

    function readPref(name) {
        const [kind, fallback] = PREF_SPEC[name];
        const full = PREF_BRANCH + name;
        prefs[name] = kind === "bool" ? prefBool(full, fallback)
            : kind === "int" ? prefInt(full, fallback)
                : prefStr(full, fallback);
    }

    for (const name in PREF_SPEC) readPref(name);

    // A branch observer rather than one per pref: the topic carries the leaf name, so a
    // single registration keeps the cache honest and toggling a pref takes effect
    // immediately.
    const prefObserver = {
        observe(_subject, _topic, data) {
            if (data in PREF_SPEC) readPref(data);
        }
    };
    Services.prefs.addObserver(PREF_BRANCH, prefObserver);

    const log = (...args) => { if (prefs.debug) console.log("[zen-easel]", ...args); };

    /* --------------------------------------------------------- frame throttle */

    // Coalesces calls to at most one per animation frame, keeping the most recent
    // arguments. flush() runs a pending call immediately (needed at the end of a
    // gesture, so the last position is not left a frame behind); cancel() drops it.
    // Same shape as Excalidraw's throttleRAF, which solves exactly this problem.
    function throttleRAF(fn) {
        let handle = null;
        let lastArgs = null;

        const run = () => {
            handle = null;
            const args = lastArgs;
            lastArgs = null;
            if (args) fn(...args);
        };

        const throttled = (...args) => {
            lastArgs = args;
            if (handle === null) handle = window.requestAnimationFrame(run);
        };
        throttled.flush = () => {
            if (handle !== null) {
                window.cancelAnimationFrame(handle);
                handle = null;
            }
            if (lastArgs) {
                const args = lastArgs;
                lastArgs = null;
                fn(...args);
            }
        };
        throttled.cancel = () => {
            lastArgs = null;
            if (handle !== null) {
                window.cancelAnimationFrame(handle);
                handle = null;
            }
        };
        return throttled;
    }

    /* -------------------------------------------------------------- shortcuts */

    // "Ctrl+Shift+E" -> { ctrl, alt, shift, code }. Matching is done on e.code so the
    // binding survives non-QWERTY layouts, which is why the key half is translated to a
    // KeyX / DigitX / FX code up front rather than compared against e.key.
    function parseShortcut(str) {
        const parts = String(str || "").split("+").map(p => p.trim()).filter(Boolean);
        const spec = { ctrl: false, alt: false, shift: false, code: null };
        for (const part of parts) {
            const lower = part.toLowerCase();
            if (lower === "ctrl" || lower === "control") spec.ctrl = true;
            else if (lower === "alt" || lower === "option") spec.alt = true;
            else if (lower === "shift") spec.shift = true;
            else if (lower === "cmd" || lower === "meta" || lower === "command") spec.ctrl = true; // Windows: fold Cmd onto Ctrl
            else if (/^[a-z]$/i.test(part)) spec.code = "Key" + part.toUpperCase();
            else if (/^[0-9]$/.test(part)) spec.code = "Digit" + part;
            else if (/^f([1-9]|1[0-2])$/i.test(part)) spec.code = "F" + part.slice(1);
        }
        return spec.code ? spec : null;
    }

    function matchesShortcut(e, spec) {
        return !!spec &&
            e.code === spec.code &&
            e.ctrlKey === spec.ctrl &&
            e.altKey === spec.alt &&
            e.shiftKey === spec.shift &&
            !e.metaKey;
    }

    /* ------------------------------------------------------------ DOM helper */

    // No innerHTML prop. zen-library's version has one and nothing in either mod ever
    // passed it — its only function was to be available to whoever reached for it next,
    // in privileged chrome, from a helper that also handles document titles and page
    // URLs. The one case that genuinely needs markup is the toolbar's icons, and
    // tools.uc.js builds those with DOMParser + "image/svg+xml", which does not execute
    // script.
    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        const { className, id, textContent, style, dataset, ...rest } = props;

        if (className) node.className = className;
        if (id) node.id = id;
        if (textContent !== undefined) node.textContent = textContent;
        if (style) {
            if (typeof style === "string") {
                node.style.cssText = style;
            } else {
                for (const key in style) {
                    // Custom properties have to go through setProperty. Assigning
                    // node.style["--x"] silently does nothing on a CSSStyleDeclaration,
                    // which is what left every palette swatch unpainted.
                    if (key.startsWith("--")) node.style.setProperty(key, style[key]);
                    else node.style[key] = style[key];
                }
            }
        }
        if (dataset) Object.assign(node.dataset, dataset);
        for (const key in rest) {
            if (rest[key] === undefined || rest[key] === null) continue;
            if (key.startsWith("on")) node[key] = rest[key];
            else node.setAttribute(key, rest[key]);
        }

        const list = Array.isArray(children) ? children : [children];
        for (const child of list) {
            if (child === null || child === undefined || child === false) continue;
            node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }

    // SVG needs createElementNS; el() above would silently produce dead HTML elements.
    function svg(tag, attrs = {}, children = []) {
        const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const key in attrs) {
            if (attrs[key] === undefined || attrs[key] === null) continue;
            node.setAttribute(key, attrs[key]);
        }
        const list = Array.isArray(children) ? children : [children];
        for (const child of list) if (child) node.appendChild(child);
        return node;
    }

    window.ZenEaselUtil = {
        el, svg, log, parseShortcut, matchesShortcut, throttleRAF,
        // Cached, observer-backed. Read these in hot paths; the prefBool/prefInt/prefStr
        // functions below go through XPCOM and are for one-off reads only.
        prefs,
        prefBool, prefInt, prefStr,
        disposePrefs() {
            try { Services.prefs.removeObserver(PREF_BRANCH, prefObserver); } catch (e) { }
        }
    };
})();
