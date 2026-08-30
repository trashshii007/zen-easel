// Zen Easel — parent side of a live web card.
//
// The only thing that crosses from a live tile into privileged code is a link the user
// clicked, and this is where it is checked. The rule is that content is never trusted,
// even though the child actor is ours: the URL it sends is read from a page's DOM, so it
// gets the same scheme allowlist as a URL loaded off disk, and it opens with a null
// triggering principal rather than a privileged one.

import { safeExternalUrl } from "chrome://sine/content/zen-easel/background/validate.sys.mjs";

export class ZenEaselLiveParent extends JSWindowActorParent {
    receiveMessage(message) {
        switch (message.name) {
            case "ZenEaselLive:OpenLink":
                this.#openLink(message.data);
                break;
            case "ZenEaselLive:ContextMenu":
                this.#showEaselMenu(message.data);
                break;
            case "ZenEaselLive:Ready":
                this.#sendConfig();
                break;
        }
        return null;
    }

    // The child announcing itself, on every DOMContentLoaded and pageshow. It is the
    // child that knows when it exists, so it says so rather than the parent guessing:
    // the previous arrangement polled getActor() on a 100ms timer up to forty times per
    // tile and then sent the configuration exactly once, which meant a navigation that
    // switched content process brought a fresh actor holding nothing — no scroll pin, no
    // locks, no per-site CSS — with no way for anything to notice.
    #sendConfig() {
        try {
            const browser = this.browsingContext?.embedderElement;
            const host = browser?.ownerGlobal?.gZenEaselHost;
            const config = host?.liveConfigFor(browser);
            if (config) this.sendAsyncMessage("ZenEaselLive:Configure", config);
        } catch (e) {
            console.error("[zen-easel] could not configure a live tile:", e);
        }
    }

    // A tile's <browser> lives in the *browser window*, not in the easel page — the page is
    // a system-principal document and cannot host one. So the embedder leads to the chrome
    // window, and the easel page has to be found from there by walking its tabs. Same
    // process throughout, so these stay direct calls rather than IPC.
    #easelPage() {
        const chrome = this.browsingContext?.embedderElement?.ownerGlobal ??
            this.browsingContext?.topChromeWindow;
        if (!chrome || !chrome.gBrowser) return null;
        for (const tab of chrome.gBrowser.tabs) {
            const page = tab.linkedBrowser?.contentWindow?.gZenEaselPage;
            if (page) return page;
        }
        return null;
    }

    #showEaselMenu({ screenX, screenY }) {
        try {
            this.#easelPage()?.showLiveContextMenu(screenX, screenY);
        } catch (e) {
            console.error("[zen-easel] could not show the card menu:", e);
        }
    }

    #openLink(data) {
        const url = safeExternalUrl(data?.url);
        if (!url) return;

        // The tile is embedded directly in the browser window's chrome document, so its
        // embedder's global is that window. topChromeWindow is kept as the fallback.
        const chrome = this.browsingContext?.embedderElement?.ownerGlobal ??
            this.browsingContext?.topChromeWindow;
        if (!chrome || !chrome.gBrowser) return;

        // Where the click was, for the overlay to grow out of. Content-supplied and used
        // for nothing but an animation; the host is what decides whether it is usable.
        const origin = { screenX: data?.screenX, screenY: data?.screenY };

        // Same door as the card's "Open source page" button: Glance when it is
        // available, a tab when it is not. The host owns that choice.
        try {
            if (chrome.gZenEaselHost?.openUrl) {
                chrome.gZenEaselHost.openUrl(url, origin);
                return;
            }
            chrome.gBrowser.selectedTab = chrome.gBrowser.addTab(url, {
                triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
                inBackground: false
            });
        } catch (e) {
            console.error("[zen-easel] could not open a link from a live card:", e);
        }
    }
}
