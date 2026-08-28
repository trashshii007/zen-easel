// Zen Easel — measuring a page at capture time.
//
// Runs inside the page being captured, in its own content process. Its whole job is to
// report geometry: the viewport size and scroll offset when the shot was taken.
//
// It used to also score the element under the pointer, for the picker's click-to-capture
// mode. That went with the picker — Zen's screenshot overlay highlights elements itself.
//
// This actor is registered against messageManagerGroups ["browsers"], so it is eligible
// for every ordinary tab. That is safe because it declares no events and no observers:
// a child actor with neither is never instantiated until the parent explicitly calls
// getActor(), which happens once per capture. At rest it costs nothing and sees nothing.
//
// Nothing here reaches back into chrome, and nothing but plain numbers is ever returned.

export class ZenEaselCaptureChild extends JSWindowActorChild {
    receiveMessage(message) {
        switch (message.name) {
            case "ZenEaselCapture:Measure":
                return this.#measure();
        }
        return null;
    }

    // The layout box the page was laid out in, and where it was scrolled to.
    //
    // documentElement.clientWidth/Height, deliberately not innerWidth/innerHeight. The
    // two differ by the classic scrollbar gutter, and the live tile hides scrollbars
    // (see ZenEaselLiveChild.#hideScrollbars) so that its own edge is not an invitation
    // to scroll a pinned card. That makes the tile's layout box the scrollbar-free one,
    // so measuring the scrollbar-inclusive one here laid the live page out ~15px wider
    // than it had been at capture. Every responsive site then reflowed, and the stored
    // crop pointed at whatever had moved into its place.
    #measure() {
        const win = this.contentWindow;
        const doc = this.document;
        if (!win) return null;

        const root = doc && doc.documentElement;
        const w = (root && root.clientWidth) || win.innerWidth;
        const h = (root && root.clientHeight) || win.innerHeight;
        if (!(w > 0) || !(h > 0)) return null;

        return {
            webContentSize: { w, h },
            webContentOffset: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
            // Whether the document itself is what scrolls. A site that scrolls an inner
            // container instead reports scrollX/Y of 0 no matter how far down the page
            // you are, and the tile's win.scrollTo has nothing to act on — so the crop
            // would silently be "the top of the site". Reported rather than guessed at,
            // and the parent declines to record a capture when it is false.
            documentScrolls: this.#documentScrolls(win, root)
        };
    }

    // True when the document is the scrolling element, or when nothing has been
    // scrolled at all — in which case there is no offset to fail to reproduce and the
    // capture is honest whether or not an inner scroller exists.
    #documentScrolls(win, root) {
        if (win.scrollY > 0 || win.scrollX > 0) return true;
        const scroller = this.document && this.document.scrollingElement;
        if (!scroller || !root) return true;
        // Nothing is scrolled anywhere: a crop taken here needs no offset restored.
        return !(scroller.scrollTop > 0 || scroller.scrollLeft > 0);
    }
}
