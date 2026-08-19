// Zen Easel — the browser-window half of live web cards.
//
// Live tiles are <browser> elements, and they have to live here rather than in the easel
// page. That is not a preference, it is the only thing that works: about:easel is a
// system-principal chrome document, and Gecko refuses to load web content inside one. Every
// variant was tried against this Zen build and every one failed —
//
//   <iframe>                              stays on about:blank, no CSP violation reported
//   <iframe type="content"> (XUL)         stays on about:blank
//   <browser type="content">              NS_ERROR_CONTENT_BLOCKED from the docshell
//   <browser type="content" remote>       frameLoader.remoteTab null, fires oop-browser-crashed
//
// The last one is the instructive failure. `remote="true"` on a XUL browser asks Gecko for a
// *top-level* remote frame — a BrowserParent — which is only granted when the embedder is a
// chrome document. Firefox's own machinery assumes it too: RemoteWebNavigation dereferences
// frameLoader.remoteTab with no null check. A content-document embedder never gets one, and
// the resulting crash event is then handled by code that expects a gBrowser to exist.
//
// In this window all of that is simply true, because every tab is exactly this element.
//
// The division of labour: the page owns the model — which cards are live, the LRU, which one
// has the pointer — and sends geometry. This owns the elements. Everything that crosses is a
// plain number or string, and the host holds no reference to the page.

"use strict";

(function () {
    if (window.ZenEaselLiveHost) return;

    const { E10SUtils } = ChromeUtils.importESModule("resource://gre/modules/E10SUtils.sys.mjs");
    const { safeExternalUrl } =
        ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/validate.sys.mjs");

    // Waiting for the content process to be handed over. Firefox's own nested browser
    // (inline-options-browser.mjs) waits on this event rather than assuming clientTop is
    // enough, and it is right to: forcing the binding to apply is not the same as a process
    // existing.
    const FRAME_LOADER_TIMEOUT_MS = 4000;

    // The two addresses the easel page can be at — about:easel when the about module
    // registered, and the chrome URL when it did not. Matched by prefix rather than by
    // regex so the anchoring cannot be got wrong; see _easelBrowserFor.
    const ABOUT_URL = "about:easel";
    const CHROME_PAGE_URL = "chrome://sine/content/zen-easel/page/easel.xhtml";

    // A bare startsWith is one character short of correct: it also matches about:easelfoo,
    // which is a different page entirely. Only registered about: modules resolve, so no
    // such address can be navigated to today — but this decides which tab's <browser> a
    // board's websites are drawn over, and "no attacker can reach it" is a worse reason to
    // be right than "the test says what it means". The address either ends there or
    // continues with a separator.
    function isEaselSpec(spec) {
        for (const base of [ABOUT_URL, CHROME_PAGE_URL]) {
            if (!spec.startsWith(base)) continue;
            const next = spec.charAt(base.length);
            if (next === "" || next === "?" || next === "#") return true;
        }
        return false;
    }

    // How long a tile may sit blank before it gives up and the screenshot comes back.
    const LOAD_TIMEOUT_MS = 12000;

    // How long to allow before deciding a navigation never started at all.
    const NAVIGATION_CHECK_MS = 5000;

    // How long to wait after a tab closes before deciding the easel really is gone rather
    // than mid-reload or mid-session-restore. Long enough to outlast a swap, short enough
    // that a genuinely closed board is not left running for noticeably long.
    const ORPHAN_CHECK_MS = 1500;

    // How often the idle sweep runs. Deliberately coarse: the thing it is looking for is
    // measured in tens of minutes, so a minute's resolution is already far finer than the
    // decision needs, and the sweep is a walk over a handful of tiles.
    const IDLE_CHECK_MS = 60000;

    // How long the tiles stay down after a splitter drag ends if the page never sends a
    // layout. The reveal is normally driven by that layout arriving — this only covers the
    // board that was not repainting at all, where waiting for one would mean waiting for
    // ever. Short enough to read as part of letting go of the divider.
    const SPLIT_SETTLE_MS = 300;

    // How long a board's layer may stay wider or taller than the tab it is clipped to
    // before it shrinks on its own. The clip only ever grows while anything might still be
    // moving — see _positionLayer — and this is the floor under that rule, for the board
    // that is on screen but not repainting and so would never release it.
    const LAYER_SHRINK_SETTLE_MS = 400;

    // Sites whose sticky headers land in the middle of a crop taken further down the page.
    // Arc ships a list like this; these are applied as agent sheets, which outrank page CSS
    // without an !important arms race.
    const CSS_PATCHES = [
        ".header__shrink-beyond-min-size{min-height:0px;padding-top:0px}",
        "div[class^=mobile-navbar-index__mobileNavbarWrapper]{padding-top:0px}",
        "div[class^=app-layout__header]{padding-top:0px}"
    ];

    class ZenEaselLiveHost {
        constructor() {
            this.log = window.ZenEaselUtil.log;

            // objectId -> { easelId, wrapper, clip, browser, ... }
            //
            // The logical key is the pair (easelId, objectId). The Map is keyed by objectId
            // alone because object ids are uuids — a paste or a duplicate mints a new one,
            // so they do not collide across boards — but every entry carries its easelId and
            // every call that names a tile must also name its board. That assertion is what
            // makes "a page showing board A can never reach into board B's tiles" a
            // structural property rather than a promise that A's bookkeeping is correct.
            this._tiles = new Map();
            // easelId -> { easelId, layer, owner, resizeObserver, visible, tabShowing }
            //
            // One entry per board that has a page attached or tiles running, because each
            // board now lives in its own tab and two of them can be on screen at once in a
            // split view. Each carries its own layer, positioned over its own tab's
            // <browser> — a layer cannot be shared, since it is placed by absolute
            // coordinates over one element, and a <browser> cannot be moved between layers
            // without losing its frame loader and reloading the site.
            //
            // Held here rather than on the page because they outlive any one page load,
            // which is the whole point.
            this._boards = new Map();
            // browser -> tile, for the one lookup that arrives keyed by element rather than
            // by id. Weak so an entry can never be what keeps a torn-down <browser> alive;
            // nothing has to remember to delete from it.
            this._byBrowser = new WeakMap();
            // Tiles whose transform moved since the last widget flush. See
            // _scheduleWidgetUpdate for why this is a set rather than "all of them".
            this._widgetDirty = new Set();
            this._activeId = null;
            // Mounts that have passed the cap check but have not yet reached _tiles, so the
            // ceiling holds across _createBrowser's await. See mount().
            this._pending = 0;

            // Bumped by anything that invalidates every tile — unmountAll(), destroy().
            // mount() samples it before it awaits and re-checks after; see the note there.
            this._generation = 0;
            this._destroyed = false;

            this._orphanTimer = null;
            this._idleTimer = null;
            this._positionRaf = null;

            // A Zen split divider is being dragged right now. See _watchSplitResize.
            this._splitResizing = false;
            this._splitObserver = null;
            this._splitSettleTimer = null;

            this._onTabSelect = this._onTabSelect.bind(this);
            this._onTabClose = this._onTabClose.bind(this);
            gBrowser.tabContainer.addEventListener("TabSelect", this._onTabSelect);
            gBrowser.tabContainer.addEventListener("TabClose", this._onTabClose);
            this._watchSplitResize();
        }

        /* --------------------------------------------------------------- boards */

        // Each board gets its own layer, placed exactly over its own tab's <browser>, so the
        // coordinates its page sends — relative to that page's viewport — can be used
        // unchanged, and anything panned past the edge of the board is clipped by the layer
        // rather than drawn over Zen's sidebar.
        //
        // Per board rather than one shared layer, because boards open in separate tabs now
        // and a split view can have two on screen at once. A layer is positioned by absolute
        // coordinates over one element, so it cannot serve two; and its tiles cannot be
        // moved to another layer, because reparenting a <browser> destroys its frame loader
        // and reloads the site inside it. So the mapping is fixed at mount and the board
        // owns the layer for as long as it has a tile in it.
        _ensureBoard(easelId) {
            let board = this._boards.get(easelId);
            if (board) return board;

            const layer = document.createXULElement("box");
            layer.id = `zen-easel-live-layer-${easelId}`;
            layer.className = "zen-easel-live-layer";
            layer.style.position = "fixed";
            layer.style.overflow = "hidden";
            // The canvas keeps ownership of the pointer; only an activated tile opts back in.
            layer.style.pointerEvents = "none";
            // Above the content area, below Zen's own panels and menus. This is the value
            // the probe that proved the approach used.
            layer.style.zIndex = "9";
            layer.style.visibility = "hidden";

            (document.getElementById("browser") || document.documentElement).appendChild(layer);

            board = {
                easelId, layer, owner: null, resizeObserver: null,
                visible: false, tabShowing: false,
                // A splitter drag is in flight, so this board paints nothing; and, once it
                // ends, it goes on painting nothing until its page has placed the tiles for
                // the size the pane finished at. Both are reasons not to paint that have
                // nothing to do with whether the board is open or on screen, which is why
                // they are separate flags rather than folded into `visible`.
                resizing: this._splitResizing, awaitingLayout: false,
                // The last rect written, so an unchanged position costs a read and no style
                // writes — which is the usual case, since the loop that drives this runs
                // every frame and the content area moves on very few of them.
                lastRect: null,
                // What _notifyBoardPainting last told the page. Declared rather than left to
                // spring into existence on the first call, so that `undefined !== false`
                // does not make the first notification a real one for a board that has
                // never painted.
                notifiedPainting: null,
                // When the rect last changed size, for the shrink settle. See _positionLayer.
                shrinkAt: 0
            };
            this._boards.set(easelId, board);
            return board;
        }

        _boardFor(easelId) {
            return easelId ? this._boards.get(easelId) || null : null;
        }

        // Which tab's <browser> this board's layer is placed over. Separate from the layer's
        // own lifetime because the owner really can change — a remoteness flip, a session
        // restore, a tab detach — and the tiles must survive that even though the element
        // they are positioned against does not.
        _setOwner(board, ownerBrowser) {
            if (!board || board.owner === ownerBrowser) return;

            if (board.resizeObserver) {
                try { board.resizeObserver.disconnect(); } catch (e) { }
                board.resizeObserver = null;
            }
            board.owner = ownerBrowser;
            // The cached rect belongs to the element that just went away; keeping it would
            // let a coincidental match skip the reposition onto the new one.
            board.lastRect = null;
            if (!ownerBrowser) return;

            // A sidebar collapse or a window resize moves the content area without the page
            // repainting, so the layer cannot rely on the page's frame loop alone. This is
            // also what keeps the placement correct while the board's tab is in the
            // background, when that frame loop is not running at all.
            if (typeof ResizeObserver === "function") {
                board.resizeObserver = new ResizeObserver(() => {
                    // The one place this must not fire is the one where it fires hardest. A
                    // splitter drag resizes the owner on every frame, and the layer is down
                    // for the duration anyway — so all this would do is force a layout flush
                    // of the chrome document out of the middle of Zen's drag, once a frame
                    // per board, to move something nobody can see. The reveal repositions.
                    if (board.resizing) return;
                    this._positionLayer(board);
                });
                board.resizeObserver.observe(ownerBrowser);
            }
            this._positionLayer(board);
        }

        // Keeps every showing board's layer over its tab, for as long as any tile is up.
        //
        // The two event sources this used to rely on both have blind spots, and opening
        // Zen's library falls into both at once. A ResizeObserver watches *size*, not
        // position, so a panel that slides the content area sideways without changing the
        // browser's box notifies nothing — which is exactly why dragging the sidebar edge
        // worked and opening the library did not. And the per-frame reposition in layoutAll
        // only runs when the page paints; the page's own layout did not change either, so it
        // had no reason to. The layer kept the position it had before the panel opened and
        // every tile missed its card by the width of the panel.
        //
        // A rect read per showing board per frame is the honest cost of not having an event
        // for "this element moved". It is one element, the style writes are skipped unless
        // it actually moved, and the loop stops itself the moment nothing is live — so it
        // runs only while you are looking at a board that has something running on it.
        //
        // "Something running on it" is the operative half. The loop used to stop only when
        // the last tile went, which meant a window with a tile parked on a board in some
        // other tab kept a chrome-window rAF alive indefinitely to do nothing: every frame
        // it walked the boards, found none painting, and scheduled itself again. It now
        // stops when no board is painting and is restarted by the events that can make one
        // paint again — attach, setBoardPainting, TabSelect, the split reveal.
        _startPositionLoop() {
            if (this._positionRaf) return;
            const tick = () => {
                this._positionRaf = null;
                if (this._destroyed || !this._tiles.size) return;
                let painting = false;
                for (const board of this._boards.values()) {
                    if (!this._boardPainting(board)) continue;
                    painting = true;
                    this._positionLayer(board);
                }
                if (!painting) return;
                this._positionRaf = window.requestAnimationFrame(tick);
            };
            this._positionRaf = window.requestAnimationFrame(tick);
        }

        _stopPositionLoop() {
            if (!this._positionRaf) return;
            window.cancelAnimationFrame(this._positionRaf);
            this._positionRaf = null;
        }

        // Cheap enough to call on every layout batch, and that is exactly how it is called
        // — see layoutAll. It used to run only on a handful of events (attach, TabSelect, an
        // owner change, the ResizeObserver) and that turned out to be the wrong shape for
        // the problem: anything that moves the content area *without* resizing the owner
        // fires none of them, and the events that do fire can arrive before the new layout
        // has settled, so the rect read is already stale. Either way the layer keeps a
        // position that is no longer true and every tile in it sits uniformly off the cards
        // they belong to, with nothing scheduled that would ever correct it.
        //
        // Driving it from the frame loop instead makes the drift unrepresentable: the tiles
        // and the layer they live in are placed from the same paint.
        //
        // The four style writes are skipped when nothing moved, because that is the usual
        // case and a style write is a layout invalidation in the chrome document. The rect
        // read is not skippable and is the real cost — one element, once a frame.
        // `shrink` says the caller knows the tiles inside are about to be placed for this
        // size — which is only true of layoutAll, where the page's geometry is arriving on
        // the same frame.
        //
        // Everywhere else the layer may grow but not shrink, and that asymmetry is the fix
        // for tiles vanishing while a split view was dragged narrower. The layer clips its
        // contents — overflow:hidden, so a tile panned off the board does not paint over
        // Zen's sidebar — and it follows the <browser> within the frame the split bar moves,
        // because its ResizeObserver is on the browser itself. The tiles inside it do not:
        // the page has its own observer (canvas.uc.js) which reflows the board to the new
        // width, re-clamps the view and only then schedules a paint, so their coordinates
        // are at least a frame behind and further when that reflow is slow.
        //
        // Shrinking first therefore cuts tiles that are still where they were, and the whole
        // drag is spent with the clip ahead of its contents. Growing cannot cut anything,
        // which is exactly why dragging the split the other way looked fine.
        //
        // Holding the old size briefly means a tile can overhang the pane for a frame or
        // two, which is the lesser fault by some distance: it is transient, self-correcting,
        // and visible only at the very edge.
        //
        // "Transient" is the part that needs a floor, and did not have one. Only layoutAll
        // passed `shrink`, so the asymmetry was released by the page painting — and a board
        // that is showing but idle does not paint. Narrow the window with such a board open
        // and the oversized clip is not transient at all: it is held until something else
        // dirties the page, with the layer free to paint over Zen's sidebar the whole time.
        //
        // So an oversized clip is now given a deadline rather than a promise. Once the rect
        // has been smaller than what is written for LAYER_SHRINK_SETTLE_MS, and no drag or
        // pending reveal is the reason, it shrinks to fit on its own. That is long enough to
        // stay out of the way of every gesture the grow-only rule exists to protect — a
        // splitter drag holds `resizing`, and the frame after it holds `awaitingLayout` —
        // and short enough that nobody sees the overhang.
        _positionLayer(board, shrink = false) {
            if (!board || !board.layer || !board.owner) return;
            const rect = board.owner.getBoundingClientRect();
            const last = board.lastRect;

            if (!shrink && last && (rect.width < last.width || rect.height < last.height)) {
                const now = Date.now();
                if (!board.shrinkAt) board.shrinkAt = now;
                else if (now - board.shrinkAt > LAYER_SHRINK_SETTLE_MS &&
                    !board.resizing && !board.awaitingLayout) {
                    shrink = true;
                }
            } else {
                board.shrinkAt = 0;
            }
            if (shrink) board.shrinkAt = 0;

            const width = (shrink || !last) ? rect.width : Math.max(rect.width, last.width);
            const height = (shrink || !last) ? rect.height : Math.max(rect.height, last.height);

            if (last && last.left === rect.left && last.top === rect.top &&
                last.width === width && last.height === height) {
                return;
            }
            board.lastRect = { left: rect.left, top: rect.top, width, height };
            board.layer.style.left = `${rect.left}px`;
            board.layer.style.top = `${rect.top}px`;
            board.layer.style.width = `${width}px`;
            board.layer.style.height = `${height}px`;
        }

        // Every reason a board's layer might be down, in one place, because two callers
        // have to agree on the answer: the layer's own visibility and each tile's. They
        // disagreed while a splitter was being dragged, which is the sort of thing that
        // leaves a tile painting inside a layer that is supposed to be gone.
        _boardPainting(board) {
            return !!board && board.visible && board.tabShowing &&
                !board.resizing && !board.awaitingLayout;
        }

        // One style write that guarantees a board paints nothing even if a per-tile call is
        // missed. tabShowing rather than "is the selected tab", so a split view showing two
        // easels at once keeps both layers up.
        _applyLayerVisibility(board) {
            if (!board || !board.layer) return;
            const painting = this._boardPainting(board);
            board.layer.style.visibility = painting ? "" : "hidden";
            this._notifyBoardPainting(board, painting);
        }

        // Tells the page whether its tiles are on screen, so the canvas can put the
        // screenshots back in the gap.
        //
        // Without this the two sides disagree during exactly the moments that matter. The
        // canvas skips a live card's screenshot because it believes a <browser> is covering
        // it, so a layer hidden for a tab switch leaves a board full of holes — and on the
        // way back, holes again for the frames between the tab appearing and the tiles being
        // laid out. Hiding the tile and showing the picture is one action, and only the host
        // knows when it happens.
        _notifyBoardPainting(board, painting) {
            if (board.notifiedPainting === painting) return;
            board.notifiedPainting = painting;
            try {
                const browser = this._easelBrowserFor(board.easelId);
                const page = browser?.contentWindow?.gZenEaselPage;
                page?.onLiveBoardPainting(painting);
            } catch (e) {
                this.log("could not tell a board whether it is painting:", e.message);
            }
        }

        _teardownBoard(easelId) {
            const board = this._boards.get(easelId);
            if (!board) return;
            if (board.resizeObserver) {
                try { board.resizeObserver.disconnect(); } catch (e) { }
            }
            if (board.layer) board.layer.remove();
            this._boards.delete(easelId);
        }

        // The tab showing a *particular* board, which is the question every caller actually
        // has now that boards no longer share one.
        //
        // Matched on the ?easel= parameter first and the page object second, the same pair
        // ZenEaselHost._findEaselTab uses — the URL is authoritative once the page has
        // written it, and the page object covers the window between load and that write.
        // The URL prefix alone is not enough any more: it would match every easel tab, and
        // picking the first would put one board's websites over another board's tab.
        _easelBrowserFor(easelId) {
            if (!easelId) return null;
            try {
                for (const tab of gBrowser.tabs) {
                    const browser = tab.linkedBrowser;
                    const spec = browser && browser.currentURI ? browser.currentURI.spec : "";
                    if (!isEaselSpec(spec)) continue;
                    try {
                        if (new URL(spec).searchParams.get("easel") === easelId) return browser;
                    } catch (e) { }
                    try {
                        if (browser.contentWindow?.gZenEaselPage?.easelId === easelId) return browser;
                    } catch (e) { }
                }
            } catch (e) { }
            return null;
        }

        // Whether this board's tab is the one on screen *right now*.
        //
        // Deliberately not gBrowser.shouldActivateDocShell, which was the first thing tried
        // here and is the wrong question however well it reads. That predicate decides
        // whether a browser's content should be *rendered*, and it delegates mid-switch to
        // AsyncTabSwitcher — which keeps the outgoing tab active until the incoming one has
        // layers, precisely so the switch does not flash. Asked during a tab switch it
        // therefore answers "yes, still showing" for the tab being left, so the layer stayed
        // up and its tiles painted over whatever tab you had just moved to. The settle burst
        // then spent the next several frames keeping that layer accurately positioned over
        // the wrong page.
        //
        // selectedBrowser is the definitive answer and it is already correct by the time
        // TabSelect fires, so hiding happens on the same turn as the switch rather than
        // whenever the switcher gets around to conceding. splitViewBrowsers is consulted as
        // well because a split genuinely does show two tabs at once, and comparing against
        // the one selected browser would blank the other half.
        _isBoardTabShowing(easelId) {
            const owner = this._easelBrowserFor(easelId);
            if (!owner) return false;
            if (document.hidden) return false;
            if (gBrowser.selectedBrowser === owner) return true;
            try {
                const split = gBrowser.splitViewBrowsers;
                if (split && Array.prototype.includes.call(split, owner)) return true;
            } catch (e) { }
            return false;
        }

        /* -------------------------------------------------------- split resize */

        // Puts the tiles down for the length of a Zen split-divider drag, and the
        // screenshots back in their place.
        //
        // A tile cannot take part in a resize the way the rest of the board can. It is a
        // separate <browser> placed by script once a frame, so during the drag it chases a
        // grid that Zen relays out on every mousemove — and chases it out of the same frame
        // budget, since reading the owner's rect from the chrome document forces a layout
        // flush that Zen's next inset write immediately dirties again. With two easels in
        // the split there are two of everything, and the result is tiles that lag, tear and
        // fight the drag, and a divider that does not follow the pointer.
        //
        // Nothing here unloads anything: this is the same painting/running distinction as
        // the rest of the file, and the sites keep running throughout. The board resizes
        // smoothly with its screenshots and the websites come back once it has settled.
        //
        // Zen stamps zen-split-resizing on #tabbrowser-tabpanels for exactly the duration
        // of the drag — set in ZenViewSplitter's splitter mousedown, removed on mouseup —
        // so the signal is already there to be read and does not have to be inferred from
        // watching sizes change. An attribute-filtered MutationObserver costs nothing when
        // no one is dragging, which is almost always.
        _watchSplitResize() {
            if (typeof MutationObserver !== "function") return;
            const panel = gBrowser.tabpanels || document.getElementById("tabbrowser-tabpanels");
            if (!panel) return;

            this._splitObserver = new MutationObserver(() => {
                this._setSplitResizing(panel.hasAttribute("zen-split-resizing"));
            });
            this._splitObserver.observe(panel, {
                attributes: true, attributeFilter: ["zen-split-resizing"]
            });
        }

        // Both edges of the drag. Every board, not the one being dragged: the divider moves
        // the pane on each side of it, and a board in the half that grew is as badly placed
        // mid-drag as one in the half that shrank.
        _setSplitResizing(resizing) {
            if (this._splitResizing === resizing) return;
            this._splitResizing = resizing;

            if (this._splitSettleTimer) {
                window.clearTimeout(this._splitSettleTimer);
                this._splitSettleTimer = null;
            }

            for (const board of this._boards.values()) {
                board.resizing = resizing;
                // Coming out of the drag the tiles are still placed for the width the pane
                // had when it started, so putting the layer straight back up would show one
                // frame of every tile in the wrong place. It stays down until the page's
                // next layout arrives, which is the same "lay them out, then reveal" that
                // returning to a backgrounded tab uses — see attach()'s `reveal`.
                board.awaitingLayout = !resizing;
                this._applyLayerVisibility(board);
            }
            for (const tile of this._tiles.values()) this._applyTileState(tile);

            if (resizing) return;

            this._splitSettleTimer = window.setTimeout(() => {
                this._splitSettleTimer = null;
                if (this._destroyed) return;
                // Only reached when no layout ever came — a board whose page has nothing to
                // repaint for, so its paint loop is idle and the signal that would normally
                // reveal these tiles is never going to be sent. The layer is shrunk to the
                // settled pane on the way, because by now the tiles being a drag behind is
                // already true and a clip that matches the pane is the better of the two
                // wrongs: it cannot paint over Zen's sidebar.
                for (const board of this._boards.values()) {
                    if (!board.awaitingLayout) continue;
                    this._positionLayer(board, true);
                    this._revealAfterResize(board);
                }
            }, SPLIT_SETTLE_MS);
        }

        // The page has placed this board's tiles for the size the pane finished at, so the
        // layer can go back up.
        _revealAfterResize(board) {
            if (!board || !board.awaitingLayout) return;
            board.awaitingLayout = false;
            this._applyLayerVisibility(board);
            for (const tile of this._tilesOf(board.easelId)) this._applyTileState(tile);
            // This is one of the transitions that can make a board start painting, and the
            // position loop now stops itself whenever none is. Every such transition has to
            // restart it or the layer stops following its tab — which matters most on
            // exactly the board this reaches by the settle timer, whose page is not painting
            // and so has nothing else that would ever reposition it.
            this._startPositionLoop();
        }

        /* --------------------------------------------------------------- tiles */

        // geometry is plain data from the page, in its own viewport's CSS pixels:
        //   rect    {x, y, w, h}   where the tile sits
        //   content {w, h}         the size to lay the page out at, so it reflows as captured
        //   offset  {x, y}         how far to shift it so the captured region is at the origin
        //   scale                  what to multiply that by so the region fills the tile
        async mount(easelId, objectId, url, geometry, options = {}) {
            // Already mounted still answers true. The page treats false as "this card could
            // not be opened" and drops its model entry — which, for a tile this host is in
            // fact still showing, would strand a live website with nothing tracking it.
            if (this._tiles.has(objectId)) return true;
            if (this._destroyed || !easelId) return false;

            const spec = safeExternalUrl(url);
            if (!spec) return false;

            const owner = this._easelBrowserFor(easelId);
            if (!owner) return false;

            // A mount request is itself evidence that its board is open and being looked at
            // — a page nobody can see does not get a play button pressed on it. The cached
            // flags can be stale at exactly this moment, and when they are, _applyTileState
            // below hides the very tile the click asked for while the page goes on believing
            // it is painting: the canvas leaves its hole, nothing fills it, and you get a
            // blank card with a pause badge and no way back but pausing and playing again.
            //
            // The way in is the one-time consent prompt. confirmEx is modal, so the page
            // takes a visibilitychange and calls background() while it is up, and the mount
            // that follows the click lands with the board marked not visible. That is why it
            // only ever happened the first time — after that the prompt never shows.
            //
            // Trusted rather than repaired after the fact, because the page cannot see this
            // state to correct it.
            const board = this._ensureBoard(easelId);
            board.visible = true;
            board.tabShowing = this._isBoardTabShowing(easelId);

            // Before the element is created, so the cap is a real ceiling rather than a
            // target the count briefly exceeds.
            //
            // The reservation is what makes that true across the await below. _tiles is not
            // written until the browser exists, so the count this checks against does not
            // include mounts already in flight — and two clicks in the same few hundred
            // milliseconds, or a board restoring several tiles at once, both passed the
            // check on the same free slot and both took it. The seat is claimed here and
            // released either when the tile lands in _tiles or when the mount gives up.
            if (!this._evictFor(easelId)) {
                this.log("at the live-tile cap with nothing evictable; refusing", spec);
                return false;
            }
            this._pending++;

            // Sampled before the first await. _createBrowser waits on XULFrameLoaderCreated
            // and will sit there for up to FRAME_LOADER_TIMEOUT_MS, which is a wide window
            // for everything to be swept out from under this call. It used to be far wider:
            // the page tore every tile down on both visibilitychange and pagehide, so simply
            // switching tabs at the wrong moment did it, and the old code then registered
            // the tile and started the load regardless, into a wrapper that had already been
            // detached — a live site running in a content process with no element on screen,
            // unreachable by unmount() because it landed in _tiles *after* the sweep walked
            // it. Those two paths no longer tear anything down, but unmountAll() and
            // destroy() still do, and the window is the same shape.
            const generation = this._generation;
            const layer = board.layer;
            this._setOwner(board, owner);
            this._applyLayerVisibility(board);

            const wrapper = document.createXULElement("box");
            wrapper.className = "zen-easel-live-tile";
            wrapper.style.position = "absolute";
            wrapper.style.overflow = "hidden";
            wrapper.style.borderRadius = "10px";

            const clip = document.createXULElement("box");
            clip.style.position = "absolute";
            clip.style.transformOrigin = "0 0";

            wrapper.appendChild(clip);
            layer.appendChild(wrapper);

            // Caught rather than left to propagate, and only because of the reservation
            // above. A throw here used to be the page's problem — _mount catches it and
            // reports the card as unopenable, which is the right outcome and still is. What
            // is new is that this call now holds a seat against the cap, and an exception
            // taking the stack straight out of mount() would never give it back: the
            // ceiling would fall by one for the life of the window, every time.
            let browser = null;
            try {
                browser = await this._createBrowser(spec, clip, options);
            } catch (e) {
                this.log("a live tile could not be created:", e.message);
            }
            if (!browser) {
                this._pending--;
                wrapper.remove();
                return false;
            }

            // The re-check. Tearing the browser down explicitly rather than just dropping
            // the reference: a remote browser holding render layers keeps its content
            // process alive and can leave its last composited frame on screen, which is the
            // same reason unmount() below drops layers before removing the element.
            //
            // isConnected used to be here for a case that no longer exists — the layer being
            // torn down and rebuilt when the easel moved to a different <browser>. A board's
            // layer now lives as long as the board does, so this stays true across an owner
            // change, which is the correct new answer: a mid-await mount should not be
            // abandoned merely because the tab's browser was swapped underneath it. It is
            // kept as the backstop for the layer genuinely going away — the board's tab
            // being closed while this mount was waiting — which _generation does not
            // distinguish from an ordinary sweep.
            if (this._destroyed || generation !== this._generation || !wrapper.isConnected) {
                this._pending--;
                try { browser.renderLayers = false; } catch (e) { }
                try { browser.docShellIsActive = false; } catch (e) { }
                try { browser.remove(); } catch (e) { }
                wrapper.remove();
                this.log("a live tile was abandoned mid-mount:", spec);
                return false;
            }

            // painting starts true to match _markActive, which has already been applied by
            // _createBrowser — the flags are the host's record of a state the element is
            // already in, not an instruction still to be carried out.
            // url is kept so attach() can tell the page what it is adopting, and so the page
            // can decline a tile whose card has since been pointed somewhere else.
            const tile = {
                easelId, wrapper, clip, browser, objectId, url: spec,
                painting: true, offscreen: false, hidden: false,
                lastUsedAt: Date.now(), notPaintingSince: 0,
                // muted starts false to match the element, which has not been touched.
                audible: false, muted: false, userMuted: !!options.muted
            };
            this._watchAudio(tile);
            // Stored before the load starts, because the child's DOMContentLoaded — and
            // the Ready message it sends from there — can arrive before this call
            // returns. An answer of null would mean an unpinned tile with no locks.
            this._storeConfig(tile, options);
            this._tiles.set(objectId, tile);
            // Counted for real now, so the seat held across the await is given back.
            this._pending--;
            this._byBrowser.set(browser, tile);
            // The board this tile was mounted for may not be the attached one by the time the
            // frame loader came back, so the tier is derived rather than assumed.
            this._applyTileState(tile);
            this._startIdleSweep();
            this._startPositionLoop();
            // The layer is placed before the tile inside it, so the first painted frame is
            // already in the right place rather than jumping when the next sync arrives.
            // Allowed to shrink: the layout call on the next line is this tile's geometry.
            this._positionLayer(board, true);
            this.layout(easelId, objectId, geometry);
            this._watchLoad(tile, spec);

            try {
                browser.fixupAndLoadURIString(spec, {
                    // Deliberately not the system principal.
                    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({})
                });
            } catch (e) {
                this.log("a live tile refused to load:", e.message);
                this.unmount(objectId);
                return false;
            }

            return true;
        }

        // A tile whose load fails is worse than one that never mounted: the canvas stops
        // painting the screenshot underneath a live card, so a failure would leave a blank
        // hole with no way back. Every failure therefore ends with the tile going away.
        //
        // Two failures matter and they look nothing alike. A network error arrives as a
        // non-zero status on STATE_STOP. A site that refuses to be embedded —
        // X-Frame-Options, or a frame-ancestors CSP — is not an error at all: the channel
        // succeeds and the docshell quietly lands on about:neterror.
        _watchLoad(tile, url) {
            const browser = tile.browser;
            let settled = false;

            const finish = reason => {
                if (settled) return;
                settled = true;
                window.clearTimeout(tile.loadTimer);
                window.clearTimeout(tile.navCheckTimer);
                if (tile.detachListener) {
                    tile.detachListener();
                    tile.detachListener = null;
                }
                if (!reason || !this._tiles.has(tile.objectId)) return;

                this.log("live tile failed:", url, reason);
                const id = tile.objectId;
                this.unmount(id);
                this._notifyPage(tile.easelId, id, reason);
            };

            const listener = {
                QueryInterface: ChromeUtils.generateQI([
                    "nsIWebProgressListener", "nsISupportsWeakReference"
                ]),
                onStateChange: (progress, request, flags, status) => {
                    const done = Ci.nsIWebProgressListener.STATE_STOP;
                    const network = Ci.nsIWebProgressListener.STATE_IS_NETWORK;
                    if (!(flags & done) || !(flags & network)) return;

                    // NS_OK is 0, compared numerically so this does not depend on Cr being
                    // a global in whichever document the host was loaded into.
                    if (status !== 0) {
                        finish("That site could not be loaded in the easel");
                        return;
                    }
                    const landed = browser.documentURI ? browser.documentURI.spec : "";
                    if (/^about:(neterror|blocked|certerror)/.test(landed)) {
                        finish("That site refuses to be embedded, so the card stays a screenshot");
                        return;
                    }
                    // Re-asserted after the load: a process switch on navigation brings a
                    // new remote tab with it, and the flag does not travel. Neither does
                    // the mute state, for the same reason — so the element is put back into
                    // whatever the tile's record says it should be.
                    this._markActive(browser);
                    tile.muted = false;
                    this._applyAudio(tile);
                    finish(null);
                }
            };

            try {
                browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
                // Handed to the tile so unmount can detach it too. A tile torn down
                // before its load settles never reaches finish(), and the listener would
                // otherwise stay registered against a browser that is going away.
                tile.detachListener = () => {
                    try { browser.removeProgressListener(listener); } catch (e) { }
                };
            } catch (e) {
                this.log("could not watch the tile's load:", e.message);
                return;
            }
            // A refusal to be embedded does not arrive as an error and does not produce an
            // error page: the load is simply cancelled, and the tile sits on about:blank
            // forever. currentURI changes as soon as a navigation *starts*, so still being
            // about:blank a few seconds in means it never started.
            tile.navCheckTimer = window.setTimeout(() => {
                const at = browser.currentURI ? browser.currentURI.spec : "";
                if (at === "about:blank" || !at) {
                    finish("That site refuses to be embedded, so the card stays a screenshot");
                }
            }, NAVIGATION_CHECK_MS);

            tile.loadTimer = window.setTimeout(
                () => finish("That site took too long to load in the easel"), LOAD_TIMEOUT_MS
            );
        }

        // Where the scroll is pinned, which locks apply, and the per-site CSS repairs.
        //
        // Stored on the tile rather than pushed at it. The child asks for this by name
        // — ZenEaselLive:Ready, on every DOMContentLoaded and pageshow — and the parent
        // actor answers from here via liveConfigFor(). That inversion is the fix for two
        // things at once: the retry loop that used to poll for the actor's existence on
        // a 100ms timer forty times per tile is gone, and a navigation that switches
        // content process now reconfigures itself, where before it produced a fresh
        // actor holding no configuration at all and nothing noticed.
        _storeConfig(tile, options) {
            const pinned = !!options.pinned;
            tile.config = {
                offset: options.scrollOffset || null,
                lockScroll: pinned,
                lockSelection: pinned,
                // A sticky header is a feature in a web tile and a defect in a crop
                // taken further down the page, so the repairs are a crop concern.
                cssPatches: pinned ? CSS_PATCHES : []
            };
        }

        // Answered for the parent actor, which has a <browser> and needs the config that
        // belongs to it.
        //
        // A WeakMap rather than the scan this used to be. The child asks by name on every
        // DOMContentLoaded and pageshow — which an SPA doing soft navigations fires
        // repeatedly, per tile — so the cost was O(tiles) per navigation at exactly the
        // moment the tile count stopped being three.
        configFor(browser) {
            return this._byBrowser.get(browser)?.config ?? null;
        }

        // The page owns the model, so a tile the host gives up on has to be reported back
        // rather than silently dropped — otherwise the page still believes it is live and
        // the canvas keeps leaving a hole for it.
        //
        // Addressed by board. Each easel has its own tab and its own page, and a page holds
        // model entries only for its own board — so the message has to go to the page
        // showing *this* tile's easel, not to whichever easel tab turns up first.
        _notifyPage(easelId, objectId, reason) {
            if (!easelId) return;
            try {
                const browser = this._easelBrowserFor(easelId);
                const page = browser?.contentWindow?.gZenEaselPage;
                page?.onLiveTileLost(objectId, reason);
            } catch (e) {
                this.log("could not tell the page a tile was lost:", e.message);
            }
        }

        // Mirrors Firefox's own nested remote browser. The ordering is load-bearing:
        // everything deciding where content runs is set before insertion, and nothing is
        // loaded until the frame loader has actually been created.
        async _createBrowser(url, parent, options) {
            let remoteType;
            try {
                remoteType = ChromeUtils.predictRemoteTypeForURI(url, {
                    window,
                    userContextId: options.userContextId || 0
                });
            } catch (e) {
                this.log("could not predict a remote type:", e.message);
                return null;
            }
            if (remoteType === E10SUtils.NOT_REMOTE || !E10SUtils.isWebRemoteType(remoteType)) {
                return null;
            }

            const browser = document.createXULElement("browser");
            browser.setAttribute("type", "content");
            browser.setAttribute("messagemanagergroup", "zen-easel-live");
            browser.setAttribute("forcemessagemanager", "true");
            // disableglobalhistory keeps the tile out of your browsing history, which is the
            // one that matters for privacy.
            //
            // `disablehistory` is deliberately NOT set, though it looks like the obvious
            // companion. It stops the frame loader creating session history on the docShell
            // at all, and a single-page app leans on history.pushState during hydration and
            // routing — with nowhere to push, those calls throw and the app never finishes
            // rendering. The symptom is a site frozen on its loading skeleton while a
            // server-rendered page beside it looks perfect.
            browser.setAttribute("disableglobalhistory", "true");
            browser.setAttribute("disablefullscreen", "true");
            browser.setAttribute("autoscroll", "false");
            browser.setAttribute("transparent", "true");
            if (options.userContextId) {
                browser.setAttribute("usercontextid", String(options.userContextId));
            }
            browser.setAttribute("remote", "true");
            browser.setAttribute("remoteType", remoteType);
            browser.setAttribute("maychangeremoteness", "true");
            browser.style.width = "100%";
            browser.style.height = "100%";
            browser.style.border = "0";

            const ready = new Promise(resolve => {
                browser.addEventListener("XULFrameLoaderCreated", resolve, { once: true });
                window.setTimeout(resolve, FRAME_LOADER_TIMEOUT_MS);
            });

            parent.appendChild(browser);
            void browser.clientTop;
            await ready;

            if (!browser.isRemoteBrowser) {
                browser.remove();
                return null;
            }

            if (options.private) {
                try { browser.browsingContext.usePrivateBrowsing = true; } catch (e) { }
            }

            this._markActive(browser);
            return browser;
        }

        // A tab's activity is managed by tabbrowser; a tile's is managed by nobody, so it
        // starts *inactive* — which throttles rAF and timers and stops its layers being
        // rendered at all. A largely static page still paints and looks fine. An SPA never
        // gets past its loading skeleton, which is exactly what a heavy site looked like
        // here: the logo, and nothing else, forever.
        //
        // docShellIsActive sets browsingContext.isActive and the remote tab's renderLayers
        // together, which is the pair that matters.
        _markActive(browser) {
            try {
                browser.docShellIsActive = true;
                browser.renderLayers = true;
            } catch (e) {
                this.log("could not mark a tile active:", e.message);
            }
        }

        layout(easelId, objectId, geometry) {
            const tile = this._tileFor(easelId, objectId);
            if (!tile || !geometry) return;

            const { rect, content, offset, scale, rotation, pivot } = geometry;

            // Everything else crossing this seam is a plain number or string, and is treated
            // as untrusted on arrival. Geometry is the one structured value, and it was
            // being destructured straight into property writes — so a malformed entry threw
            // from inside the page's paint loop, taking that frame's whole layout pass with
            // it. Numbers are checked rather than coerced: a NaN here is a bug upstream, and
            // silently painting a tile at 0,0 would hide it.
            const finite = v => typeof v === "number" && Number.isFinite(v);
            if (!rect || !content || !offset || !finite(scale)) return;
            if (!finite(rect.x) || !finite(rect.y) || !finite(rect.w) || !finite(rect.h)) return;
            if (!finite(content.w) || !finite(content.h)) return;
            if (!finite(offset.x) || !finite(offset.y)) return;

            tile.wrapper.style.left = `${rect.x}px`;
            tile.wrapper.style.top = `${rect.y}px`;
            tile.wrapper.style.width = `${Math.max(0, rect.w)}px`;
            tile.wrapper.style.height = `${Math.max(0, rect.h)}px`;

            // The card is rotated on the board, so its tile turns with it — about the
            // *object's* centre, which the page sends as a pivot because the tile covers
            // only the card's art and not its title strip. Turning about the tile's own
            // centre would swing the website out of the frame the canvas drew for it.
            if (rotation && finite(rotation) && pivot && finite(pivot.x) && finite(pivot.y)) {
                tile.wrapper.style.transformOrigin = `${pivot.x}px ${pivot.y}px`;
                tile.wrapper.style.transform = `rotate(${rotation}deg)`;
            } else if (tile.wrapper.style.transform) {
                tile.wrapper.style.transform = "";
                tile.wrapper.style.transformOrigin = "";
            }

            tile.clip.style.transform = `scale(${scale})`;
            tile.clip.style.left = `${offset.x}px`;
            tile.clip.style.top = `${offset.y}px`;
            tile.clip.style.width = `${content.w}px`;
            tile.clip.style.height = `${content.h}px`;

            // A CSS transform moves the frame without telling the widget layer, so native
            // dropdowns and IME drift until it is told.
            this._scheduleWidgetUpdate(tile);
        }

        // Batched: the page sends the whole set on one frame during a pan or zoom.
        //
        // The layer is repositioned first, on the same frame and before any tile inside it
        // is placed. The two have to move together — a tile's coordinates are relative to
        // the layer — and doing it here is what stops them ever disagreeing, whatever moved
        // the content area and whether or not it announced itself.
        layoutAll(easelId, entries) {
            const board = this._boardFor(easelId);
            // Nothing is placed while a splitter is being dragged. The layer is down and the
            // canvas is drawing the screenshots, so every rect written here would be work
            // nobody can see — and not free work either: _positionLayer reads the owner's
            // rect out of the chrome document, which forces a layout flush in the middle of
            // the drag Zen is trying to run. Skipping is most of what makes the divider
            // follow the pointer again.
            if (board && board.resizing) return;
            if (board) {
                // Re-resolved because a session restore or a remoteness flip swaps the tab's
                // <browser> without firing anything this side listens for, and a stale owner
                // means positioning against an element no longer in the document.
                if (!board.owner || !board.owner.isConnected) {
                    this._setOwner(board, this._easelBrowserFor(easelId));
                }
                // Placed before any tile inside it, on the same frame — a tile's
                // coordinates are relative to the layer, so the two must move together.
                // The only caller allowed to shrink the clip, because it is the only one
                // that knows the tiles are about to be placed for the new size.
                this._positionLayer(board, true);
            }
            for (const entry of entries) this.layout(easelId, entry.id, entry.geometry);
            // The layout the reveal was waiting for: the tiles are now placed for the size
            // the pane finished at, so the layer can go back up over them. Deliberately
            // after the loop rather than before it.
            this._revealAfterResize(board);
        }

        // Trailing-edge debounce is the wrong shape for this, and it was the reason a native
        // <select> floated away from its tile for the whole of a long pan: the old version
        // cleared and re-armed the timer on every layout() call, and layout() runs on every
        // painted frame while the board is moving — so the first widget update did not land
        // until 100ms after the pan *stopped*.
        //
        // Leading-edge instead: the first move arms the timer and subsequent ones only add
        // to the dirty set, so updates arrive every 100ms throughout the gesture. Dirty
        // rather than all-of-them because a tile that did not move has nothing to tell the
        // widget layer.
        _scheduleWidgetUpdate(tile) {
            if (tile) this._widgetDirty.add(tile);
            if (this._widgetTimer) return;
            this._widgetTimer = window.setTimeout(() => {
                this._widgetTimer = null;
                for (const dirty of this._widgetDirty) {
                    // A frame with no layers has no widgets to keep in step.
                    if (!dirty.painting) continue;
                    // A tile torn down between the arming and the flush is still in the set;
                    // the frameLoader is gone and the optional chain is what covers it.
                    try { dirty.browser.frameLoader?.requestUpdatePosition(); } catch (e) { }
                }
                this._widgetDirty.clear();
            }, 100);
        }

        // Only the activated tile takes the pointer; everything else stays transparent to it
        // so the canvas keeps full ownership of selection, dragging and the marquee.
        activate(easelId, objectId) {
            if (this._activeId === objectId) return;
            this.deactivate();
            const tile = this._tileFor(easelId, objectId);
            if (!tile) return;
            tile.lastUsedAt = Date.now();
            // A click can only land on a tile that is on screen, but there is a window of a
            // few hundred milliseconds after returning from the background where the page
            // has not yet reported this one visible again. Taking the pointer while still
            // hidden would hand input to something the user cannot see.
            tile.offscreen = false;
            this._applyTileState(tile);
            tile.wrapper.style.pointerEvents = "auto";
            tile.wrapper.style.outline = "2px solid var(--zen-primary-color, #2b5fd9)";
            tile.wrapper.style.outlineOffset = "-2px";
            this._activeId = objectId;
        }

        deactivate() {
            if (!this._activeId) return;
            const tile = this._tiles.get(this._activeId);
            if (tile) {
                tile.wrapper.style.pointerEvents = "none";
                tile.wrapper.style.outline = "";
            }
            this._activeId = null;
        }

        /* -------------------------------------------------------------- boards */

        // A page has finished opening a board and is asking what is already running on it.
        //
        // Synchronous, and returns plain data, because the page needs the answer before its
        // first paint: a tile it has not adopted by then is one its orphan sweep would treat
        // as stray. This is what makes switching boards — and reloading the tab — an
        // adoption rather than a remount.
        // `reveal` is false when the caller intends to lay the tiles out before showing them.
        // Returning to a backgrounded tab is that case: its tiles are still sitting where
        // they were when it was left, and putting the layer up before sync() has moved them
        // shows a frame of the board with everything in the wrong place. The page reveals
        // explicitly, with setBoardPainting, once the geometry is in.
        attach(easelId, reveal = true) {
            if (!easelId) return [];
            const board = this._ensureBoard(easelId);
            // A page only ever attaches from a document that is running, so it is visible as
            // far as this side is concerned; whether its tab is on screen is the other half.
            if (reveal) board.visible = true;
            board.tabShowing = this._isBoardTabShowing(easelId);
            // Re-targeted here as well as from mount() and TabSelect: session restore and a
            // remoteness flip both replace the tab's <browser> without firing either, and a
            // stale owner leaves the layer frozen with its observer on a detached element.
            this._setOwner(board, this._easelBrowserFor(easelId));

            const running = this._tilesOf(easelId)
                .map(tile => ({ objectId: tile.objectId, url: tile.url }));

            for (const tile of this._tilesOf(easelId)) {
                // offscreen and hidden are *page*-owned facts: which tiles are outside the
                // viewport, and which have a menu or a drag over them. An attaching page has
                // no such facts yet — it has just cleared its own copies — so anything left
                // here is a claim by a view that no longer exists, and nothing will ever
                // retract it. Both sides guard on "unchanged, return", so the disagreement
                // is permanent once made: the host holds the tile hidden while the page
                // believes it is painting and skips the screenshot, and the card is blank
                // for good with no way back but stopping and starting it.
                //
                // Reset to the neutral state instead, and let the page's next sync() say
                // what is true now. Neutral is the safe end of that: a tile wrongly painting
                // is one that is genuinely offscreen, and the layer clips to the tab
                // (overflow:hidden), so it paints outside the clip and shows nothing until
                // the grace expires and the page reports it properly.
                tile.offscreen = false;
                tile.hidden = false;
                this._applyTileState(tile);
            }
            this._applyLayerVisibility(board);
            this._positionLayer(board);
            this._startPositionLoop();
            return running;
        }

        // The page is going away for good — its tab closed, reloaded, or navigated off — and
        // this board's tiles go with it.
        //
        // Deliberately a teardown rather than the "the view left, the websites stay" that
        // backgrounding gets. The two are different events and the distinction is the whole
        // design: switching tabs or minimising is you looking elsewhere for a moment, and
        // the board should be current when you look back; unloading the page is the board
        // being put away, and Ctrl+R in particular is a request to start it over. A reload
        // that silently readopted its old content processes would be the one refresh in the
        // browser that does not actually refresh anything.
        //
        // Scoped to the board that is leaving. With a tab per easel there can be several
        // pages alive at once, and one of them unloading says nothing about the others.
        detach(easelId = null) {
            if (!easelId) return;
            const board = this._boardFor(easelId);
            if (!board) return;
            board.visible = false;
            // _activeId is one per window — only one tile can hold the pointer — so a tile
            // on the departing board would otherwise keep pointerEvents and its outline.
            const active = this._activeId && this._tiles.get(this._activeId);
            if (active && active.easelId === easelId) this.deactivate();

            const n = this._tilesOf(easelId).length;
            if (n) this.log("the board's page went away; stopping", n, "live tiles");
            this.unmountBoard(easelId);
            // Unconditional, because unmount() only reclaims a board's layer once the board
            // is no longer visible *and* has no tiles — and a board that never ran one would
            // otherwise leave an empty layer in the chrome document for the life of the
            // window, one per easel ever opened.
            this._teardownBoard(easelId);
        }

        setBoardPainting(easelId, painting) {
            const board = this._boardFor(easelId);
            if (!board) return;
            board.visible = !!painting;
            board.tabShowing = this._isBoardTabShowing(easelId);
            for (const tile of this._tilesOf(easelId)) this._applyTileState(tile);
            this._applyLayerVisibility(board);
            if (this._boardPainting(board)) this._positionLayer(board);
            this._startPositionLoop();
        }

        unmountBoard(easelId) {
            for (const tile of this._tilesOf(easelId)) this.unmount(tile.objectId);
        }

        /* -------------------------------------------------------- idle timeout */

        // The cap bounds how many tiles can run at once; this bounds how long one runs
        // unattended. They are different problems: you can sit well under the cap and still
        // have a logged-in dashboard quietly holding a content process open because you
        // scrolled past it before lunch.
        //
        // Only tiles that are *not painting* age. A card on screen is being looked at, and
        // one that is making sound is being listened to, so neither is idle however long it
        // has been there. What ages is a tile nobody has seen or heard since it went away —
        // which, once the timeout expires, goes back to being a screenshot with a ▶ on it.
        // Nothing is lost that a click does not restore.
        get idleTimeoutMs() {
            const min = window.ZenEaselUtil.prefs["live.idle-timeout-min"];
            return Number.isInteger(min) && min > 0 ? min * 60000 : 0;
        }

        _reapIdle() {
            const timeout = this.idleTimeoutMs;
            if (!timeout) return;
            const now = Date.now();

            for (const id of [...this._tiles.keys()]) {
                const tile = this._tiles.get(id);
                if (!tile || tile.painting || !tile.notPaintingSince) continue;
                // Audible means in use. Parking a stream on a board and working elsewhere is
                // a thing people do on purpose, and cutting it off mid-track would be the
                // one failure of this feature nobody would forgive.
                if (tile.audible && !tile.muted) continue;
                if (now - tile.notPaintingSince < timeout) continue;

                this.log("stopping a live tile idle for", Math.round(timeout / 60000), "min:", tile.url);
                const easelId = tile.easelId;
                this.unmount(id);
                // Reported the same way an eviction is: the page skips the screenshot for
                // anything it believes is live, so a tile reaped without telling it leaves
                // a blank card. A null reason is forget-without-toast — this is a quiet
                // housekeeping action, not a failure the user needs told about.
                this._notifyPage(easelId, id, null);
            }
        }

        // One interval for the window rather than a timer per tile, and only while there is
        // something to reap. A minute's resolution on a timeout measured in tens of minutes
        // is far more than enough, and it costs a walk over a handful of tiles.
        _startIdleSweep() {
            if (this._idleTimer) return;
            this._idleTimer = window.setInterval(() => this._reapIdle(), IDLE_CHECK_MS);
        }

        _stopIdleSweep() {
            if (!this._idleTimer) return;
            window.clearInterval(this._idleTimer);
            this._idleTimer = null;
        }

        /* ----------------------------------------------------------------- cap */

        // The ceiling has to live here rather than on the page, because the page only ever
        // knows about the board it has open and tiles now outlive board switches — a
        // page-side count would read three while the window was running nine.
        get maxTiles() {
            // 0, or anything not a positive integer, is deliberately "no ceiling": now that
            // a tile survives until you stop it, the cap is a safety rail rather than a
            // policy. Infinity rather than a sentinel so the loop below reads the same
            // either way.
            const n = window.ZenEaselUtil.prefs["live.max-tiles"];
            return Number.isInteger(n) && n > 0 ? n : Infinity;
        }

        // Returns false if the cap cannot be met, which is the signal to refuse the mount.
        // Refusing is better than the alternative: the only tile left to take would be the
        // one the pointer is inside, and stopping that to start another is not a trade the
        // user asked for.
        _evictFor(easelId) {
            // Mounts in flight count against the cap. They are not in _tiles yet but they
            // have each claimed a seat, and a check that ignored them would hand the same
            // one out twice.
            const cap = this.maxTiles;
            while (this._tiles.size + this._pending >= cap) {
                const victim = this._pickVictim(easelId);
                if (!victim) return false;
                this.log("evicting a live tile to stay under the cap:", victim.objectId);
                // Told, not silently dropped. The page skips the screenshot for anything it
                // believes is live, so an eviction it does not hear about leaves a
                // permanently blank card with no way back. A null reason is
                // forget-without-toast, which onLiveTileLost already handles.
                const { easelId: victimBoard, objectId } = victim;
                this.unmount(objectId);
                this._notifyPage(victimBoard, objectId, null);
            }
            return true;
        }

        // Least-recently-used, but tiered: anything the user cannot currently see goes
        // before anything they can, and a board they are not looking at goes before the one
        // they are. The active tile is never a candidate.
        _pickVictim(mountingBoard) {
            const tiers = [
                t => !t.painting && t.easelId !== mountingBoard,
                t => !t.painting,
                t => t.objectId !== this._activeId
            ];
            for (const matches of tiers) {
                let best = null;
                for (const tile of this._tiles.values()) {
                    if (tile.objectId === this._activeId || !matches(tile)) continue;
                    if (!best || tile.lastUsedAt < best.lastUsedAt) best = tile;
                }
                if (best) return best;
            }
            return null;
        }

        // Page-facing and board-guarded. unmount() itself stays unguarded because the host's
        // own teardown paths already hold the tile they mean.
        unmountFor(easelId, objectId) {
            if (this._tileFor(easelId, objectId)) this.unmount(objectId);
        }

        // What the census in a board's topbar reports. The window total matters more than
        // the board's: the off-board tiles are exactly the ones with no reachable badge.
        // Every easel tab shows the same total, which is the point — whichever board you
        // happen to be looking at can account for everything the window is running.
        count(easelId = null) {
            let board = 0;
            for (const tile of this._tiles.values()) {
                if (easelId && tile.easelId === easelId) board++;
            }
            return { total: this._tiles.size, board };
        }

        // Everything running in this window, for the census popup. Plain data, and it
        // includes the board each tile is on, because "which board is this on" is the one
        // thing the user cannot work out for a tile they cannot see.
        list(easelId = null) {
            const out = [];
            for (const tile of this._tiles.values()) {
                out.push({
                    objectId: tile.objectId,
                    easelId: tile.easelId,
                    url: tile.url,
                    onThisBoard: !!easelId && tile.easelId === easelId,
                    painting: !!tile.painting
                });
            }
            return out;
        }

        // The one control that can reach a tile whose board is not open. Reported to the
        // page for anything on the attached board, so its model and the canvas keep up;
        // the rest simply go.
        stopAll() {
            for (const id of [...this._tiles.keys()]) {
                const tile = this._tiles.get(id);
                const easelId = tile ? tile.easelId : null;
                this.unmount(id);
                this._notifyPage(easelId, id, null);
            }
        }

        /* ---------------------------------------------------------- painting tier */

        // Two reasons a tile may not be showing, and they are not the same reason.
        //
        //   offscreen  it is outside the viewport, or belongs to a board that is not open.
        //              A tier: it may last minutes, so it is worth releasing what can be
        //              released. The site keeps running throughout — that is the feature.
        //   hidden     a drag is in progress or a menu is over it. Transient, a few frames,
        //              so nothing is released; re-acquiring would cost a visible flash on
        //              release for no gain.
        //
        // Derived from flags rather than commanded directly, so that the page reports facts
        // and the host decides what they mean. A page that dies mid-gesture then leaves the
        // host holding state it can still evaluate rather than a half-applied instruction.
        // Tiles are only ever addressed together with the board they belong to. A mismatch
        // is not an error worth surfacing — the page's model and the host's census are
        // allowed to disagree for the length of a frame — but it must not act.
        _tileFor(easelId, objectId) {
            const tile = this._tiles.get(objectId);
            return tile && tile.easelId === easelId ? tile : null;
        }

        _tilesOf(easelId) {
            const out = [];
            if (!easelId) return out;
            for (const tile of this._tiles.values()) {
                if (tile.easelId === easelId) out.push(tile);
            }
            return out;
        }

        // Two independent "is it on screen" signals, and both are needed. `visible` is the
        // page's own document.hidden — it covers minimising and switching workspaces.
        // `tabShowing` is whether that board's tab is on screen, which the page cannot see
        // at all. Either alone leaves a case where tiles paint over another tab.
        //
        // A tile whose board has no entry at all is one whose page never attached; it does
        // not paint, which is the safe answer.
        _applyTileState(tile) {
            const board = this._boardFor(tile.easelId);
            const painting = this._boardPainting(board) && !tile.offscreen;
            if (painting !== tile.painting) this._setPainting(tile, painting);
            tile.wrapper.style.visibility = (painting && !tile.hidden) ? "" : "hidden";
        }

        // Visibility only, for now. Dropping renderLayers is what actually releases the
        // compositor's hold, and it is added separately behind a measurement that an
        // inactive layer tree does not also park the site's timers. Until then this is the
        // mechanism the menu-suppression path has always used, which is known to keep the
        // site running.
        _setPainting(tile, painting) {
            tile.painting = painting;
            // Stamped on the way *out*, not reused from lastUsedAt. The two answer different
            // questions: lastUsedAt is the LRU key and wants "when was this last wanted",
            // which for a tile that has been on screen for two hours is now. This wants
            // "how long has it been out of sight", and taking it from lastUsedAt would reap
            // that tile the instant it scrolled away.
            if (painting) {
                tile.notPaintingSince = 0;
                tile.lastUsedAt = Date.now();
            } else if (!tile.notPaintingSince) {
                tile.notPaintingSince = Date.now();
            }
            if (painting) this._widgetDirty.add(tile);
            this._applyAudio(tile);
        }

        // A live tile is not in gBrowser, so it gets no tab speaker icon and no tab mute
        // button — Zen's per-tab audio UI cannot see it at all. That did not matter while a
        // tile died within five seconds of scrolling off; it matters a great deal now.
        //
        // So the default behaves like a background tab: keep playing what was already
        // playing, and do not start. A tile the user set going on purpose keeps going when
        // it scrolls off. A silent one is muted, so an ad or an autoplaying embed cannot
        // start talking from a board you are not looking at with no tab to trace it to.
        //
        // userMuted wins in both directions — an unconditional unmute on return would
        // quietly undo the card's own Mute setting.
        _applyAudio(tile) {
            const browser = tile.browser;
            if (!browser) return;
            const muted = tile.userMuted || (!tile.painting && !tile.audible);
            if (muted === tile.muted) return;
            tile.muted = muted;
            try { muted ? browser.mute() : browser.unmute(); } catch (e) {
                this.log("could not change a tile's mute state:", e.message);
            }
        }

        setTileMuted(easelId, objectId, muted) {
            const tile = this._tileFor(easelId, objectId);
            if (!tile) return;
            tile.userMuted = !!muted;
            this._applyAudio(tile);
        }

        // The same two events tabbrowser listens for to draw a tab's speaker glyph.
        //
        // Note the asymmetry, and do not try to poll around it: audioPlaybackStarted()
        // early-returns while the browser is muted, so `audible` can go true→false while
        // muted but never false→true. "Was audible" is therefore a snapshot taken at the
        // moment the tile stopped painting, not a live signal — a tile muted on the way out
        // stays muted until it paints again. That is the honest boundary of the API.
        _watchAudio(tile) {
            const browser = tile.browser;
            const started = () => { tile.audible = true; };
            const stopped = () => { tile.audible = false; };
            browser.addEventListener("DOMAudioPlaybackStarted", started);
            browser.addEventListener("DOMAudioPlaybackStopped", stopped);
            tile.detachAudio = () => {
                try {
                    browser.removeEventListener("DOMAudioPlaybackStarted", started);
                    browser.removeEventListener("DOMAudioPlaybackStopped", stopped);
                } catch (e) { }
            };
        }

        // The page says this tile is outside the viewport, or is not on the open board.
        setTileOffscreen(easelId, objectId, offscreen) {
            const tile = this._tileFor(easelId, objectId);
            if (!tile || tile.offscreen === !!offscreen) return;
            tile.offscreen = !!offscreen;
            if (!tile.offscreen) tile.lastUsedAt = Date.now();
            this._applyTileState(tile);
        }

        // Hidden rather than unmounted: a drag wants the tile out of the way for a few
        // frames, not a reload afterwards.
        setTileHidden(easelId, objectId, hidden) {
            const tile = this._tileFor(easelId, objectId);
            if (!tile || tile.hidden === !!hidden) return;
            tile.hidden = !!hidden;
            this._applyTileState(tile);
        }

        // Removing the wrapper is not enough on its own, and that is what left a dead
        // picture of the website behind when a live card was deleted.
        //
        // A tile is created active — _markActive sets docShellIsActive and renderLayers
        // together, because an inactive remote frame never finishes rendering an SPA —
        // and nothing ever told it otherwise. Detaching a subtree containing a remote
        // browser that still holds render layers can leave its last composited frame on
        // screen: the pixels stay, and nothing responds to them, because the wrapper's
        // pointer-events was "none" all along. Dropping the layers first is what
        // actually retires the frame.
        //
        // The ordering matters: layers, then the docshell, then the browser element,
        // then the wrapper. Each step is guarded — a tile whose content process has
        // already died throws on every property here, and a teardown that gives up
        // halfway is exactly the state being fixed.
        unmount(objectId) {
            const tile = this._tiles.get(objectId);
            if (!tile) return;
            if (this._activeId === objectId) this._activeId = null;

            // Timers and the progress listener outlive the element otherwise. _watchLoad
            // only clears them when the load settles, and an unmount is precisely the
            // case where it never does.
            window.clearTimeout(tile.loadTimer);
            window.clearTimeout(tile.navCheckTimer);
            if (tile.detachListener) {
                try { tile.detachListener(); } catch (e) { }
                tile.detachListener = null;
            }
            if (tile.detachAudio) {
                try { tile.detachAudio(); } catch (e) { }
                tile.detachAudio = null;
            }

            // Strong reference, unlike _byBrowser — a tile left in here after teardown
            // would keep its wrapper and browser alive until the next flush.
            this._widgetDirty.delete(tile);

            const browser = tile.browser;
            if (browser) {
                try { browser.renderLayers = false; } catch (e) { }
                try { browser.docShellIsActive = false; } catch (e) { }
                try { browser.remove(); } catch (e) { }
            }
            tile.wrapper.remove();

            const easelId = tile.easelId;
            this._tiles.delete(objectId);

            // A board's layer goes when its last tile does, but only if no page is still
            // attached to it — an attached board is about to be given more tiles, and
            // recreating the layer would be churn for nothing.
            const board = this._boardFor(easelId);
            if (board && !board.visible && !this._tilesOf(easelId).length) {
                this._teardownBoard(easelId);
            }
            if (!this._tiles.size) {
                this._stopIdleSweep();
                this._stopPositionLoop();
            }
        }

        unmountAll() {
            // Bumped first, so a mount() already awaiting its frame loader sees the change
            // when it resumes and cleans up after itself instead of registering a tile this
            // sweep can no longer reach.
            this._generation++;
            for (const id of [...this._tiles.keys()]) this.unmount(id);
            this._stopIdleSweep();
            this._stopPositionLoop();
            for (const easelId of [...this._boards.keys()]) this._teardownBoard(easelId);
        }

        isLive(objectId) {
            return this._tiles.has(objectId);
        }

        /* ------------------------------------------------------------ lifecycle */

        // Every board is re-evaluated, not just one: a tab switch changes which of them are
        // on screen, and with a tab per easel more than one answer can change at a time —
        // in a split view, two boards can be showing at once.
        _onTabSelect() {
            for (const board of this._boards.values()) {
                board.tabShowing = this._isBoardTabShowing(board.easelId);
                // Re-targeted rather than merely compared. Hiding on a changed owner was the
                // right answer when that meant the tiles were gone anyway; now they are not,
                // and a stale owner would leave the layer hidden for good with its
                // ResizeObserver watching an element no longer in the document.
                const owner = this._easelBrowserFor(board.easelId);
                if (owner) this._setOwner(board, owner);
                this._applyLayerVisibility(board);
                if (board.tabShowing) this._positionLayer(board);
            }
            for (const tile of this._tiles.values()) this._applyTileState(tile);
            this._startPositionLoop();
        }

        // The backstop for a board whose tab went away without its page saying so.
        //
        // Closing a tab normally fires pagehide, and detach() stops that board's tiles
        // there — synchronously, while the page still exists to say which board it was.
        // This covers what that misses: a content process that died, a window teardown
        // that skipped the event, anything that leaves tiles belonging to a tab that is no
        // longer in the strip. Without it those are live websites with no UI and no off
        // switch, which is the worst state available.
        //
        // Never acted on synchronously, because "no matching tab" is briefly true in
        // perfectly ordinary situations: session restore's tab swaps momentarily have no
        // matching URI. The question is re-asked after a settle, and only a still-missing
        // tab counts.
        _onTabClose() {
            if (!this._tiles.size || this._orphanTimer) return;
            this._orphanTimer = window.setTimeout(() => {
                this._orphanTimer = null;
                if (this._destroyed || !this._tiles.size) return;

                for (const easelId of [...new Set([...this._tiles.values()].map(t => t.easelId))]) {
                    if (this._easelBrowserFor(easelId)) continue;
                    const n = this._tilesOf(easelId).length;
                    this.log("a board's tab is gone; stopping", n, "live tiles");
                    this.unmountBoard(easelId);
                    this._teardownBoard(easelId);
                }
                this._onTabSelect();
            }, ORPHAN_CHECK_MS);
        }

        destroy() {
            // Set before unmountAll so a mount() resuming after this point declines outright
            // rather than merely noticing the generation moved.
            this._destroyed = true;
            try {
                gBrowser.tabContainer.removeEventListener("TabSelect", this._onTabSelect);
                gBrowser.tabContainer.removeEventListener("TabClose", this._onTabClose);
            } catch (e) { }
            if (this._splitObserver) {
                try { this._splitObserver.disconnect(); } catch (e) { }
                this._splitObserver = null;
            }
            if (this._splitSettleTimer) window.clearTimeout(this._splitSettleTimer);
            if (this._widgetTimer) window.clearTimeout(this._widgetTimer);
            if (this._orphanTimer) window.clearTimeout(this._orphanTimer);
            this._stopIdleSweep();
            this._stopPositionLoop();
            this.unmountAll();
        }
    }

    window.ZenEaselLiveHost = ZenEaselLiveHost;
})();
