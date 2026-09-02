// Zen Easel — process-global registration.
//
// This is the only file in the mod that registers anything process-wide, and that is
// deliberate. The component registrar and ChromeUtils.registerWindowActor are both
// per-process, but every other script in this mod runs once per browser window — so
// registering from one of those would succeed in the first window and throw
// NS_ERROR_FACTORY_EXISTS in every window after it, and unregistering on window close
// would tear the feature out from under every window still open.
//
// Sine imports .sys.mjs entries in a mod's theme.json exactly once per process and
// dedupes them by chrome path (JS/core/manager.sys.mjs:137-152), so putting
// registration here means the double-registration case cannot be expressed rather than
// having to be guarded against.
//
// Note on unloading: Sine has no unload hook for background modules yet (its own TODO
// at manager.sys.mjs:141). Disabling this mod therefore leaves about:easel registered
// until the next restart — which Sine already requires, because the mod declares
// supportsUnload: false. unregister() is exported for manual use from the console.

const PAGE_URL = "chrome://sine/content/zen-easel/page/easel.xhtml";

const CLASS_ID = Components.ID("{3c8514d3-91cf-45ef-bb44-034a23909907}");
const CLASS_DESCRIPTION = "about:easel";
const CONTRACT_ID = "@mozilla.org/network/protocol/about;1?what=easel";

/**
 * Maps about:easel onto the mod's page, following the shape of Firefox's own
 * AboutDevtoolsToolbox (browser/omni.ja modules/AboutDevToolsToolboxRegistration.sys.mjs)
 * — a chrome document served in the parent process with a system principal.
 */
class AboutEasel {
    uri = Services.io.newURI(PAGE_URL);

    QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

    newChannel(uri, loadInfo) {
        const channel = Services.io.newChannelFromURIWithLoadInfo(this.uri, loadInfo);
        // nsAboutProtocolHandler sets originalURI to the about: URI after we return,
        // which is what makes location.href inside the page read "about:easel" and
        // preserves any ?easel=<id> the tab was opened with. Setting it here as well is
        // what AboutCompat does; it is harmless and makes the intent explicit.
        channel.originalURI = uri;
        // The system principal is the point of the exercise: the page needs IOUtils to
        // read and write easels, and needs to create the chrome-privileged <browser>
        // elements that live web cards are built from.
        channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
        return channel;
    }

    getURIFlags() {
        // What is absent matters more than what is present. Without
        // URI_MUST_LOAD_IN_CHILD / URI_CAN_LOAD_IN_CHILD /
        // URI_CAN_LOAD_IN_PRIVILEGEDABOUT_PROCESS, ChromeUtils.predictRemoteTypeForURI
        // returns NOT_REMOTE and the page is pinned to the parent process, which is
        // where it has to be. And without URI_SAFE_FOR_UNTRUSTED_CONTENT, an ordinary
        // web page cannot navigate anything to about:easel.
        return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
    }

    getChromeURI() {
        // Part of nsIAboutModule in Firefox 153; omitting it throws on some of the
        // process-selection paths rather than failing gracefully.
        return this.uri;
    }
}

const factory = {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    // Single-argument createInstance; the outer/aggregation parameter was removed from
    // nsIFactory some releases ago.
    createInstance(iid) {
        return new AboutEasel().QueryInterface(iid);
    }
};

function registrar() {
    return Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
}

export function register() {
    const reg = registrar();
    // Sine can call rebuildMods() again within a process while developing. The ESM
    // cache means this module body will not re-run, but re-registering over a stale
    // factory is cheap insurance and keeps a half-applied state from persisting.
    if (reg.isContractIDRegistered(CONTRACT_ID)) {
        try {
            reg.unregisterFactory(reg.contractIDToCID(CONTRACT_ID), factory);
        } catch (e) {
            // Registered by a previous copy of this module whose factory object we no
            // longer hold. Nothing further we can do, and it still resolves.
            return;
        }
    }
    reg.registerFactory(CLASS_ID, CLASS_DESCRIPTION, CONTRACT_ID, factory);
}

export function unregister() {
    const reg = registrar();
    if (!reg.isContractIDRegistered(CONTRACT_ID)) return;
    try {
        reg.unregisterFactory(CLASS_ID, factory);
    } catch (e) {
        console.error("[zen-easel] could not unregister about:easel:", e);
    }
}

/* ---------------------------------------------------------------- actors */

// The definitions moved to actors.sys.mjs, and the move is load-bearing: a window script
// has to be able to install them over a stale registration, and it cannot do that through
// this module, because this module is exactly the thing that goes stale. See the header
// there. Everything here is now a thin pass-through so there is still one place that
// registers actors at boot.
const { ensureActor, ensureActors, removeActors } =
    ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/actors.sys.mjs");

// `only` names a single actor; omitted, every one is installed.
export function registerActors(only = null) {
    if (only) ensureActor(only);
    else ensureActors();
}

export function unregisterActors() {
    removeActors();
}

/* ----------------------------------------------------------------- boot */

try {
    register();
} catch (e) {
    // A browser window coming up must not be derailed by this. The mod degrades to the
    // chrome:// URL fallback, which ZenEaselHost probes for.
    console.error("[zen-easel] about:easel registration failed:", e);
}

try {
    registerActors();
} catch (e) {
    // Already registered by a previous copy of this module in the same process, or a
    // Zen update changed the actor API. Live cards degrade to screenshots; nothing else
    // in the mod depends on these.
    console.error("[zen-easel] actor registration failed:", e);
}

try {
    const { installUrlbarProvider } = ChromeUtils.importESModule(
        "chrome://sine/content/zen-easel/background/urlbar.sys.mjs"
    );
    installUrlbarProvider();
} catch (e) {
    // Must not live at module top-level: a failed import would also skip about:easel.
    // UrlbarProvidersManager is not ready on a cold start until delayed-startup;
    // installUrlbarProvider waits for that itself. A throw here is a real API change.
    console.error("[zen-easel] urlbar provider registration failed:", e);
}
