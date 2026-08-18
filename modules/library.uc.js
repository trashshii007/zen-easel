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
            const actions = this.el("div", { className: "easel-topbar-actions" }, [
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
            this.host.shadowRoot.addEventListener("pointerdown", this._onOutsidePointerDown, true);
        }

        closeList() {
            if (!this._open) return;
            this._open = false;
            this._list.setAttribute("hidden", "true");
            this._switcher.classList.remove("is-open");
            this.host.shadowRoot.removeEventListener("pointerdown", this._onOutsidePointerDown, true);
        }

        _onOutsidePointerDown(e) {
            if (!this._list.contains(e.target) && !this._switcher.contains(e.target)) this.closeList();
        }

        _renderList() {
            this._list.replaceChildren();
            const current = this.host.store.current;

            for (const entry of this.host.store.listEasels()) {
                const isCurrent = current && entry.id === current.id;
                this._list.appendChild(this.el("button", {
                    className: `easel-list-item${isCurrent ? " is-current" : ""}`,
                    type: "button",
                    onclick: () => { this.closeList(); this.switchTo(entry.id); }
                }, [
                    this.el("span", { className: "easel-list-name", textContent: entry.title || "Untitled Easel" }),
                    this.el("span", { className: "easel-list-when", textContent: formatWhen(entry.updatedAt) })
                ]));
            }

            this._list.append(
                this.el("div", { className: "easel-list-separator" }),
                this._action("New easel", () => this.createNew()),
                this._action("Rename this easel", () => this.renameCurrent()),
                this._action("Delete this easel", () => this.deleteCurrent(), true)
            );
        }

        _action(label, handler, danger = false) {
            return this.el("button", {
                className: `easel-list-action${danger ? " is-danger" : ""}`,
                type: "button",
                textContent: label,
                onclick: () => { this.closeList(); handler(); }
            });
        }

        /* --------------------------------------------------------- operations */

        async switchTo(id) {
            const current = this.host.store.current;
            if (current && current.id === id) return;
            try {
                const doc = await this.host.store.open(id);
                if (!doc) {
                    // open() drops entries whose file has gone missing, so the list
                    // needs rebuilding even though nothing opened.
                    this.refresh();
                    // Said out loud: whatever asked for this easel is about to carry on
                    // with a different one still open, and a capture quietly landing on
                    // the wrong board is worse than being told the right one is gone.
                    this.host.toast("That easel no longer exists");
                    return;
                }
                this.host.canvas.setDocument(doc);
                this.refresh();
            } catch (e) {
                console.error("[zen-easel] could not switch easel:", e);
            }
        }

        async createNew() {
            const title = this._prompt("New easel", "Name this easel:", "Untitled Easel");
            if (title === null) return;
            try {
                const doc = await this.host.store.create(title.trim() || "Untitled Easel");
                this.host.canvas.setDocument(doc);
                this.refresh();
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

            await this.host.store.remove(doc.id);
            // Deleting the last easel leaves nothing open; openLast makes a fresh one
            // rather than dropping the user onto a dead canvas.
            const next = await this.host.store.openLast();
            this.host.canvas.setDocument(next);
            this.refresh();
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
        }
    }

    window.ZenEaselLibrary = ZenEaselLibrary;
})();
