// Zen Easel — the validation boundary.
//
// One definition, imported by everything that needs it: the page's object sanitizer,
// the page-side store client, and the background store that actually touches the disk.
// These rules decide what a document is allowed to make the browser do, so two copies
// drifting apart is precisely the failure this file exists to prevent.

// Ids and asset names arrive from a JSON file that can be hand-edited, copied between
// profiles, or restored from a backup — they are not trusted just because this code
// wrote them last time. Both are joined into filesystem paths, so the only property
// that matters is that they cannot escape their directory.
//
// Deliberately not a UUID pattern: id generation falls back to "id-<base36>-<base36>"
// when crypto.randomUUID is unavailable, and a strict UUID regex would reject every
// asset written on that path.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Four kinds of asset, decided by the extension the store files it under. Which kind a
// name is decides how it may be used — an <img>, a <video>/<audio>, or a card that is
// opened outside the board — and assetKind() below is the only reader of these sets.
// Since 0.7.0 any extension is storable: whatever is not an image, video or audio is a
// "file", which the page never loads and only the host opens.
//
// gif and avif are in the image set because earlier versions accepted any image/* drop
// and wrote it under its own extension — omitting them would make every such object
// vanish on the next load. svg is accepted since 0.6.0 on two conditions that the page
// side enforces: it is sanitised on ingest (scripts, event handlers, foreignObject and
// external references stripped, an absolute size written on the root), and it is only
// ever loaded as an image, where a script could not run anyway.
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "svg", "bmp", "ico"]);
// mov and mkv are listed because Firefox often decodes them; ingest probes every video, so one that does not decode never becomes a media object.
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv", "mov", "mkv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "weba"]);

const EXTENSION_RE = /^[a-z0-9]{1,16}$/;

const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.[a-z0-9]{1,16}$/i;

// A Windows device name opens the device whatever extension follows it, so nul.txt is not a file.
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

const MAX_URL_LENGTH = 4096;
const MAX_PATH_LENGTH = 4096;

export function isSafeId(id) {
    return typeof id === "string" && ID_RE.test(id);
}

export function isSafeAssetName(name) {
    return typeof name === "string" && ASSET_NAME_RE.test(name) && !name.includes("..") &&
        !DEVICE_NAME_RE.test(name);
}

// Which of the four kinds an asset name is, or null. Every place that decides what an
// asset may be used as — the object sanitizer, the renderer, the media layer, the host
// opening a file — asks this rather than reading the extension itself, so a name that
// passes isSafeAssetName can still be refused where it does not belong: an image object
// naming a video, a card's screenshot naming a PDF.
export function assetKind(name) {
    if (!isSafeAssetName(name)) return null;
    return extensionKind(name.slice(name.lastIndexOf(".") + 1));
}

// The same decision for a linked file's path, which is not an asset name: null unless the
// path passes safeLocalPath and its file name has an extension.
export function linkedKind(path) {
    const safe = safeLocalPath(path);
    if (!safe) return null;
    const leaf = safe.slice(Math.max(safe.lastIndexOf("\\"), safe.lastIndexOf("/")) + 1);
    const dot = leaf.lastIndexOf(".");
    return dot > 0 ? extensionKind(leaf.slice(dot + 1)) : null;
}

function extensionKind(extension) {
    const ext = String(extension).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
    if (AUDIO_EXTENSIONS.has(ext)) return "audio";
    return "file";
}

// A linked file card's path, normalised, or null. The one stored filesystem path on a
// board, and it comes from a hand-editable file that a click will hand to the OS — so
// this is an allow-list of plain local paths rather than a list of bad prefixes. On
// Windows: a drive letter, no UNC or device namespace (Windows reads / as \, so /\host
// is UNC too), no second colon (an alternate data stream), and no segment ending in a
// dot or space, which Windows strips — letting what isExecutable() sees differ from
// what runs. Applied by the page sanitizer, the page's open path and the host.
export function safeLocalPath(raw) {
    if (typeof raw !== "string" || !raw || raw.length > MAX_PATH_LENGTH) return null;
    if (/[\x00-\x1f\x7f]/.test(raw)) return null;
    let path = raw;
    if (Services.appinfo.OS === "WINNT") {
        path = path.replace(/\//g, "\\");
        if (!/^[A-Za-z]:\\/.test(path)) return null;
        if (path.indexOf(":", 2) !== -1) return null;
        if (path.split("\\").some(segment => /[. ]$/.test(segment))) return null;
    } else if (!/^\/(?!\/)/.test(path)) {
        return null;
    }
    try {
        return PathUtils.normalize(path);
    } catch (e) {
        return null;
    }
}

// The single gate every stored URL passes through, on the way in and on the way out.
// Returns the canonical spec, or null.
//
// What this exists to stop: a document can carry any string it likes in webcard.url,
// and that string ends up as a top-level load. Without a scheme check, javascript:,
// data:, file:, chrome: and resource: are all reachable from a file on disk.
//
// http is allowed: it is an ordinary web scheme, and blocking it here would silently
// swallow dropped links. Transport security for live tiles is a separate, narrower gate
// applied where the network request actually happens.
export function safeExternalUrl(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;

    let uri;
    try {
        uri = Services.io.newURI(trimmed);
    } catch (e) {
        return null;
    }

    if (uri.scheme !== "https" && uri.scheme !== "http") return null;

    // Embedded credentials in a URL that renders as a title on a board is a phishing
    // shape, and they would be written to disk in the clear.
    try {
        if (uri.userPass) return null;
    } catch (e) { }

    return uri.spec;
}

// A card's favicon, or "". Local schemes only.
//
// The icon is loaded as a plain <img> — by the floating card bar, which is chrome DOM in
// the browser window, and by the library's thumbnails in the page. A remote URL there is
// the easel reaching out to somebody's server every time a card comes under the pointer,
// from a string that lives in a hand-editable file on disk.
//
// data:image/ rather than data: whole: the broader form is what screenshot-hook accepts
// straight from gBrowser.getIcon, and by the time a value reaches here it has been
// through a document on disk, so the tighter test is the one that belongs on the way in.
//
// Here, and not beside its callers, for the reason at the top of this file: the page's
// object sanitizer and the live-tile host both apply it, in different globals, and two
// copies of a gate are how the gate stops meaning anything.
const LOCAL_ICON_RE = /^(page-icon:|data:image\/|chrome:|moz-)/i;

export function safeFaviconUrl(value) {
    const url = String(value || "").trim();
    return LOCAL_ICON_RE.test(url) ? url : "";
}

// Coerces a caller-supplied extension hint (a MIME subtype or a filename suffix) to one
// the store will keep. The fallback is bin, not an image type, so an unknown file is
// never stored under a name that would be read as a picture.
export function safeExtension(extension) {
    const ext = String(extension || "").toLowerCase();
    return EXTENSION_RE.test(ext) ? ext : "bin";
}
