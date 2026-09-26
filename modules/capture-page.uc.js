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

    const { assetKind, isSafeAssetName, safeLocalPath } =
        ChromeUtils.importESModule("chrome://sine/content/zen-easel/background/validate.sys.mjs");

    // MIME type → the extension the store files it under. A dropped File reports a type,
    // and this is the first thing consulted; the filename suffix is the fallback, because
    // Windows reports no type at all for .flac, .opus, .m4v and a few others, and a file
    // with no type is still a file someone meant to add.
    const MIME_TO_EXT = new Map([
        ["image/png", "png"],
        ["image/jpeg", "jpg"],
        ["image/webp", "webp"],
        ["image/gif", "gif"],
        ["image/avif", "avif"],
        ["image/svg+xml", "svg"],
        ["image/bmp", "bmp"],
        ["image/x-icon", "ico"],
        ["image/vnd.microsoft.icon", "ico"],
        ["video/mp4", "mp4"],
        ["video/quicktime", "mov"],
        ["video/x-matroska", "mkv"],
        ["video/x-m4v", "m4v"],
        ["video/webm", "webm"],
        ["video/ogg", "ogv"],
        ["audio/mpeg", "mp3"],
        ["audio/mp3", "mp3"],
        ["audio/wav", "wav"],
        ["audio/x-wav", "wav"],
        ["audio/wave", "wav"],
        ["audio/ogg", "ogg"],
        ["audio/opus", "opus"],
        ["audio/flac", "flac"],
        ["audio/x-flac", "flac"],
        ["audio/mp4", "m4a"],
        ["audio/x-m4a", "m4a"],
        ["audio/aac", "aac"],
        ["audio/webm", "weba"],
        ["application/pdf", "pdf"]
    ]);

    // The extension a file's own name gives, when it is one the store can file under.
    const NAME_EXTENSION_RE = /^[a-z0-9]{1,16}$/;

    // Ceilings on what one drop may bring in.
    //
    // An SVG is parsed and re-serialised synchronously on this thread, so a large one is a
    // hang rather than a large object; nothing hand-drawn comes near this. Video and audio
    // are copied on disk without being read, so their ceiling is about the profile
    // directory — usually the system drive — not about memory; a file that big is a
    // mistake to refuse rather than honour. The inline ceiling is for the rare File with
    // no path behind it, which has to be read into memory and then written: it exists
    // twice in this window for the length of the write, hence the much lower number.
    // Any other file is attached (copied) up to MAX_ATTACH_BYTES and linked by its path
    // beyond that, so a board does not quietly become a second copy of a large archive.
    const MAX_SVG_BYTES = 4 * 1024 * 1024;
    const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
    const MAX_INLINE_BYTES = 64 * 1024 * 1024;
    const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

    // A probe rejection, told apart so only "this video will not decode" falls back to a file card.
    class UndecodableVideo extends Error { }
    // A video container that decodes but has no picture — a WebM or MP4 of a song.
    class AudioOnlyVideo extends Error { }

    // The audio extension an audio-only video container is filed under, since an asset's kind is read from its extension.
    const AUDIO_FOR_VIDEO = { webm: "weba", mp4: "m4a", m4v: "m4a", mov: "m4a", ogv: "ogg" };

    const SVG_NS = "http://www.w3.org/2000/svg";

    // Whether an SVG length is one the engine will read as an intrinsic size. Percentages
    // and anything unparsable count as absent — width="100%" is common in exported files,
    // and an <img> with it has naturalWidth 0, which the renderer treats as "still loading"
    // for ever. Returns the number of user units, or 0.
    const ABSOLUTE_LENGTH = /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|mm|cm|in)?\s*$/i;
    const UNIT_PX = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
    const absoluteLength = value => {
        const match = ABSOLUTE_LENGTH.exec(String(value || ""));
        if (!match) return 0;
        const n = parseFloat(match[1]) * (UNIT_PX[(match[2] || "px").toLowerCase()] || 1);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };

    class ZenEaselCapture {
        constructor(host) {
            this.host = host;
            this.log = window.ZenEaselUtil.log;
        }

        /* -------------------------------------------------------------- placing */

        async addCaptureToDocument(result) {
            const docId = this._currentDocId();
            const asset = await this.host.store.saveAsset(result.bytes, "png", docId);
            const size = this._fitSize(result.width, result.height);
            const at = this._placementPoint(size);

            const webcard = {
                asset,
                url: window.ZenEaselObjects.safeExternalUrl(result.url) || "",
                title: result.title || "",
                favicon: result.favicon || "",
                capturedAt: Date.now(),
                // The container the shot was taken in, so the live view reproduces the same
                // session rather than the default one. Zero means the default container and
                // is also what an older card reports by not having this at all.
                userContextId: Number.isInteger(result.userContextId) && result.userContextId > 0
                    ? result.userContextId : 0
            };

            // The geometry that makes a live web card possible. Only present for captures
            // taken since this shipped; an older card simply is not live-capable, which
            // live-layer.uc.js checks for rather than assuming.
            //
            // Its absence is worth a line in the console. A card with no geometry looks
            // identical to one with it until you right-click and find no "Show live
            // website", and the reason is on the window's side of the bridge, where nothing
            // on this side would ever see it.
            if (result.capture) webcard.capture = result.capture;
            else this.log("this capture carries no viewport geometry, so the card it makes " +
                "cannot be shown live \u2014 see the warning from the browser window for why");

            const obj = window.ZenEaselObjects.createObject("webcard", {
                x: at.x, y: at.y, w: size.w, h: size.h,
                webcard
            });
            if (!this._stillOn(docId, "The capture", "taken")) return null;
            // Not selected on arrival: a transform box over a capture you have just
            // placed is in the way rather than useful.
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        _currentDocId() {
            const id = this.host.store && this.host.store.current && this.host.store.current.id;
            if (!id) throw new Error("no easel open");
            return id;
        }

        // Whether the board an ingest started on is still the one open. Its file was filed
        // under that board, so an object placed on any other would name a file that is not
        // there; it is dropped instead, and the file is left to that board's next sweep.
        _stillOn(docId, name, verb = "copied") {
            const current = this.host.store && this.host.store.current;
            if (current && current.id === docId) return true;
            this.host.toast(`${name} was ${verb} while you switched boards and was not placed`);
            return false;
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

            // Every File is taken — _extensionFor falls back to bin — and _addFile toasts
            // each one it refuses, so a drop of files never falls through to the URL and
            // text branches below.
            const files = [...(dt.files || [])];
            if (files.length) {
                let offset = 0;
                for (const file of files) {
                    // Null world stays null so each placer can centre on the object's
                    // real size; the stagger only applies when there is a point to stagger
                    // from.
                    const at = world ? { x: world.x + offset, y: world.y + offset } : null;
                    await this._addFile(file, at);
                    offset += 24;
                }
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

        /* ---------------------------------------------------------------- files */

        // The extension a File will be stored under: MIME first, filename second — see
        // MIME_TO_EXT for why both — and bin for a name with none the store can use (no
        // extension, c++, non-ASCII, too long); the card keeps the real name as its title.
        // Null only when there is no File.
        _extensionFor(file) {
            if (!file) return null;
            const byType = MIME_TO_EXT.get(String(file.type || "").toLowerCase());
            if (byType) return byType;
            const name = String(file.name || "");
            const dot = name.lastIndexOf(".");
            const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
            return NAME_EXTENSION_RE.test(ext) ? ext : "bin";
        }

        // One entry for every File, however it arrived — dropped, pasted from the file
        // manager, or picked. Which placer it goes to is decided by the kind the store will
        // file it under, so the same file makes the same object by every route.
        //
        // Every refusal is a toast. A drop is silent on failure by default (the canvas only
        // logs), and a drop that places nothing is indistinguishable from one that never
        // happened.
        //
        // The board is fixed here, before the first await: every file this writes is filed
        // under it, and nothing is placed if another board is open by the time it lands.
        async _addFile(file, at = null) {
            const extension = this._extensionFor(file);
            if (!extension) {
                this.host.toast("Could not add that file");
                return null;
            }
            try {
                const docId = this._currentDocId();
                switch (assetKind(`x.${extension}`)) {
                    case "image":
                        return extension === "svg"
                            ? await this._addSvgFile(file, at, docId)
                            : await this._addImageFile(file, extension, at, docId);
                    case "video": {
                        // Probed before anything is written. A video Firefox cannot decode
                        // (AVI never, HEVC often) becomes a file card rather than a refusal.
                        let frame;
                        try {
                            frame = await this._probeVideo(file, window.ZenEaselStore.mimeFor(`x.${extension}`));
                        } catch (err) {
                            // No picture: an audio card, filed under the matching audio
                            // extension. Not when it would be linked — a link keeps the
                            // original's video extension — so over the attach limit it
                            // stays a file card.
                            if (err instanceof AudioOnlyVideo) {
                                const audioExtension = AUDIO_FOR_VIDEO[extension];
                                if (audioExtension && !this._wouldLink(file)) {
                                    return await this._importFile(file, audioExtension, at, docId, null);
                                }
                            } else if (!(err instanceof UndecodableVideo)) {
                                throw err;
                            }
                            this.log("not playable here, adding as a file:", file.name);
                            return await this._addFileCard(file, extension, at, docId);
                        }
                        return await this._importFile(file, extension, at, docId,
                            this._fitSize(frame.width, frame.height));
                    }
                    case "audio":
                        return await this._importFile(file, extension, at, docId, null);
                    default:
                        return await this._addFileCard(file, extension, at, docId);
                }
            } catch (err) {
                console.error("[zen-easel] could not add", file.name, err);
                this.host.toast(err && err.message ? err.message : `Could not add ${file.name}`);
            }
            return null;
        }

        async _addImageFile(file, extension, at, docId) {
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

            return this._placeImageBytes(bytes, extension, at, width, height, docId, file.name);
        }

        // An SVG is an image object like any other once it is on the board — the renderer
        // draws it through the same <img>, where scripts never run and nothing external
        // loads. What is different is the way in: the file is a document, so it is parsed,
        // stripped of everything an image does not need, given a size the engine will read
        // as intrinsic, and re-serialised. The stored file is inert whatever loads it.
        async _addSvgFile(file, at, docId) {
            if (file.size > MAX_SVG_BYTES) {
                throw new Error("That SVG is too large to add (limit 4 MB)");
            }
            const text = await file.text();
            const clean = this._sanitizeSvg(text);
            if (!clean) throw new Error(`${file.name} is not a usable SVG`);

            const bytes = new TextEncoder().encode(clean.markup);
            const asset = await this.host.store.saveAsset(bytes, "svg", docId);
            if (!this._stillOn(docId, file.name)) return null;
            const size = this._fitSize(clean.width, clean.height);
            const point = at || this._placementPoint(size);
            const obj = window.ZenEaselObjects.createObject("image", {
                x: Math.round(point.x), y: Math.round(point.y), w: size.w, h: size.h,
                image: { asset }
            });
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        // Returns { markup, width, height } or null. None of what is removed here can act
        // through an <img>; this is the cheap half of defence in depth, so that the file
        // on disk is safe even in a context that is not an <img>.
        _sanitizeSvg(text) {
            let doc;
            try {
                doc = new DOMParser().parseFromString(text, "image/svg+xml");
            } catch (e) {
                return null;
            }
            const root = doc.documentElement;
            if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NS) return null;
            if (doc.getElementsByTagName("parsererror").length) return null;

            // The DOCTYPE carries internal entities (the one way an SVG can be a
            // decompression bomb) and a processing instruction can name a stylesheet.
            // Neither is part of the picture.
            for (const node of [...doc.childNodes]) {
                if (node.nodeType === Node.DOCUMENT_TYPE_NODE ||
                    node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) node.remove();
            }

            const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            const drop = [];
            for (let el = root; el; el = walker.nextNode()) {
                const name = el.localName.toLowerCase();
                if (name === "script" || name === "foreignobject") {
                    drop.push(el);
                    continue;
                }
                for (const attr of [...el.attributes]) {
                    const attrName = attr.localName.toLowerCase();
                    if (attrName.startsWith("on")) {
                        el.removeAttributeNode(attr);
                        continue;
                    }
                    // References: a fragment of this document or inline image data
                    // stay; a URL to anywhere else goes, whatever the element.
                    if (attrName === "href") {
                        const value = attr.value.trim();
                        if (!value.startsWith("#") && !/^data:image\//i.test(value)) {
                            el.removeAttributeNode(attr);
                        }
                    }
                }
                if (name === "style") {
                    el.textContent = (el.textContent || "")
                        .replace(/@import[^;]*;?/gi, "")
                        .replace(/url\(\s*(?!["']?#)[^)]*\)/gi, "none");
                }
            }
            for (const el of drop) el.remove();

            // Intrinsic size. Absolute width/height on the root, else the viewBox, else
            // the placeholder — and written back either way, so both <img> and drawImage
            // have a number to work from.
            let width = absoluteLength(root.getAttribute("width"));
            let height = absoluteLength(root.getAttribute("height"));
            if (!width || !height) {
                const box = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(parseFloat);
                if (box.length === 4 && box[2] > 0 && box[3] > 0) {
                    width = box[2];
                    height = box[3];
                } else {
                    width = 320;
                    height = 200;
                }
            }
            root.setAttribute("width", String(width));
            root.setAttribute("height", String(height));

            return {
                markup: new XMLSerializer().serializeToString(doc),
                width: Math.round(width),
                height: Math.round(height)
            };
        }

        // Video and audio, played on the board. Up to MAX_ATTACH_BYTES — or from the temp
        // directory, up to the media ceiling — they are copied on disk, never read; a File
        // the OS handed over has a path behind it, and one built in memory by a web page is
        // read and written under the low inline ceiling instead. Beyond that they are linked:
        // the object plays the original in place and nothing is copied. `size` is a probed
        // video's fitted frame, null for audio.
        async _importFile(file, extension, at, docId, size) {
            const title = String(file.name || "");
            const path = this._pathOf(file);
            let media;
            if (this._wouldLink(file)) {
                const linked = safeLocalPath(path);
                if (!linked) throw new Error(`${title} can't be linked from that location`);
                media = { path: linked, title, size: file.size };
            } else {
                if (file.size > MAX_ASSET_BYTES) {
                    throw new Error(`${title} is too large to add (limit 2 GB)`);
                }
                media = { asset: await this._copyIn(file, extension, docId, MAX_INLINE_BYTES), title };
            }
            if (!this._stillOn(docId, title)) return null;

            const Objects = window.ZenEaselObjects;
            const box = size || Objects.DEFAULT_SIZE.media;
            const point = at || this._placementPoint(box);
            const obj = Objects.createObject("media", {
                x: Math.round(point.x), y: Math.round(point.y), w: box.w, h: box.h,
                media
            });
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        // A File into the board's assets: copied from its path when it has one, read inline
        // under `inlineLimit` when it does not.
        async _copyIn(file, extension, docId, inlineLimit) {
            const path = this._pathOf(file);
            if (path) return this.host.store.importAsset(path, extension, docId);
            if (file.size > inlineLimit) {
                const mb = Math.round(inlineLimit / (1024 * 1024));
                throw new Error(`${file.name} is too large to add this way (limit ${mb} MB)`);
            }
            return this.host.store.saveAsset(new Uint8Array(await file.arrayBuffer()), extension, docId);
        }

        _pathOf(file) {
            try { return file.mozFullPath || ""; } catch (e) { return ""; }
        }

        // Whether _importFile would link this video or audio file rather than copy it.
        _wouldLink(file) {
            const path = this._pathOf(file);
            return !!path && file.size > MAX_ATTACH_BYTES && !this._isTempPath(path);
        }

        // Whether a path is inside the OS temp directory, where a file dragged out of a zip
        // or a mail client lives until something cleans it up — a poor thing to link to.
        // The separator boundary keeps a sibling such as Temp2 out.
        _isTempPath(path) {
            let temp = "";
            try { temp = Services.dirsvc.get("TmpD", Ci.nsIFile).path; } catch (e) { return false; }
            if (!temp) return false;
            const windows = Services.appinfo.OS === "WINNT";
            const sep = windows ? "\\" : "/";
            const prefix = temp.endsWith(sep) ? temp : temp + sep;
            return windows
                ? path.toLowerCase().startsWith(prefix.toLowerCase())
                : path.startsWith(prefix);
        }

        // Any file that is not an image, a playable video or audio: a card that opens it
        // outside the board. Up to MAX_ATTACH_BYTES it is attached — copied into the board —
        // and beyond that linked by its path, unless that path is a temp file, which is
        // attached up to the media ceiling because a link to it would break almost at once.
        async _addFileCard(file, extension, at, docId) {
            const title = String(file.name || "");
            const path = this._pathOf(file);
            let size = file.size;
            if (path) {
                // A dropped folder has a path and usually reports size 0; said here, with
                // importAsset's own check as the backstop.
                const stat = await IOUtils.stat(path);
                if (stat.type !== "regular") throw new Error("Folders can't be added");
                size = stat.size;
            }

            let record;
            const temp = !!path && this._isTempPath(path);
            if (size <= MAX_ATTACH_BYTES || (temp && size <= MAX_ASSET_BYTES)) {
                const asset = await this._copyIn(file, extension, docId, MAX_ATTACH_BYTES);
                record = { asset, title };
            } else if (temp) {
                throw new Error(`${title} is too large to add (limit 2 GB)`);
            } else {
                if (!path) throw new Error(`${title} is over 25 MB and has no file on disk to link to`);
                const linked = safeLocalPath(path);
                if (!linked) throw new Error(`${title} can't be linked from that location`);
                record = { path: linked, title, size };
            }
            if (!this._stillOn(docId, title)) return null;

            const Objects = window.ZenEaselObjects;
            const point = at || this._placementPoint(Objects.DEFAULT_SIZE.file);
            const obj = Objects.createObject("file", {
                x: Math.round(point.x), y: Math.round(point.y),
                file: record
            });
            this.host.canvas.addObjects([obj], { select: false });
            return obj;
        }

        // A video's frame size, from a throwaway element on an object URL of the File.
        // The File is disk-backed so nothing is read but the header. Rejects on error: a
        // corrupt or unsupported file never fires loadedmetadata, and a promise waiting
        // for it would hang the drop for ever. The element is released properly before
        // the URL is revoked, or it keeps a decoder and a file handle after answering.
        //
        // Probed as a slice carrying the store's type rather than the OS's — still disk-backed
        // — so the verdict matches how the asset will be served. Rejects with UndecodableVideo,
        // which the caller turns into a file card, or AudioOnlyVideo when the file decodes
        // but has no picture, which it turns into an audio card where it can.
        _probeVideo(file, type) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(type ? file.slice(0, file.size, type) : file);
                const video = document.createElement("video");
                video.preload = "metadata";
                video.muted = true;
                const done = (fn, value) => {
                    video.onloadedmetadata = video.onerror = null;
                    try { video.pause(); video.removeAttribute("src"); video.load(); } catch (e) { }
                    URL.revokeObjectURL(url);
                    fn(value);
                };
                video.onloadedmetadata = () => {
                    const width = video.videoWidth, height = video.videoHeight;
                    if (width > 0 && height > 0) done(resolve, { width, height });
                    else done(reject, new AudioOnlyVideo(`${file.name} has no video track`));
                };
                video.onerror = () => done(reject, new UndecodableVideo(`${file.name} cannot be played here`));
                video.src = url;
            });
        }

        // Bytes to an image object on the board. Shared by the drop path, the clipboard
        // paste path and anything else that arrives with pixels rather than a file.
        //
        // `at` may be null, which centres the object in the current view the way the file
        // picker does — a paste has no drop point of its own to land on.
        //
        // `docId` is the board the ingest started on (see _addFile), and `name` is what the
        // toast calls the image if that board is no longer open when its file lands.
        async _placeImageBytes(bytes, extension, at = null, width = 0, height = 0,
            docId = this._currentDocId(), name = "The pasted image") {
            const asset = await this.host.store.saveAsset(bytes, extension, docId);

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
            if (!this._stillOn(docId, name)) return null;

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

        // A webBrowser object sized to 16:9, and to nothing more. It used to carry another
        // 28 units for the URL strip the renderer drew across the top, back when the tile
        // was inset below it; that strip is a floating bar now and the tile is the whole
        // object, so the same arithmetic leaves the player letterboxed by 28 units of dead
        // panel. Clicking it loads the player through the ordinary live-tile path, which is
        // the only way web content can run here at all — see live-host.uc.js.
        _addVideoTile(url, title, at) {
            const width = window.ZenEaselObjects.DEFAULT_SIZE.webBrowser.w;
            const obj = window.ZenEaselObjects.createObject("webBrowser", {
                x: Math.round(at.x), y: Math.round(at.y),
                w: width,
                h: Math.round(width * 9 / 16),
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
            const canvas = this.host.canvas;
            const obj = window.ZenEaselObjects.createObject("text", {
                x: Math.round(at.x), y: Math.round(at.y), w: canvas.constructor.TEXT_BOX_WIDTH,
                color: this.host.tools.color,
                text: {
                    content: text,
                    fontSize: this.host.tools.fontSize,
                    fontFamily: this.host.tools.fontFamily || "system",
                    align: "left",
                    markdown: !!this.host.tools.markdown
                }
            });
            // Sized to its content now, not on first edit: the model default is one line.
            obj.h = canvas.renderer.measureTextHeight(obj);
            canvas.addObjects([obj], { select: false });
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

            // A file copied in Explorer or Finder. Routed through _addFile so it gets the
            // same gate, the same placers and the same refusal as a dropped file. `at`
            // passed through even when null: each placer centres on the object's real
            // size, which a guessed placement point here could not.
            const file = await this._clipboardFile();
            if (file) {
                await this._addFile(file, at);
                return true;   // handled either way: saying no is a result, not a fall-through
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
        // the file lands centred in the view the same way a capture does.
        //
        // The picked nsIFile becomes a DOM File and goes through _addFile like a drop —
        // the same gate, the same placers, and for a video no read of the file at all.
        async pickFile(at = null) {
            const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
            picker.init(window.browsingContext, "Add a file to this easel", Ci.nsIFilePicker.modeOpen);
            const glob = exts => exts.map(e => `*.${e}`).join(";");
            const images = ["png", "jpg", "jpeg", "webp", "gif", "avif", "svg", "bmp", "ico"];
            // Wider than what plays: one that does not decode lands as a file card.
            const video = ["mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp"];
            const audio = ["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "weba"];
            picker.appendFilters(Ci.nsIFilePicker.filterAll);
            picker.appendFilter("Images", glob(images));
            picker.appendFilter("Video", glob(video));
            picker.appendFilter("Audio", glob(audio));
            picker.appendFilter("PDF documents", "*.pdf");
            picker.filterIndex = 0;

            const result = await new Promise(resolve => picker.open(resolve));
            if (result !== Ci.nsIFilePicker.returnOK || !picker.file) return null;

            const file = await File.createFromNsIFile(picker.file);
            return this._addFile(file, at);
        }

        // Opens a file card outside the board: a PDF in Glance, anything else in its default
        // app. An attached card hands the host two names — the easel id and the asset name —
        // which it rebuilds into a path through the store's validators; a linked card hands
        // over its path, which both sides hold to safeLocalPath. A reason that comes back
        // (the file is gone, the launch was declined) is toasted.
        async openFile(obj, origin) {
            const doc = this.host.store && this.host.store.current;
            if (!obj || obj.type !== "file" || !obj.file || !doc) return;
            const bridge = this.host.bridge;
            if (!bridge) return;
            let reason = null;
            try {
                if (obj.file.path) {
                    const path = safeLocalPath(obj.file.path);
                    if (!path || typeof bridge.openLinkedFile !== "function") return;
                    reason = await bridge.openLinkedFile(path, origin);
                } else {
                    if (!isSafeAssetName(obj.file.asset) || typeof bridge.openAsset !== "function") return;
                    reason = await bridge.openAsset(doc.id, obj.file.asset, origin);
                }
            } catch (e) {
                console.error("[zen-easel] could not open the file:", e);
                reason = `Could not open ${obj.file.title || "the file"}`;
            }
            if (typeof reason === "string" && reason) this.host.toast(reason);
        }

        // A linked card's or media object's original, shown in its folder by the OS file manager.
        async revealFile(obj) {
            const path = safeLocalPath(window.ZenEaselObjects.linkedPath(obj));
            const bridge = this.host.bridge;
            if (!path || !bridge || typeof bridge.revealLinkedFile !== "function") return;
            let reason = null;
            try {
                reason = await bridge.revealLinkedFile(path);
            } catch (e) {
                console.error("[zen-easel] could not show the file:", e);
                reason = `Could not show ${(obj.file || obj.media).title || "the file"}`;
            }
            if (typeof reason === "string" && reason) this.host.toast(reason);
        }

        /* ----------------------------------------------------------- navigation */

        // Opening a page is the browser window's job. The scheme check runs on both sides
        // of the bridge: here because the object may have been mutated in memory since it
        // was loaded, and there because the host must not trust a caller.
        //
        // Both web types, because both now carry an open-link button in their floating bar
        // and a web tile's URL is as much a source page as a capture's is.
        openWebcard(obj) {
            if (!obj) return;
            const raw = obj.type === "webBrowser"
                ? obj.webBrowser && obj.webBrowser.url
                : obj.webcard && obj.webcard.url;
            const url = window.ZenEaselObjects.safeExternalUrl(raw);
            if (!url) return;
            const bridge = this.host.bridge;
            if (bridge) bridge.openUrl(url);
        }

        destroy() { }
    }

    window.ZenEaselCapture = ZenEaselCapture;
})();
