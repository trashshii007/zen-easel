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

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
    UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
    // RESULT_TYPE and RESULT_SOURCE live here; PROVIDER_TYPE and MAX_TEXT_LENGTH moved here from UrlbarUtils in Firefox 155, see providerTypes().
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

// registerProvider reads `type` up front, so a getter that throws on either build leaves the provider silently absent.
function providerTypes() {
    return lazy.UrlbarShared.PROVIDER_TYPE ?? UrlbarUtils.PROVIDER_TYPE;
}

function maxTextLength() {
    return lazy.UrlbarShared.MAX_TEXT_LENGTH ?? UrlbarUtils.MAX_TEXT_LENGTH ?? 255;
}

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
    get name() {
        return PROVIDER_NAME;
    }

    get type() {
        return providerTypes().PROFILE;
    }

    getPriority() {
        return 0;
    }

    async isActive(queryContext) {
        try {
            if (!queryContext.searchString) return false;
            if (queryContext.searchString.length < MIN_QUERY_LENGTH) return false;
            if (queryContext.searchString.length >= maxTextLength()) return false;
            if (lazy.UrlUtils?.REGEXP_LIKE_PROTOCOL?.test(queryContext.searchString)) {
                return false;
            }
            if (queryContext.isPrivate) return false;
            // A search mode narrows queryContext.sources to that mode's own source
            // (@history, @tabs, Zen's actions and workspaces), and OTHER_LOCAL is never
            // one of them — so every row this provider added would be dropped by the
            // manager's source filter anyway. Bail before doing the work.
            if (queryContext.searchMode) return false;
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
                // titleQuery is non-empty on every path that reaches here: the bare
                // keyword took the branch above, and an empty non-keyword query returned.
                score = scoreTitle(easel.title || "Untitled Easel", titleQuery);
                if (score < MIN_TITLE_SCORE) continue;
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
            // No prettyName entry: Zen's actions provider hides that node in its template
            // and unhides it per row, because only some of its rows carry one. Every easel
            // row does, so the template leaves it visible and there is nothing to toggle.
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
            win.gZenEaselHost.openEasel(id);
        } catch (e) {
            console.error("[zen-easel] urlbar could not open easel:", e);
        }
    }
}

// Idempotent, and no startup dance is needed around it: getInstanceForSap builds the
// manager on demand rather than waiting for one, so there is no window in which this can
// be "too early". The one real failure mode is a Zen API change, which retrying would
// not fix — the caller logs and the feature is simply absent until the mod is updated.
//
// UrlbarProvider is imported from the same moz-src specifier the manager itself uses, so
// the instanceof check in registerProvider sees the one class; the module map is keyed by
// resolved URL, and chrome://sine does not get a second copy of it.
export function installUrlbarProvider() {
    const instance = ProvidersManager.getInstanceForSap("urlbar");
    if (instance.getProvider(PROVIDER_NAME)) return;
    instance.registerProvider(new ZenUrlbarProviderEasels());
}
