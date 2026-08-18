// Zen Easel — placing things on the board.
//
// The page half of what used to be capture.uc.js. Everything here is about turning some
// incoming payload — a capture's pixels, a dropped file, a dragged link — into an object
// on the canvas. Taking the pixels in the first place needs gBrowser and a snapshot of
// the page you are looking at, which is not something this document can see, so that
// half lives in the browser window as modules-host/capture-host.uc.js.

"use strict";

(function () {
    if (window.ZenEaselCapture) return;

    const MAX_PLACED_WIDTH = 480;

    // The image types the store will keep, mapped to the extension it files them under.
    // Anything else — svg being the one that matters — is refused at the drop rather than
    // written to disk under a name it does not match, which would leave an object on the
    // board that can never render.
    const IMAGE_TYPES = new Map([
        ["image/png", "png"],
        ["image/jpeg", "jpg"],
        ["image/webp", "webp"],
        ["image/gif", "gif"],
        ["image/avif", "avif"]
    ]);

    // The same set keyed by extension, for the file picker, which hands back a path
    // rather than a MIME type.
    const ALLOWED_EXTENSIONS = new Set([...IMAGE_TYPES.values(), "jpeg"]);

    class ZenEaselCapture {
        constructor(host) {
            this.host = host;
            this.log = window.ZenEaselUtil.log;
        }

        /* -------------------------------------------------------------- placing */

        async addCaptureToDocument(result) {
            const asset = await this.host.store.saveAsset(result.bytes, "png");
            const size = this._fitSize(result.width, result.height);
            const at = this._placementPoint(size);

            const webcard = {
                asset,
                url: window.ZenEaselObjects.safeExternalUrl(result.url) || "",
                title: result.title || "",
                favicon: result.favicon || "",
                capturedAt: Date.now()
            };

            // The geometry that makes a live web card possible. Only present for captures
            // taken since this shipped; an older card simply is not live-capable, which
            // live-layer.uc.js checks for rather than assuming.
            if (result.capture) webcard.capture = result.capture;

            const obj = window.ZenEaselObjects.createObject("webcard", {
                x: at.x, y: at.y, w: size.w, h: size.h,
                webcard
            });
            // Not selected on arrival: a transform box over a capture you have just
            // placed is in the way rather than useful.
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        // Captures come back at device resolution, which at 200% DPI would drop a
        // 2000px-wide object onto the board. Scale to something workable but keep the
        // full-resolution pixels in the file.
        _fitSize(width, height) {
            if (width <= MAX_PLACED_WIDTH) return { w: width, h: height };
            const ratio = MAX_PLACED_WIDTH / width;
            return { w: MAX_PLACED_WIDTH, h: Math.round(height * ratio) };
        }

        _placementPoint(size) {
            const canvas = this.host.canvas;
            const rect = canvas.root.getBoundingClientRect();
            const centre = canvas.toWorld(rect.width / 2, rect.height / 2);
            return { x: Math.round(centre.x - size.w / 2), y: Math.round(centre.y - size.h / 2) };
        }

        /* ---------------------------------------------------------------- drops */

        async handleDrop(e, world) {
            await this.handleTransfer(e.dataTransfer, world);
        }

        // A drop and a paste differ only in how the DataTransfer reached us, so they share
        // everything from here down. `world` may be null — a paste has no point of its own
        // to land on — in which case each branch centres its object in the view.
        //
        // Returns true if something was placed.
        async handleTransfer(dt, world = null) {
            if (!dt) return false;

            const dropped = [...(dt.files || [])];
            const files = dropped.filter(f => IMAGE_TYPES.has(f.type));
            if (files.length) {
                let offset = 0;
                for (const file of files) {
                    // Null world stays null so _placeImageBytes can centre on the object's
                    // real size; the stagger only applies when there is a point to stagger
                    // from.
                    const at = world ? { x: world.x + offset, y: world.y + offset } : null;
                    await this._addImageFile(file, at);
                    offset += 24;
                }
                return true;
            }
            // Files came over but none of them are a format the store keeps. Say so —
            // falling through to the URL and text branches would just look like the drop
            // was ignored.
            if (dropped.length) {
                this.host.toast("Only PNG, JPEG, WebP, GIF and AVIF images can be added");
                return true;
            }

            const point = world || this._placementPoint({ w: 280, h: 60 });

            const url = this._urlFromTransfer(dt);
            if (url) {
                await this._addLinkCard(url.href, url.title, point);
                return true;
            }

            const text = dt.getData("text/plain");
            if (text && text.trim()) {
                this._addTextObject(text.trim(), point);
                return true;
            }
            return false;
        }

        // Dragging a tab or a link hands over text/x-moz-url: a URL and a title on
        // separate lines. text/uri-list and text/plain are the fallbacks for drags that
        // originate outside the browser.
        //
        // All three flavours go through safeExternalUrl and yield its canonical spec.
        // Previously only the text/plain branch was filtered at all, so a crafted
        // text/x-moz-url drag could put any scheme onto the board — and what landed in
        // the document was the raw string, so the check happened once at drop time and
        // never again.
        _urlFromTransfer(dt) {
            const safe = window.ZenEaselObjects.safeExternalUrl;

            const mozUrl = dt.getData("text/x-moz-url");
            if (mozUrl) {
                const [href, title] = mozUrl.split("\n");
                const spec = safe(href);
                if (spec) return { href: spec, title: (title || "").trim() };
            }
            const uriList = dt.getData("text/uri-list");
            if (uriList) {
                const href = uriList.split("\n").find(line => line && !line.startsWith("#"));
                const spec = safe(href);
                if (spec) return { href: spec, title: "" };
            }
            const spec = safe(dt.getData("text/plain"));
            if (spec) return { href: spec, title: "" };
            return null;
        }

        async _addImageFile(file, at) {
            const bytes = new Uint8Array(await file.arrayBuffer());

            let width = 0, height = 0;
            try {
                const bitmap = await createImageBitmap(file);
                width = bitmap.width;
                height = bitmap.height;
                bitmap.close();
            } catch (err) {
                this.log("could not read image dimensions:", err.message);
            }

            return this._placeImageBytes(bytes, IMAGE_TYPES.get(file.type) || "png", at, width, height);
        }

        // Bytes to an image object on the board. Shared by the drop path, the clipboard
        // paste path and anything else that arrives with pixels rather than a file.
        //
        // `at` may be null, which centres the object in the current view the way the file
        // picker does — a paste has no drop point of its own to land on.
        async _placeImageBytes(bytes, extension, at = null, width = 0, height = 0) {
            const asset = await this.host.store.saveAsset(bytes, extension);

            if (!width || !height) {
                try {
                    const bitmap = await createImageBitmap(new Blob([bytes]));
                    width = bitmap.width;
                    height = bitmap.height;
                    bitmap.close();
                } catch (err) {
                    this.log("could not read image dimensions:", err.message);
                }
            }
            // The same fallback the drop path has always used when the decode fails: a
            // placeholder box that can be resized, rather than no object at all.
            if (!width || !height) { width = 320; height = 200; }

            const size = this._fitSize(width, height);
            const point = at || this._placementPoint(size);
            const obj = window.ZenEaselObjects.createObject("image", {
                x: Math.round(point.x), y: Math.round(point.y), w: size.w, h: size.h,
                image: { asset }
            });
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        // A dropped link with no pixels behind it becomes a link card — Arc's
        // EaselLinkView. Same object type as a capture, just without an asset.
        //
        // Arc fetches the URL and parses meta[property='og:*'] to fill this in. That is
        // deliberately not done here: it would be the only network request the mod makes,
        // from a system-principal page, which means CORS is bypassed, the user's cookies
        // ride along, and localhost/RFC1918 addresses become reachable from a string in a
        // hand-editable JSON file. The title and favicon below come from the tab the link
        // was dragged from, which the browser already knows, at no such cost.
        async _addLinkCard(href, title, at) {
            // A dropped YouTube link is a video someone wants to watch on the board, not
            // a bookmark of one. It becomes a web tile pointed at the embed player —
            // the same object a typed address produces, so there is one code path for
            // playing video and no new object type behind it.
            const embed = window.ZenEaselObjects.youtubeEmbedUrl(href);
            if (embed) return this._addVideoTile(embed, title || href, at);

            const local = this.host.bridge?.describeUrl(href) || {};
            const obj = window.ZenEaselObjects.createObject("webcard", {
                x: Math.round(at.x), y: Math.round(at.y), w: 320, h: 72,
                webcard: {
                    asset: "",
                    url: href,
                    title: title || local.title || href,
                    favicon: local.favicon || "",
                    capturedAt: Date.now()
                }
            });
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        // A webBrowser object sized to 16:9 plus the URL strip the renderer draws above
        // it. Clicking it loads the player through the ordinary live-tile path, which is
        // the only way web content can run here at all — see live-host.uc.js.
        _addVideoTile(url, title, at) {
            const width = window.ZenEaselObjects.DEFAULT_SIZE.webBrowser.w;
            const obj = window.ZenEaselObjects.createObject("webBrowser", {
                x: Math.round(at.x), y: Math.round(at.y),
                w: width,
                h: Math.round(width * 9 / 16) + 28,
                webBrowser: { url, title }
            });
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        // Writes the current text shape directly. This used to store HTML-escaped markup
        // under text.html, which the canvas renderer does not read — so a dropped block of
        // text rendered as an empty box until the easel was reloaded and sanitize()
        // migrated it. The escaping went with it: canvas text is plain, and round-tripping
        // it through pseudo-HTML only produced "&amp;" artefacts.
        _addTextObject(text, at) {
            const obj = window.ZenEaselObjects.createObject("text", {
                x: Math.round(at.x), y: Math.round(at.y), w: 280,
                color: this.host.tools.color,
                text: {
                    content: text,
                    fontSize: this.host.tools.fontSize,
                    fontFamily: this.host.tools.fontFamily || "system",
                    align: "left"
                }
            });
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        /* ------------------------------------------------------------ clipboard */

        // Pasting is a drop with no drag: the same three payloads — pixels, a link, some
        // text — arriving through the system clipboard instead of a DataTransfer. So this
        // reads the clipboard, works out which of them it is holding, and hands off to the
        // same three placement methods handleDrop uses. Nothing about the resulting object
        // differs by how it got here.
        //
        // Reading is done with nsITransferable rather than navigator.clipboard: this is a
        // system-principal chrome document, the async Clipboard API's permission model does
        // not apply to it, and the flavours that matter here — an imgIContainer for pixels,
        // an nsIFile for a file copied in the file manager — have no Web API equivalent.
        //
        // `at` may be null, in which case each branch centres its object in the view.
        //
        // Returns true if something was placed, so the caller can fall back.
        async handlePaste(at = null) {
            // Pixels first. This is the case the whole feature exists for: copy an image in
            // a web page, paste it onto the board.
            const image = this._clipboardImage();
            if (image) {
                await this._placeImageBytes(image.bytes, "png", at, image.width, image.height);
                return true;
            }

            // A file copied in Explorer or Finder. Routed through _addImageFile so it gets
            // the same IMAGE_TYPES gate as a dropped file — the store will not keep an SVG,
            // and writing one under a .png name would leave an object that never renders.
            const file = await this._clipboardFile();
            if (file) {
                if (!IMAGE_TYPES.has(file.type)) {
                    this.host.toast("Only PNG, JPEG, WebP, GIF and AVIF images can be added");
                    return true;   // handled: saying no is a result, not a fall-through
                }
                // `at` passed through even when null: _placeImageBytes centres on the
                // object's real size, which a guessed placement point here could not.
                await this._addImageFile(file, at);
                return true;
            }

            const text = this._clipboardText();
            if (!text) {
                // Said out loud, and not behind the debug pref. A paste that places nothing
                // is indistinguishable from a paste that never ran, and the difference is
                // the first thing anyone needs to know.
                console.error(
                    "[zen-easel] nothing pasteable on the clipboard. Flavours present:",
                    ["image/png", "image/jpeg", "application/x-moz-file", "text/plain"]
                        .filter(f => this._clipboardHas([f])).join(", ") || "(none)"
                );
                return false;
            }

            const point = at || this._placementPoint({ w: 280, h: 60 });

            // A copied URL becomes a link card, exactly as a dragged one does — including
            // the YouTube-to-web-tile path inside _addLinkCard. safeExternalUrl is what
            // keeps a javascript: or file: string on the clipboard from becoming a card
            // that would later be opened.
            const href = window.ZenEaselObjects.safeExternalUrl(text);
            if (href) {
                await this._addLinkCard(href, "", point);
                return true;
            }

            this._addTextObject(text, point);
            return true;
        }

        // True if the clipboard holds anything this module could place. Synchronous,
        // because the context menu has to decide whether to grey "Paste here" out while it
        // is being built.
        canPaste() {
            return this._clipboardHas([
                "image/png", "image/jpeg", "application/x-moz-file", "text/plain"
            ]);
        }

        // Both public, for the canvas's internal-versus-system decision on the paths that
        // have no paste event to read — "Paste here", and the keystroke fallback.
        hasClipboardBinary() {
            return this._clipboardHas(["image/png", "image/jpeg", "application/x-moz-file"]);
        }

        clipboardText() {
            return this._clipboardText();
        }

        _clipboardHas(flavors) {
            try {
                return Services.clipboard.hasDataMatchingFlavors(
                    flavors, Ci.nsIClipboard.kGlobalClipboard
                );
            } catch (e) {
                return false;
            }
        }

        // Returns data.value for a flavour, or null. Every caller is wrapped because
        // getTransferData throws rather than returning empty when the flavour is absent.
        _clipboardValue(flavor) {
            try {
                const transferable = Cc["@mozilla.org/widget/transferable;1"]
                    .createInstance(Ci.nsITransferable);
                // A null load context. The easel is never a private-browsing document, and
                // passing null is what Firefox's own chrome callers do.
                transferable.init(null);
                transferable.addDataFlavor(flavor);
                Services.clipboard.getData(transferable, Ci.nsIClipboard.kGlobalClipboard);

                const data = {};
                transferable.getTransferData(flavor, data);
                return data.value || null;
            } catch (e) {
                return null;
            }
        }

        // Pixels off the clipboard, as PNG bytes plus the dimensions.
        //
        // The clipboard carries an imgIContainer — a decoded image, not a file — so it has
        // to be re-encoded before it can be stored. imgITools.encodeImage is the same
        // service devtools uses to put a screenshot *on* the clipboard, run in reverse.
        // The container also knows its own size, which saves decoding the bytes again just
        // to measure them.
        _clipboardImage() {
            if (!this._clipboardHas(["image/png", "image/jpeg"])) return null;

            for (const flavor of ["image/png", "image/jpeg"]) {
                let value = this._clipboardValue(flavor);
                if (!value) continue;

                try {
                    // Some sources hand back the container wrapped in an interface pointer.
                    if (value instanceof Ci.nsISupportsInterfacePointer) value = value.data;
                    const container = value.QueryInterface(Ci.imgIContainer);

                    const tools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
                    const stream = tools.encodeImage(container, "image/png");

                    const binary = Cc["@mozilla.org/binaryinputstream;1"]
                        .createInstance(Ci.nsIBinaryInputStream);
                    binary.setInputStream(stream);
                    const bytes = new Uint8Array(binary.readByteArray(stream.available()));
                    binary.close();

                    if (!bytes.length) continue;
                    return { bytes, width: container.width || 0, height: container.height || 0 };
                } catch (e) {
                    // console.error, not log(). This was behind the debug pref, which meant
                    // a clipboard the user could see was there produced "nothing pasteable"
                    // and no reason anywhere. A failure to read a flavour we just confirmed
                    // is present is never uninteresting.
                    console.error(`[zen-easel] could not decode ${flavor} from the clipboard:`, e);
                }
            }
            return null;
        }

        // A file copied in the file manager, as a DOM File. Returns null when the clipboard
        // holds no file, or when the entry is a directory or has gone away since the copy.
        async _clipboardFile() {
            if (!this._clipboardHas(["application/x-moz-file"])) return null;

            let value = this._clipboardValue("application/x-moz-file");
            if (!value) return null;

            try {
                if (value instanceof Ci.nsISupportsInterfacePointer) value = value.data;
                const nsFile = value.QueryInterface(Ci.nsIFile);
                if (!nsFile.exists() || nsFile.isDirectory()) return null;
                return await File.createFromNsIFile(nsFile);
            } catch (e) {
                this.log("could not read a file from the clipboard:", e.message);
                return null;
            }
        }

        _clipboardText() {
            if (!this._clipboardHas(["text/plain"])) return null;
            const value = this._clipboardValue("text/plain");
            if (!value) return null;
            try {
                const text = value.QueryInterface(Ci.nsISupportsString).data;
                return text && text.trim() ? text.trim() : null;
            } catch (e) {
                return null;
            }
        }

        /* ---------------------------------------------------------- file picker */

        // `at` is optional: the toolbar button opens the picker with nothing aimed, so
        // the image lands centred in the view the same way a capture does.
        async pickImageFile(at = null) {
            const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
            picker.init(window.browsingContext, "Add an image to this easel", Ci.nsIFilePicker.modeOpen);
            picker.appendFilters(Ci.nsIFilePicker.filterImages);

            const result = await new Promise(resolve => picker.open(resolve));
            if (result !== Ci.nsIFilePicker.returnOK || !picker.file) return null;

            const path = picker.file.path;
            // filterImages includes svg, which the store will not keep. Refusing here is
            // better than saving bytes under a .png name that will never decode.
            const extension = (path.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            if (!ALLOWED_EXTENSIONS.has(extension)) {
                throw new Error(`${extension || "That file type"} images are not supported`);
            }

            const bytes = await IOUtils.read(path);
            const asset = await this.host.store.saveAsset(bytes, extension);

            let width = 320, height = 200;
            try {
                const bitmap = await createImageBitmap(new Blob([bytes]));
                width = bitmap.width;
                height = bitmap.height;
                bitmap.close();
            } catch (err) {
                this.log("could not read image dimensions:", err.message);
            }

            const size = this._fitSize(width, height);
            const point = at || this._placementPoint(size);
            const obj = window.ZenEaselObjects.createObject("image", {
                x: Math.round(point.x), y: Math.round(point.y), w: size.w, h: size.h,
                image: { asset }
            });
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        /* ----------------------------------------------------------- navigation */

        // Opening a page is the browser window's job. The scheme check runs on both sides
        // of the bridge: here because the object may have been mutated in memory since it
        // was loaded, and there because the host must not trust a caller.
        openWebcard(obj) {
            const url = window.ZenEaselObjects.safeExternalUrl(obj.webcard && obj.webcard.url);
            if (!url) return;
            const bridge = this.host.bridge;
            if (bridge) bridge.openUrl(url);
        }

        destroy() { }
    }

    window.ZenEaselCapture = ZenEaselCapture;
})();
