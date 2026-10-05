// Zen Easel — the Easels section of Zen's library.
//
// Zen's library is a sidebar of sections. This adds one. The panel width and
// the search field belong to zen-library.css; nothing here sets
// --zen-library-content-width, which is the knob Spaces uses to grow the panel.
// The cards are the older framed easel cards, scaled to that native column.
// The on-board switcher (modules/library.uc.js) is a different thing and stays
// on the board.
//
// The section class is registered once per document. Custom elements cannot be
// replaced, so the class only forwards into this object — a Sine reload swaps
// the object and the already-defined element keeps working.

"use strict";

(function () {
    const BASE = "chrome://sine/content/zen-easel/";
    const STORE = BASE + "background/store.sys.mjs";
    const SECTION_ID = "easels";
    const SEARCH_MODULE = "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
    const LIT_MODULE = "chrome://global/content/vendor/lit.all.mjs";

    const inBackground = event =>
        !!event && (event.button === 1 || event.getModifierState("Accel"));

    function promptText(title, message, initial) {
        const value = { value: initial };
        const ok = Services.prompt.prompt(window, title, message, value, null, { value: false });
        return ok ? value.value : null;
    }

    const ZenEaselLibrarySection = {
        _cancelled: false,
        _labelWatch: new WeakMap(),
        _observers: new Set(),

        install() {
            this._cancelled = false;
            const run = () => {
                if (this._cancelled || window.ZenEaselLibrarySection !== this) return;
                try { this._start(); }
                catch (e) { console.error("[zen-easel] could not add the library section:", e); }
            };
            if (customElements.get("zen-library")) run();
            else customElements.whenDefined("zen-library").then(run).catch(() => {});
        },

        destroy() {
            this._cancelled = true;
            for (const observer of this._observers) observer.disconnect();
            this._observers.clear();
            for (const section of document.querySelectorAll("zen-library-easels-section")) {
                this.disconnect(section);
            }
        },

        _start() {
            this._defineElement();
            const ZenLibrary = customElements.get("zen-library");
            if (!ZenLibrary || !customElements.get("zen-library-easels-section")) return;

            if (!ZenLibrary.__zenEaselWrapped) {
                ZenLibrary.__zenEaselWrapped = true;
                const original = ZenLibrary.getInstance;
                ZenLibrary.getInstance = function (createIfMissing = true) {
                    const lib = original.call(this, createIfMissing);
                    if (lib) window.ZenEaselLibrarySection?.adopt(lib);
                    return lib;
                };
            }

            const existing = ZenLibrary.getInstance(false);
            if (existing) this.adopt(existing);
        },

        _defineElement() {
            // The shared module global has no document, and lit reads it while
            // loading. "current" is this browser window, which is where Zen
            // itself loads the library.
            const inWindow = { global: "current" };
            this._lit = ChromeUtils.importESModule(LIT_MODULE, inWindow);
            if (customElements.get("zen-library-easels-section")) return;
            const { ZenLibrarySearchSection } = ChromeUtils.importESModule(SEARCH_MODULE, inWindow);
            const { html } = this._lit;

            class ZenLibraryEaselsSection extends ZenLibrarySearchSection {
                static id = SECTION_ID;
                // Not a Fluent string Zen ships. The sidebar label is filled in
                // after render; leaving the id on the node lets Fluent clear it.
                static label = "library-easels-section-title";

                static render(library) {
                    return html`
                        <zen-library-easels-section
                            class="zen-library-section"
                            data-section=${SECTION_ID}
                            .library=${library}
                        ></zen-library-easels-section>
                    `;
                }

                get searchPlaceholderL10nId() {
                    return "zen-easel-library-search";
                }

                connectedCallback() {
                    super.connectedCallback();
                    window.ZenEaselLibrarySection?.connect(this);
                }

                disconnectedCallback() {
                    window.ZenEaselLibrarySection?.disconnect(this);
                    super.disconnectedCallback();
                }

                onShown() {
                    window.ZenEaselLibrarySection?.load(this);
                }

                onHidden() {
                    window.ZenEaselLibrarySection?.pause(this);
                }

                onLibraryOpening() {
                    window.ZenEaselLibrarySection?.load(this);
                }

                updated(changedProperties) {
                    super.updated?.(changedProperties);
                    window.ZenEaselLibrarySection?.fixSection(this);
                }

                renderItems() {
                    return window.ZenEaselLibrarySection?.renderItems(this) ?? null;
                }
            }

            customElements.define("zen-library-easels-section", ZenLibraryEaselsSection);
        },

        adopt(lib) {
            if (!lib || this._cancelled) return;
            const Section = customElements.get("zen-library-easels-section");
            if (!Section) return;

            if (!lib.zenLibrarySections[SECTION_ID]) {
                const sections = {};
                let placed = false;
                for (const [id, Known] of Object.entries(lib.zenLibrarySections)) {
                    sections[id] = Known;
                    if (id === "media") {
                        sections[SECTION_ID] = Section;
                        placed = true;
                    }
                }
                if (!placed) sections[SECTION_ID] = Section;
                lib.zenLibrarySections = sections;

                // The constructor already chose a tab, before this id existed,
                // so a last-tab pref of "easels" would have fallen back to history.
                let last = "";
                try { last = Services.prefs.getStringPref("zen.library.last-tab", ""); }
                catch (e) { last = ""; }
                if (last === SECTION_ID && lib.activeTab !== SECTION_ID) {
                    lib.activeTab = SECTION_ID;
                }
                lib.requestUpdate();
            }
            this._watchLabel(lib);
        },

        _watchLabel(lib) {
            if (this._labelWatch.has(lib)) {
                this._fixLabel(lib);
                return;
            }
            const observer = new MutationObserver(() => {
                const tabs = lib.querySelector("#zen-library-sidebar-tabs");
                if (tabs && observer._root !== tabs) {
                    observer.disconnect();
                    observer._root = tabs;
                    observer.observe(tabs, {
                        subtree: true,
                        childList: true,
                        characterData: true,
                        attributes: true,
                        attributeFilter: ["data-l10n-id"]
                    });
                }
                this._fixLabel(lib);
            });
            const tabs = lib.querySelector("#zen-library-sidebar-tabs");
            observer._root = tabs || lib;
            observer.observe(observer._root, {
                subtree: true,
                childList: true,
                characterData: !!tabs,
                attributes: true,
                attributeFilter: ["data-l10n-id"]
            });
            this._labelWatch.set(lib, observer);
            this._observers.add(observer);
            this._fixLabel(lib);
        },

        _fixLabel(lib) {
            const label = lib.querySelector(`.zen-library-tab[data-section="${SECTION_ID}"] label`);
            if (!label) return;
            if (label.hasAttribute("data-l10n-id")) label.removeAttribute("data-l10n-id");
            if (label.textContent !== "Easels") label.textContent = "Easels";
        },

        connect(section) {
            if (section._chromeObserver) {
                this.load(section);
                return;
            }
            const observer = new MutationObserver(() => this.fixSection(section));
            observer.observe(section, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["data-l10n-id", "placeholder"]
            });
            section._chromeObserver = observer;
            this._observers.add(observer);
            this.load(section);
            this.fixSection(section);
        },

        disconnect(section) {
            if (section._loadTimer) {
                clearTimeout(section._loadTimer);
                section._loadTimer = null;
            }
            section._boardGen = (section._boardGen || 0) + 1;
            section._chromeObserver?.disconnect();
            if (section._chromeObserver) this._observers.delete(section._chromeObserver);
            section._chromeObserver = null;
            section._boards = null;
        },

        pause(section) {
            if (section._loadTimer) {
                clearTimeout(section._loadTimer);
                section._loadTimer = null;
            }
        },

        fixSection(section) {
            const input = section.querySelector(".zen-library-search-box input");
            if (!input) return;
            if (input.hasAttribute("data-l10n-id")) input.removeAttribute("data-l10n-id");
            if (input.getAttribute("placeholder") !== "Search easels") {
                input.setAttribute("placeholder", "Search easels");
            }
        },

        // onShown and onLibraryOpening land in the same turn when the panel
        // opens on this tab. One load is enough.
        load(section) {
            if (section._loadTimer) return;
            section._loadTimer = setTimeout(() => {
                section._loadTimer = null;
                if (section.isConnected && !section.hidden) this._loadNow(section);
            }, 0);
        },

        async _loadNow(section) {
            const gen = (section._boardGen || 0) + 1;
            section._boardGen = gen;
            try {
                const { EaselStore } = ChromeUtils.importESModule(STORE);
                const boards = await EaselStore.listEasels();
                if (section._boardGen !== gen || !section.isConnected) return;
                section._boards = boards;
            } catch (e) {
                console.error("[zen-easel] could not list easels:", e);
                if (section._boardGen !== gen) return;
                section._boards = [];
            }
            section.requestUpdate();
        },

        renderItems(section) {
            const { html, repeat } = this._lit;
            const query = (section.searchQuery || "").trim().toLowerCase();
            const boards = section._boards;
            const shown = Array.isArray(boards)
                ? boards.filter(board => !query || (board.title || "").toLowerCase().includes(query))
                : null;
            const empty = shown == null
                ? html`<div class="zen-library-empty">Loading…</div>`
                : shown.length
                    ? null
                    : html`
                        <div class="zen-library-empty easel-card-empty">
                            <div>${query ? "No easels match" : "No easels yet"}</div>
                            <div class="easel-card-empty-note">
                                ${query ? "Try a different search." : "Press Ctrl+Shift+E to start one."}
                            </div>
                        </div>
                    `;

            return html`
                <div class="easel-card-grid">
                    <button class="easel-card easel-card-new" type="button" title="New easel"
                        @click=${() => window.ZenEaselLibrarySection?.create()}></button>
                    ${shown?.length
                        ? repeat(shown, board => board.id, board => this._card(html, board))
                        : empty}
                </div>
            `;
        },

        _card(html, board) {
            const open = event => window.ZenEaselLibrarySection?.open(board, event);
            const title = board.title || "Untitled Easel";
            const short = title.length > 20 ? `${title.slice(0, 20)}…` : title;
            const count = typeof board.objectCount === "number" ? board.objectCount : 0;
            return html`
                <button class="easel-card" type="button" title=${title}
                    @click=${event => { if (event.button === 0) open(event); }}
                    @auxclick=${event => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        open(event);
                    }}
                    @contextmenu=${event => window.ZenEaselLibrarySection?.menu(board, event)}>
                    <div class="easel-card-frame">
                        <div class="easel-card-body">
                            <div class="easel-card-count">${count}</div>
                            <div class="easel-card-copy">
                                <div class="easel-card-mark">
                                    <svg class="easel-card-squiggle" viewBox="20 38 76 68" fill="none" aria-hidden="true">
                                        <path d="M 79.08 42.08 C 91.19 54.79 88.45 58.62 81.98 56.04 C 75.51 53.47 66.12 44.54 59.62 47.55 C 53.12 50.56 91.47 84.24 77.76 86.61 C 72.57 87.51 43.87 53.27 34.03 56.04 C 23.75 58.94 58.53 84.24 60.64 100.31" stroke="currentColor" stroke-width="7.1" stroke-linecap="round" stroke-linejoin="round"></path>
                                    </svg>
                                </div>
                                <div class="easel-card-title">${short}</div>
                            </div>
                        </div>
                    </div>
                </button>
            `;
        },

        open(board, event) {
            const host = window.gZenEaselHost;
            const section = document.querySelector("zen-library-easels-section");
            if (!host || !board) return;
            if (inBackground(event) && section?.library?.keepOpenWhile) {
                section.library.keepOpenWhile(() => host.openEasel(board.id, { inBackground: true }));
                return;
            }
            host.openEasel(board.id);
            section?.library?.constructor.toggle();
        },

        create() {
            let title;
            try {
                title = promptText("New easel", "Name this easel:", "Untitled Easel");
            } catch (e) {
                console.error("[zen-easel] could not ask for an easel name:", e);
                return;
            }
            if (title === null) return;
            window.gZenEaselHost?.createEasel(title.trim() || "Untitled Easel")
                .catch(e => console.error("[zen-easel] could not create easel:", e));
        },

        menu(board, event) {
            event.preventDefault();
            event.stopPropagation();
            const popup = document.createXULElement("menupopup");
            const add = (label, command) => {
                const item = document.createXULElement("menuitem");
                item.setAttribute("label", label);
                item.addEventListener("command", command, { once: true });
                popup.appendChild(item);
            };
            add("Open", () => this.open(board, null));
            add("Rename", () => this.rename(board));
            popup.appendChild(document.createXULElement("menuseparator"));
            add("Delete", () => this.remove(board));
            popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
            document.getElementById("mainPopupSet")?.appendChild(popup);
            popup.openPopupAtScreen(event.screenX, event.screenY, true);
        },

        rename(board) {
            let title;
            try {
                title = promptText("Rename easel", "New name:", board.title || "Untitled Easel");
            } catch (e) {
                console.error("[zen-easel] could not ask for an easel name:", e);
                return;
            }
            const trimmed = title?.trim();
            if (!trimmed || trimmed === board.title) return;
            window.gZenEaselHost?.renameBoard(board.id, trimmed)
                .then(() => this._reloadOpen())
                .catch(e => console.error("[zen-easel] could not rename easel:", e));
        },

        remove(board) {
            let confirmed = false;
            try {
                confirmed = Services.prompt.confirm(
                    window,
                    "Delete easel",
                    `Delete "${board.title || "Untitled Easel"}" and everything on it? This cannot be undone.`
                );
            } catch (e) {
                console.error("[zen-easel] could not confirm delete:", e);
                return;
            }
            if (!confirmed) return;
            window.gZenEaselHost?.deleteBoard(board.id)
                .then(() => this._reloadOpen())
                .catch(e => console.error("[zen-easel] could not delete easel:", e));
        },

        _reloadOpen() {
            const section = document.querySelector("zen-library-easels-section");
            if (section?.isConnected) this.load(section);
        }
    };

    window.ZenEaselLibrarySection = ZenEaselLibrarySection;
})();
