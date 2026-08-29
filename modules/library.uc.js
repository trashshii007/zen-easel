// Zen Easel — easel switcher.
//
// The minimum UI needed to own more than one easel: which one is open, a list to
// switch between them, and new/rename/delete. The full Easels-&-Notes browser and the
// sidebar entries Arc has are deliberately out of scope for v1 — when this folds into
// zen-library, that list becomes the tab's own sidebar and this shrinks to a title.

"use strict";

(function () {
    if (window.ZenEaselLibrary) return;

    const formatWhen = timestamp => {
        if (!timestamp) return "";
        const delta = Date.now() - timestamp;
        const minute = 60000, hour = 3600000, day = 86400000;
        if (delta < minute) return "just now";
        if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
        if (delta < day) return `${Math.floor(delta / hour)}h ago`;
        if (delta < day * 7) return `${Math.floor(delta / day)}d ago`;
        return new Date(timestamp).toLocaleDateString();
    };

    class ZenEaselLibrary {
        constructor(host, root) {
            this.host = host;
            this.root = root;              // header.easel-topbar
            this.el = window.ZenEaselUtil.el;
            this._open = false;
            // The census popup, and the outside-click listener the two popups share. Both
            // real booleans from the start: _syncOutsideListener compares its wanted state
            // against what is registered, and `undefined` on one side of that comparison
            // makes the first call decide by accident rather than by the flags.
            this._censusOpen = false;
            this._outsideBound = false;
            // Last count written to the census button. Null rather than 0 so that the first
            // update writes the button even when nothing is running, which is what puts it
            // into its hidden state.
            this._lastLiveCount = null;
            this._onOutsidePointerDown = this._onOutsidePointerDown.bind(this);
        }

        render() {
            this.root.replaceChildren();

            this._title = this.el("span", { className: "easel-title-text", textContent: "Untitled Easel" });
            this._switcher = this.el("button", {
                className: "easel-switcher",
                type: "button",
                title: "Switch easel",
                onclick: e => { e.stopPropagation(); this.toggleList(); }
            }, [this._title, this.el("span", { className: "easel-chevron", textContent: "▾" })]);

            this._list = this.el("div", { className: "easel-list", hidden: "true" });

            this._zoom = this.el("button", {
                className: "easel-zoom",
                type: "button",
                title: "Reset zoom (Ctrl+0)",
                textContent: "100%",
                onclick: () => this.host.canvas.resetZoom()
            });

            // No capture button here any more. Captures arrive either from Zen's own
            // screenshot preview ("Move to easel") or from the capture shortcut, both
            // of which are reachable from the page you are actually capturing — which
            // a button inside the easel never is.
            // The live-tile census. Hidden whenever nothing is running, so a board with no
            // live cards looks exactly as it did.
            //
            // It reports the *window* total rather than this board's, and that is the whole
            // reason it exists: a tile keeps running when its board is closed, and the pause
            // badge goes with the board. Without something here, a site left running on a
            // board you are not looking at has no reachable off switch at all.
            this._census = this.el("button", {
                className: "easel-live-census",
                type: "button",
                hidden: "true",
                title: "Live web cards running in this window",
                onclick: e => { e.stopPropagation(); this.toggleCensus(); }
            });
            this._censusPanel = this.el("div", { className: "easel-live-panel", hidden: "true" });

            const actions = this.el("div", { className: "easel-topbar-actions" }, [
                this.el("div", { className: "easel-live-census-wrap" },
                    [this._census, this._censusPanel]),
                this._zoom,
                this.el("button", {
                    className: "easel-topbar-button easel-close",
                    type: "button",
                    title: "Close (Esc)",
                    textContent: "✕",
                    onclick: () => this.host.requestClose()
                })
            ]);

            this.root.append(
                this.el("div", { className: "easel-topbar-left" }, [this._switcher, this._list]),
                actions
            );
        }

        refresh() {
            const doc = this.host.store.current;
            if (this._title) this._title.textContent = doc ? doc.title : "No easel";
            this.updateZoom();
            if (this._open) this._renderList();
            // The tab's label and its ?easel= parameter both follow the open document,
            // and this is the one place every operation that changes it passes through.
            if (this.host.onDocumentChanged) this.host.onDocumentChanged();
        }

        // Called from every painted frame, so it compares before writing: an
        // unconditional textContent assignment per frame is a layout invalidation for
        // a string that changes only when the zoom does.
        updateZoom() {
            if (!this._zoom || !this.host.canvas) return;
            const percent = Math.round(this.host.canvas.view.zoom * 100);
            if (percent === this._lastZoom) return;
            this._lastZoom = percent;
            this._zoom.textContent = `${percent}%`;
        }

        /* ---------------------------------------------------------- live census */

        // Same shape as updateZoom, and called from the same painted frame: compared
        // before writing, because an unconditional assignment per frame is a layout
        // invalidation for a number that changes a handful of times a session.
        updateLiveCount() {
            if (!this._census) return;
            const total = (this.host.bridge?.liveCount() ?? { total: 0 }).total;
            if (total === this._lastLiveCount) return;
            this._lastLiveCount = total;

            this._census.textContent = `◉ ${total}`;
            if (total) this._census.removeAttribute("hidden");
            else this._census.setAttribute("hidden", "true");

            if (!total) this.closeCensus();
            else if (this._censusOpen) this._renderCensus();
        }

        toggleCensus() {
            this._censusOpen ? this.closeCensus() : this.openCensus();
        }

        openCensus() {
            if (this._censusOpen) return;
            this._censusOpen = true;
            this._censusPanel.removeAttribute("hidden");
            this._census.classList.add("is-open");
            this._renderCensus();
            this._syncOutsideListener();
        }

        closeCensus() {
            if (!this._censusOpen) return;
            this._censusOpen = false;
            this._censusPanel.setAttribute("hidden", "true");
            this._census.classList.remove("is-open");
            this._syncOutsideListener();
        }

        // One listener, two popups. Registered while either is open and removed only when
        // both are closed — the switcher and the census share the handler, so whichever
        // closed last must not take the listener the other is still relying on.
        _syncOutsideListener() {
            // Both dropdowns hang below the topbar and over the board, so either appearing
            // or disappearing changes the holes cut in the live-tile layer. Called from here
            // because all four of the open/close methods already end with this one — and
            // before the early return below, which is about the listener, not the panels.
            this.host.chromeChanged();

            const wanted = !!(this._open || this._censusOpen);
            if (wanted === this._outsideBound) return;
            this._outsideBound = wanted;
            const root = this.host.shadowRoot;
            if (wanted) root.addEventListener("pointerdown", this._onOutsidePointerDown, true);
            else root.removeEventListener("pointerdown", this._onOutsidePointerDown, true);
        }

        _renderCensus() {
            const bridge = this.host.bridge;
            const rows = bridge?.liveList(this.host.store.current?.id) ?? [];
            const current = this.host.store.current;

            const children = [this.el("div", {
                className: "easel-live-panel-head",
                textContent: rows.length === 1 ? "1 live card" : `${rows.length} live cards`
            })];

            for (const row of rows) {
                // The board's title, not its id — and the id is all the host can know, so
                // it is resolved here against the library's own index.
                const board = row.onThisBoard && current
                    ? current.title
                    : (this._entryTitle(row.easelId) || "another easel");

                children.push(this.el("div", { className: "easel-live-row" }, [
                    this.el("div", { className: "easel-live-row-text" }, [
                        this.el("span", {
                            className: "easel-live-row-url",
                            textContent: this._hostOf(row.url)
                        }),
                        this.el("span", {
                            className: "easel-live-row-board",
                            textContent: board
                        })
                    ]),
                    this.el("button", {
                        className: "easel-live-row-stop",
                        type: "button",
                        title: "Stop this card",
                        textContent: "✕",
                        onclick: () => {
                            bridge?.liveUnmount(row.easelId, row.objectId);
                            // The page's own model only knows this board's tiles.
                            if (row.onThisBoard) this.host.live?.forget(row.objectId);
                            this.updateLiveCount();
                            this._renderCensus();
                        }
                    })
                ]));
            }

            children.push(this.el("button", {
                className: "easel-live-stop-all",
                type: "button",
                textContent: "Stop all live cards",
                onclick: () => {
                    bridge?.liveStopAll();
                    this.closeCensus();
                    this.updateLiveCount();
                }
            }));

            this._censusPanel.replaceChildren(...children);
            // Re-rendered whenever a card is stopped from inside it, which changes its
            // height while it is open over the board.
            this.host.chromeChanged();
        }

        _entryTitle(easelId) {
            const entry = this.host.store.listEasels().find(e => e.id === easelId);
            return entry ? entry.title : null;
        }

        // Just the host, because a full URL in a narrow popup is all path and no meaning.
        _hostOf(url) {
            try { return new URL(url).host || url; } catch (e) { return url || "…"; }
        }

        /* ----------------------------------------------------------- the list */

        toggleList() {
            this._open ? this.closeList() : this.openList();
        }

        openList() {
            this._open = true;
            this._renderList();
            // Another window may have added or renamed an easel since this list was last
            // read, so re-render once the fresh index lands. Rendering twice avoids
            // making the click wait on a file read.
            this.host.store.refreshList()
                .then(() => { if (this._open) this._renderList(); })
                .catch(e => console.error("[zen-easel]", e));
            this._list.removeAttribute("hidden");
            this._switcher.classList.add("is-open");
            this._syncOutsideListener();
        }

        closeList() {
            if (!this._open) return;
            this._open = false;
            this._list.setAttribute("hidden", "true");
            this._switcher.classList.remove("is-open");
            this._syncOutsideListener();
        }

        _onOutsidePointerDown(e) {
            if (this._open &&
                !this._list.contains(e.target) && !this._switcher.contains(e.target)) {
                this.closeList();
            }
            if (this._censusOpen &&
                !this._censusPanel.contains(e.target) && !this._census.contains(e.target)) {
                this.closeCensus();
            }
        }

        _renderList() {
            this._list.replaceChildren(...this._rows(() => this.closeList()));
            // Re-rendered a second time when the refreshed index arrives, which can change
            // the panel's height under a live tile that is already showing through it.
            this.host.chromeChanged();
        }

        // The switcher's contents, built fresh each time. `dismiss` closes whatever is
        // hosting them, which is not always this bar — see buildPicker.
        _rows(dismiss) {
            const current = this.host.store.current;
            const rows = [];

            for (const entry of this.host.store.listEasels()) {
                const isCurrent = current && entry.id === current.id;
                rows.push(this.el("button", {
                    className: `easel-list-item${isCurrent ? " is-current" : ""}`,
                    type: "button",
                    onclick: () => { dismiss(); this.switchTo(entry.id); }
                }, [
                    this.el("span", { className: "easel-list-name", textContent: entry.title || "Untitled Easel" }),
                    this.el("span", { className: "easel-list-when", textContent: formatWhen(entry.updatedAt) })
                ]));
            }

            rows.push(
                this.el("div", { className: "easel-list-separator" }),
                this._action(dismiss, "New easel", () => this.createNew()),
                this._action(dismiss, "Rename this easel", () => this.renameCurrent()),
                this._action(dismiss, "Delete this easel", () => this.deleteCurrent(), true)
            );
            return rows;
        }

        // The same list as a standalone panel, for the canvas' context menu to host once
        // the topbar — and with it the switcher — has been turned off.
        buildPicker(dismiss) {
            const list = this.el("div", { className: "easel-list is-inline" });
            list.replaceChildren(...this._rows(dismiss));
            // Same two-pass render as openList: another window may have touched the index.
            this.host.store.refreshList()
                .then(() => {
                    if (list.isConnected) list.replaceChildren(...this._rows(dismiss));
                })
                .catch(e => console.error("[zen-easel]", e));
            return list;
        }

        _action(dismiss, label, handler, danger = false) {
            return this.el("button", {
                className: `easel-list-action${danger ? " is-danger" : ""}`,
                type: "button",
                textContent: label,
                onclick: () => { dismiss(); handler(); }
            });
        }

        /* --------------------------------------------------------- operations */

        // Opens the board in its own tab rather than replacing this one's.
        //
        // Boards used to share a tab, so picking one from the switcher swapped the document
        // underneath you — which meant you could never have two open, reorder them, or put
        // two side by side in a split. A tab each costs nothing extra: the store's write
        // queue is a per-process singleton, so two pages cannot race on index.json, and the
        // live-tile host keys its layers by easel id rather than assuming one board.
        //
        // The chrome window owns this because it is the only side that can focus or open a
        // tab; if that board is already open somewhere, it focuses it instead.
        async switchTo(id) {
            const current = this.host.store.current;
            if (current && current.id === id) return;
            this.closeList();
            try {
                // Checked here rather than left to the new tab's own boot, because this page
                // has the switcher list open and can say so directly — a tab that opens onto
                // a missing easel just silently falls back to another board.
                const entries = await this.host.store.refreshList();
                if (!entries.some(e => e.id === id)) {
                    this.refresh();
                    this.host.toast("That easel no longer exists");
                    return;
                }
                this.host.bridge?.openEasel(id);
            } catch (e) {
                console.error("[zen-easel] could not open easel:", e);
            }
        }

        // A new board gets a new tab, for the same reason switching does — making one should
        // not close the one you were working on. Created through the chrome window rather
        // than this page's store so the document exists on disk before the tab is asked for,
        // which is what lets the tab open straight onto it with nothing to await.
        async createNew() {
            const title = this._prompt("New easel", "Name this easel:", "Untitled Easel");
            if (title === null) return;
            this.closeList();
            try {
                await this.host.bridge?.createEasel(title.trim() || "Untitled Easel");
            } catch (e) {
                console.error("[zen-easel] could not create easel:", e);
            }
        }

        async renameCurrent() {
            const doc = this.host.store.current;
            if (!doc) return;
            const title = this._prompt("Rename easel", "New name:", doc.title);
            if (title === null || !title.trim()) return;
            await this.host.store.rename(doc.id, title.trim());
            // Arc's sidebar cell writes its edited title straight back into the title
            // object, so the lettering on the board and the name in the library are never
            // allowed to disagree.
            this.host.canvas.applyTitleToHeading(title.trim());
            this.refresh();
        }

        async deleteCurrent() {
            const doc = this.host.store.current;
            if (!doc) return;

            let confirmed;
            try {
                confirmed = Services.prompt.confirm(
                    window,
                    "Delete easel",
                    `Delete "${doc.title}" and everything on it? This cannot be undone.`
                );
            } finally {
                this.host.viewport.focus({ preventScroll: true });
            }
            if (!confirmed) return;

            // Stopped explicitly, and by id captured before the board goes: a tile survives
            // its board being closed on purpose, so that switching away and back finds it
            // still running — but a board that has been *deleted* is never coming back, and
            // nothing else would ever reach those tiles again. The host's orphan check only
            // covers the easel tab going away, which is a different thing.
            const easelId = doc.id;
            try { this.host.bridge?.liveUnmountBoard(easelId); } catch (e) { console.error(e); }

            await this.host.store.remove(easelId);

            // The tab goes with the board. Falling back to another easel in place was right
            // when boards shared one tab, but now each has its own — and the board this
            // would fall back to is quite likely open in a tab already, which would leave
            // two tabs showing the same easel and the live host binding its tiles to
            // whichever it found first. Closing is also simply what a tab whose contents
            // have been deleted should do.
            this.host.requestClose();
        }

        // Zen renders these prompts inside the same chrome document, so focus lands in
        // the dialog and stays wherever it was left afterwards. Handing it back to the
        // viewport is what keeps canvas shortcuts live once the dialog closes.
        _prompt(title, message, initial) {
            const value = { value: initial };
            try {
                const ok = Services.prompt.prompt(window, title, message, value, null, { value: false });
                return ok ? value.value : null;
            } finally {
                this.host.viewport.focus({ preventScroll: true });
            }
        }

        destroy() {
            this.closeList();
            this.closeCensus();
        }
    }

    window.ZenEaselLibrary = ZenEaselLibrary;
})();
