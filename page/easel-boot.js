// Zen Easel — page bootstrap.
//
// Runs at parse time from a <script> tag in easel.xhtml, and is the only loader of the
// page side: theme.json registers nothing against about:easel, so Sine never loads or
// reloads these modules. Editing one means reloading the tab, which re-runs this from
// scratch. Loading at parse time — rather than on "load" and then after a JSON read off
// disk — is what makes a cold start, especially a session-restored tab, reliable.
//
// The module guards (`if (window.ZenEaselX) return`) stay because a parse-time script
// can still be re-entered — a manual loadSubScript from the console, say — and a guard
// costs one line.

"use strict";

(function () {
    const BASE = "chrome://sine/content/zen-easel/";

    // The modules were written against a browser window, where these are always present.
    // A system-principal page normally has them too, but the cost of being wrong is a
    // silent failure in the file picker and the clipboard, and the cost of the guard is
    // two lines.
    if (typeof Cc === "undefined") window.Cc = Components.classes;
    if (typeof Ci === "undefined") window.Ci = Components.interfaces;

    // Ordered. Utilities first because every module reads ZenEaselUtil at definition
    // time; objects second because the canvas reaches into the object registry as soon
    // as it is constructed.
    const MODULES = [
        "modules/util.uc.js",
        "modules/objects.uc.js",
        "modules/markdown.uc.js",
        "modules/color-picker.uc.js",
        "modules/freehand.uc.js",
        "modules/guides.uc.js",
        "modules/renderer.uc.js",
        "modules/store.uc.js",
        "modules/text-editor.uc.js",
        "modules/text-controls.uc.js",
        "modules/shape-controls.uc.js",
        "modules/canvas.uc.js",
        "modules/tools.uc.js",
        "modules/library.uc.js",
        "modules/capture-page.uc.js",
        "modules/media-layer.uc.js",
        "modules/live-layer.uc.js",
        "page/easel-page.uc.js"
    ];

    for (const relative of MODULES) {
        try {
            Services.scriptloader.loadSubScript(BASE + relative, window);
        } catch (e) {
            console.error(`[zen-easel] page failed to load ${relative}:`, e);
        }
    }

    if (!window.ZenEaselPageInit) {
        console.error("[zen-easel] page bootstrap ran but no controller was defined");
        return;
    }

    // This script is in <head>, so it runs before <body> is parsed and the <zen-easel>
    // element does not exist yet. Loading the modules early is the point — defining the
    // custom element before the parser reaches the tag means it is upgraded in place
    // rather than after a flash of nothing — but the controller has to wait for the
    // element it binds to.
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => window.ZenEaselPageInit(), { once: true });
    } else {
        window.ZenEaselPageInit();
    }
})();
