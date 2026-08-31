// Zen Easel — giving a live tile an extension identity.
//
// A tile's <browser> is created with document.createXULElement and never registered with
// gBrowser, so gBrowser.getTabForBrowser misses it — the map it reads is a #private
// WeakMap written only from inside tabbrowser. Everything downstream follows from that:
//
//   tabTracker.getBrowserData(browser)            -> { tabId: -1 }
//   ExtensionParent.getSender: if (data?.tabId > 0)  -> no sender.tab, no sender.frameId
//   uBO onPortConnect: if (tab) { ... }              -> portDetails.tabId stays undefined
//   uBO retrieveContentScriptParameters              -> returns early, delivers nothing
//
// The visible result is that network blocking still works in a tile — it runs in the
// behind-the-scenes scope off details.documentUrl — while cosmetic filters and scriptlets
// do not. Ad slots a ## rule normally hides are simply there. Dark Reader is off for the
// same reason: it is the same content-script parameter handshake.
//
// The obvious repair is to shadow gBrowser.getTabForBrowser, and it is a trap. That method
// has nineteen callers inside tabbrowser and several act destructively on whatever it
// returns: DOMWindowClose calls removeTab, updateBrowserRemoteness calls _insertBrowser on
// ordinary cross-origin navigation, framefocusrequested reaches gZenWorkspaces to switch
// workspace, and the title-update path has no null guard at all. Every one of them goes
// through the same gBrowser object, so there is no way to shadow it for extensions only.
//
// So the patch goes one level up instead, at tabTracker.getBrowserData. Only extension code
// reads that, which puts all nineteen out of scope — and it happens to sit upstream of both
// consumers that matter: the port sender above, and WebRequest's tab attribution, which is
// what lets uBO build a page store carrying the tile's real URL.
//
// Off by default. See zen.easel.live.extension-identity.

(() => {
    if (window.ZenEaselLiveTabIdentity) return;

    const MARKER = "zen-easel-decoy-tab";

    // Stamped onto the wrapper so a second browser window finds the patch already installed
    // instead of wrapping the wrapper.
    //
    // getBrowserData is one function on one process-global tabTracker, while this class is
    // instantiated per window. Wrapping it per instance nested the wrappers: lookups still
    // worked, because each falls through to the one beneath it, but every window captured a
    // different "original", so closing two windows out of order either left a stale wrapper
    // installed forever or restored one over a live one. The registry and the owner count
    // therefore live on the patch, not on the instance.
    const PATCH = "_zenEaselTabIdentity";

    class ZenEaselLiveTabIdentity {
        constructor() {
            this.log = window.ZenEaselUtil.log;
            // Kept strongly, so teardown can reach every decoy this window minted.
            this._tabs = new Set();
            // The process-wide patch record, once this window has claimed a share of it.
            this._patch = null;
        }

        get enabled() {
            return window.ZenEaselUtil.prefBool("zen.easel.live.extension-identity", false);
        }

        // Adopts a tile's browser, minting the decoy that will answer for it. Returns false
        // for every reason not to — the pref being off, the trackers being unreachable, or
        // the tab refusing to be created — and a false here costs cosmetic filtering in that
        // tile and nothing else.
        adopt(browser) {
            if (!browser || !this.enabled) return false;
            if (!this._install()) return false;
            if (this._patch.decoys.has(browser)) return true;

            const tab = this._mintDecoy();
            if (!tab) return false;

            // The window is recorded alongside the tab because windowTracker.getId needs it
            // and the wrapper is shared: it cannot close over "the window that installed it".
            this._patch.decoys.set(browser, { tab, window });
            this._tabs.add(tab);
            return true;
        }

        release(browser) {
            const entry = browser && this._patch && this._patch.decoys.get(browser);
            if (!entry) return;
            this._patch.decoys.delete(browser);
            this._tabs.delete(entry.tab);
            this._removeTab(entry.tab);
        }

        // A hidden, lazy, session-store-exempt tab whose only job is to own an id.
        //
        // Lazy matters: what we want from this tab is its extension id, and that id is
        // minted by tabTracker.getId from a WeakMap keyed on the *tab*. It does not involve
        // a browser at all, which is exactly why the decoy can stay lazy — and why nothing
        // here may touch tab.linkedBrowser, whose getter would materialise the browser and
        // run _insertBrowser, defeating the laziness on every single tile.
        _mintDecoy() {
            try {
                const tab = window.gBrowser.addTab("about:blank", {
                    createLazyBrowser: true,
                    skipAnimation: true,
                    skipSessionStore: true,
                    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
                });
                if (!tab) return null;

                // Deliberately not "zen-empty-tab". Zen patches ext-browser's getId to
                // return -1 for a tab carrying that attribute, so reusing the name would
                // make every decoy resolve to the very tabId this module exists to avoid,
                // and the failure would look like the patch point not working.
                tab.setAttribute(MARKER, "true");
                window.gBrowser.hideTab(tab);
                return tab;
            } catch (e) {
                this.log("could not mint a decoy tab:", e.message);
                return null;
            }
        }

        _removeTab(tab) {
            try {
                window.gBrowser.removeTab(tab, { skipPermitUnload: true, animate: false });
            } catch (e) {
                this.log("could not remove a decoy tab:", e.message);
            }
        }

        // Wraps getBrowserData once per *process*, and takes a share of it for this window.
        // Everything that is not one of our tiles is handed straight to the original through
        // Reflect.apply, so this is invisible to every other extension surface in the
        // browser.
        _install() {
            if (this._patch) return true;
            try {
                const { ExtensionParent } = ChromeUtils.importESModule(
                    "resource://gre/modules/ExtensionParent.sys.mjs");
                const global = ExtensionParent.apiManager.global;
                const tracker = global && global.tabTracker;
                const windowTracker = global && global.windowTracker;
                if (!tracker || !windowTracker ||
                    typeof tracker.getBrowserData !== "function") {
                    return false;
                }

                let patch = tracker.getBrowserData[PATCH];
                if (!patch) {
                    const original = tracker.getBrowserData;
                    // Tile <browser> -> { tab, window }. One map for the process, so any
                    // window's tile resolves through the single wrapper below.
                    const decoys = new WeakMap();

                    const wrapper = function (browser) {
                        const entry = browser && decoys.get(browser);
                        if (entry) {
                            // Built from the ids directly. Anything that reached for
                            // tab.linkedBrowser here would materialise the lazy browser.
                            return {
                                tabId: tracker.getId(entry.tab),
                                windowId: windowTracker.getId(entry.window)
                            };
                        }
                        return Reflect.apply(original, this, arguments);
                    };

                    patch = { original, wrapper, decoys, tracker, owners: 0 };
                    wrapper[PATCH] = patch;
                    tracker.getBrowserData = wrapper;
                    this.log("live tiles now carry an extension tab identity");
                }

                patch.owners++;
                this._patch = patch;
                return true;
            } catch (e) {
                this.log("could not install the tab identity patch:", e.message);
                return false;
            }
        }

        destroy() {
            for (const tab of this._tabs) this._removeTab(tab);
            this._tabs.clear();

            const patch = this._patch;
            this._patch = null;
            if (!patch) return;

            // The last window out puts getBrowserData back — and only if it is still ours.
            // Something that wrapped it after us owns the chain from there, and restoring
            // over that would drop its patch on the floor.
            if (--patch.owners > 0) return;
            try {
                if (patch.tracker.getBrowserData === patch.wrapper) {
                    patch.tracker.getBrowserData = patch.original;
                }
            } catch (e) {
                this.log("could not restore getBrowserData:", e.message);
            }
        }
    }

    window.ZenEaselLiveTabIdentity = ZenEaselLiveTabIdentity;
})();
