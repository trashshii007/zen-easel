// Zen Easel — urlbar suggestions for boards.
//
// about:easel is chrome UI, so Places never records a visit. Closed boards therefore
// never appear as history or switch-to-tab. This provider reads the same index the
// library does and opens through gZenEaselHost.openEasel, so one tab per board still
// holds. Open boards are listed too: switch-to-tab for about:easel is unreliable
// (unloaded tabs, other spaces), and openEasel focuses an existing tab.
//
// Process-global for the same reason about:easel is: ProvidersManager is per-process,
// and a window script registering it would race every other window.

import {
    UrlbarProvider,
    UrlbarUtils
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { ProvidersManager } from "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
    UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
    // PROVIDER_TYPE / RESULT_TYPE / RESULT_SOURCE live here now, not on UrlbarUtils.
    UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
    BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
    UrlUtils: "resource://gre/modules/UrlUtils.sys.mjs",
    EaselStore: "chrome://sine/content/zen-easel/background/store.sys.mjs"
});

const PROVIDER_NAME = "ZenUrlbarProviderEasels";
const DYNAMIC_TYPE_NAME = "zen-easel";
const ICON = "chrome://sine/content/zen-easel/resources/zen-easel-board.svg";

const MAX_RESULTS = 5;
const MIN_QUERY_LENGTH = 2;
// Above mid-string noise. Prefix is 100+; a word-boundary token of 3+ chars is 73+.
const MIN_TITLE_SCORE = 70;
const KEYWORD_SCORE = 80;

const MAX_REGISTER_ATTEMPTS = 12;
const REGISTER_RETRY_MS = 250;

let gDelayedObserver = null;
let gRetryTimer = null;
let gRegisterAttempts = 0;
let gLoggedSuccess = false;

function scoreTitle(title, query) {
    if (!title || !query) return 0;
    const target = title.toLowerCase();
    const q = query.toLowerCase();
    if (q.length > target.length) return 0;
    if (target === q) return 200;
    if (target.startsWith(q)) return 100 + q.length;
    // Two-character tokens ("in", "to") and mid-string hits ("er" in "Browser")
    // are too noisy for the urlbar.
    if (q.length < 3) return 0;
    const index = target.indexOf(q);
    if (index < 0) return 0;
    if ([" ", "-", "_"].includes(target[index - 1])) {
        return 70 + q.length;
    }
    return 0;
}

function recency(easel) {
    return easel.lastOpenedAt || easel.updatedAt || easel.createdAt || 0;
}

function parseQuery(raw) {
    const query = (raw || "").trim().toLowerCase();
    if (query === "easel" || query === "easels") {
        return { keyword: true, titleQuery: "" };
    }
    if (query.startsWith("easel ")) {
        return { keyword: true, titleQuery: query.slice(6).trim() };
    }
    return { keyword: false, titleQuery: query };
}

function windowWithHost(preferred) {
    if (preferred?.gZenEaselHost) return preferred;
    try {
        const win = lazy.BrowserWindowTracker.getTopWindow({ private: false });
        if (win?.gZenEaselHost) return win;
    } catch (e) { }
    return preferred || null;
}

export class ZenUrlbarProviderEasels extends UrlbarProvider {
    constructor() {
        super();
    }

    get name() {
        return PROVIDER_NAME;
    }

    get type() {
        return lazy.UrlbarShared.PROVIDER_TYPE.PROFILE;
    }

    getPriority() {
        return 0;
    }

    async isActive(queryContext) {
        try {
            if (!queryContext.searchString) return false;
            if (queryContext.searchString.length < MIN_QUERY_LENGTH) return false;
            if (
                queryContext.searchString.length >= lazy.UrlbarShared.MAX_TEXT_LENGTH
            ) {
                return false;
            }
            if (lazy.UrlUtils?.REGEXP_LIKE_PROTOCOL?.test(queryContext.searchString)) {
                return false;
            }
            if (queryContext.isPrivate) return false;
            if (queryContext.searchMode) {
                const skipSources = [
                    lazy.UrlbarShared.RESULT_SOURCE?.WORKSPACES,
                    lazy.UrlbarShared.RESULT_SOURCE?.ZEN_ACTIONS,
                    UrlbarUtils?.RESULT_SOURCE?.WORKSPACES,
                    UrlbarUtils?.RESULT_SOURCE?.ZEN_ACTIONS
                ].filter(s => s != null);
                if (skipSources.includes(queryContext.searchMode.source)) {
                    return false;
                }
            }
            return true;
        } catch (e) {
            console.error("[zen-easel] urlbar isActive:", e);
            return false;
        }
    }

    async startQuery(queryContext, addCallback) {
        const { keyword, titleQuery } = parseQuery(
            queryContext.trimmedLowerCaseSearchString || queryContext.searchString
        );
        if (!keyword && !titleQuery) return;

        let easels;
        try {
            easels = await lazy.EaselStore.listEasels();
        } catch (e) {
            console.error("[zen-easel] urlbar could not list easels:", e);
            return;
        }
        if (!easels?.length) return;

        const scored = [];
        for (const easel of easels) {
            let score = 0;
            if (keyword && !titleQuery) {
                score = KEYWORD_SCORE;
            } else {
                const against = titleQuery || queryContext.trimmedLowerCaseSearchString;
                score = scoreTitle(easel.title || "Untitled Easel", against);
                if (keyword && score < MIN_TITLE_SCORE) score = 0;
                if (!keyword && score < MIN_TITLE_SCORE) continue;
                if (keyword && !score) continue;
            }
            scored.push({ easel, score });
        }

        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return recency(b.easel) - recency(a.easel);
        });

        const rows = scored.slice(0, MAX_RESULTS);
        for (let i = 0; i < rows.length; i++) {
            const easel = rows[i].easel;
            const title = easel.title || "Untitled Easel";
            const result = new lazy.UrlbarResult({
                type: lazy.UrlbarShared.RESULT_TYPE.DYNAMIC,
                source: lazy.UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
                // Pin only the first row of an "easel" keyword listing. Title matches
                // compete with history instead of crowding out the heuristic.
                ...(keyword && i === 0 ? { suggestedIndex: 1 } : {}),
                payload: {
                    dynamicType: DYNAMIC_TYPE_NAME,
                    title,
                    icon: ICON,
                    easelId: easel.id
                }
            });
            addCallback(this, result);
        }
    }

    getViewTemplate() {
        return {
            attributes: { selectable: true },
            children: [
                {
                    name: "icon",
                    tag: "img",
                    classList: ["urlbarView-favicon"]
                },
                {
                    name: "title",
                    tag: "span",
                    classList: ["urlbarView-title"],
                    children: [
                        {
                            name: "titleStrong",
                            tag: "strong"
                        }
                    ]
                },
                {
                    tag: "span",
                    classList: ["urlbarView-prettyName"],
                    name: "prettyName",
                    children: [
                        {
                            name: "prettyNameTitle",
                            tag: "span"
                        }
                    ]
                }
            ]
        };
    }

    getViewUpdate(result) {
        return {
            icon: {
                attributes: {
                    src: result.payload.icon || ICON
                }
            },
            titleStrong: {
                textContent: result.payload.title || "Untitled Easel",
                attributes: { dir: "ltr" }
            },
            prettyName: {
                attributes: { hidden: false }
            },
            prettyNameTitle: {
                textContent: "Easel",
                attributes: { dir: "ltr" }
            }
        };
    }

    onEngagement(queryContext, _controller, details) {
        if (queryContext?.isPrivate) return;
        const id = details?.result?.payload?.easelId;
        if (!id) return;
        const win = windowWithHost(
            details.element?.documentGlobal || details.element?.ownerGlobal
        );
        if (!win?.gZenEaselHost) return;
        try {
            win.gBrowser.selectedBrowser.focus();
        } catch (e) { }
        try {
            const opened = win.gZenEaselHost.openEasel(id);
            if (opened && typeof opened.then === "function") {
                opened.catch(e => console.error("[zen-easel] urlbar could not open easel:", e));
            }
        } catch (e) {
            console.error("[zen-easel] urlbar could not open easel:", e);
        }
    }
}

export function registerUrlbarProvider() {
    const instance = ProvidersManager.getInstanceForSap("urlbar");
    if (!instance) return false;
    if (instance.getProvider(PROVIDER_NAME)) return true;

    // chrome://sine and moz-src can resolve UrlbarProvider to different copies.
    // registerProvider uses instanceof, so we have to subclass the same class
    // the manager already accepted for Zen's own actions provider.
    const zen = instance.getProvider("ZenUrlbarProviderGlobalActions");
    const Base = zen ? Object.getPrototypeOf(zen.constructor) : UrlbarProvider;
    if (Object.getPrototypeOf(ZenUrlbarProviderEasels) !== Base) {
        Object.setPrototypeOf(ZenUrlbarProviderEasels, Base);
        Object.setPrototypeOf(ZenUrlbarProviderEasels.prototype, Base.prototype);
    }

    instance.registerProvider(new ZenUrlbarProviderEasels());
    return true;
}

function clearRetries() {
    if (gRetryTimer) {
        clearTimeout(gRetryTimer);
        gRetryTimer = null;
    }
    if (gDelayedObserver) {
        try {
            Services.obs.removeObserver(gDelayedObserver, "browser-delayed-startup-finished");
        } catch (e) { }
        gDelayedObserver = null;
    }
}

function install() {
    try {
        if (registerUrlbarProvider()) {
            clearRetries();
            if (!gLoggedSuccess) {
                gLoggedSuccess = true;
                console.info("[zen-easel] urlbar provider registered");
            }
            return true;
        }
    } catch (e) {
        console.error("[zen-easel] urlbar provider registration failed:", e);
    }

    if (gRegisterAttempts >= MAX_REGISTER_ATTEMPTS) {
        console.error("[zen-easel] urlbar provider gave up registering");
        clearRetries();
        return false;
    }
    gRegisterAttempts += 1;
    if (!gRetryTimer) {
        gRetryTimer = setTimeout(() => {
            gRetryTimer = null;
            install();
        }, REGISTER_RETRY_MS);
    }

    // Sine often loads after the first delayed-startup has already fired.
    if (!gDelayedObserver) {
        gDelayedObserver = { observe() { install(); } };
        try {
            Services.obs.addObserver(gDelayedObserver, "browser-delayed-startup-finished");
        } catch (e) { }
    }
    return false;
}

export function installUrlbarProvider() {
    if (gLoggedSuccess) {
        try { registerUrlbarProvider(); } catch (e) { }
        return;
    }
    // Retry in flight: still try now (host often runs after the manager is up)
    // but do not reset the budget or stack another timer.
    if (!gRetryTimer) gRegisterAttempts = 0;
    install();
}
