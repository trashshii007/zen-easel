// Zen Easel — parent side of the screenshot-bar button.
//
// One message, in one direction: the child says which region was selected and where its
// button is on screen, and this hands both to the browser window's screenshot hook. The
// priming message travels the other way, but it is sent by the hook through getActor()
// rather than from here, so there is nothing to receive for it.
//
// Nothing the child sends is trusted as a capability. The region is a set of numbers used
// only as snapshot coordinates against the very browsing context that reported them, and
// the anchor is only ever fed to a popup's screen position — so the worst a compromised
// content process can do with this actor is photograph itself and open a menu.

export class ZenEaselScreenshotParent extends JSWindowActorParent {
    receiveMessage(message) {
        if (message.name !== "ZenEaselScreenshot:Pick") return null;

        try {
            // The overlay always runs in the top-level document, so the embedder of the top
            // browsing context is the <browser> the screenshot belongs to, and its global is
            // the browser window. topChromeWindow is kept as the fallback for the same
            // reason ZenEaselLiveParent keeps it: a browser that has already been swapped
            // out has no embedder to ask.
            const browser = this.browsingContext?.top?.embedderElement;
            const chrome = browser?.ownerGlobal ?? this.browsingContext?.topChromeWindow;
            const hook = chrome?.gZenEaselHost?.screenshotHook;

            if (!browser || !hook) {
                console.warn("[zen-easel] a screenshot was sent to an easel, but the window " +
                    "that owns it is no longer there to receive it");
                return null;
            }

            // Deliberately not awaited. The hook opens a menu, captures, and opens a tab;
            // reporting a rejection is its job, and holding the IPC reply open for all of
            // that would keep the content process waiting on a menu the user has not opened
            // yet.
            hook.onRegionPick(browser, message.data);
        } catch (e) {
            console.error("[zen-easel] could not hand a screenshot to an easel:", e);
        }

        return null;
    }
}
