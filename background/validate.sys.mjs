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

// gif and avif are here because earlier versions accepted any image/* drop and wrote it
// under its own extension — omitting them would make every such object vanish on the
// next load. They are raster formats and decode inertly. svg is the one deliberate
// omission: it is a scriptable document format, and these names end up in
// createObjectURL and then in an <img>.
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(png|jpe?g|webp|gif|avif)$/i;

export const ASSET_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);

const MAX_URL_LENGTH = 4096;

export function isSafeId(id) {
    return typeof id === "string" && ID_RE.test(id);
}

export function isSafeAssetName(name) {
    return typeof name === "string" && ASSET_NAME_RE.test(name) && !name.includes("..");
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

// Coerces a caller-supplied extension hint (a MIME subtype or a filename suffix) to one
// the store will keep.
export function safeExtension(extension) {
    const ext = String(extension || "").toLowerCase();
    return ASSET_EXTENSIONS.has(ext) ? ext : "png";
}
