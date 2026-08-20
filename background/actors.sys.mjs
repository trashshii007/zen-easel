// Zen Easel — what the two window actors are, and how to install them.
//
// Split out of registry.sys.mjs, and the split is the point rather than tidiness.
//
// A background module is imported once per process. Its top level never runs again, so
// editing it changes nothing until Zen is restarted — while the mod's window scripts are
// re-run on every reload. Actor registration is process-global and
// ChromeUtils.registerWindowActor *throws* on a name that is already taken, leaving the
// existing registration in place. Put together: an actor registered by an older revision
// of the mod goes on serving for the rest of the browser's life, and no amount of editing
// or reloading can displace it, because the only code that could is itself the stale copy.
//
// This file is the way out of that. It is newer than any registration, so no process is
// holding an older copy of it, which means a window script that imports it gets *these*
// definitions and can install them over whatever is registered — without a restart. Keep
// that property: never let this file's contents depend on another background module, and
// prefer adding to it over reviving the definitions that used to live in registry.sys.mjs.

const ACTOR_BASE = "chrome://sine/content/zen-easel/actors/";

// The one line that decides whether either of these actors exists at all.
//
// Gecko will not instantiate an actor in an untrusted web content process unless the actor
// declares itself safe there. Without it, every getActor on an ordinary page throws
//
//   WindowGlobalParent.getActor: Window protocol 'ZenEaselCapture' doesn't match
//   remote type 'webIsolated=https://github.com^userContextId=1'
//
// The message names the remote type, so it reads as a remoteTypes problem. It is not one.
// Do not go looking for a list to widen — there is no value of remoteTypes that fixes this,
// and the refusal happens whether the field is present, absent or broad.
//
// Zen's own Gecko settles it. Unzip omni.ja and read toolkit's
// modules/ActorManagerParent.sys.mjs: 37 of its 38 window actors carry this flag, and the
// one that does not is AboutCertViewer, pinned to `remoteTypes: ["privilegedabout"]` and
// never shown a web page. Everything that touches web content declares it.
//
// So remoteTypes stays absent on both actors below, exactly as Firefox's own web-content
// actors leave it off — and under Fission the values it would need are not really
// guessable, since a page in a container runs in
// "webIsolated=https://example.com^userContextId=1".
//
// This requirement arrived with a browser update (Zen 1.21.15b, Gecko 154) rather than with
// any change here, which is worth knowing the next time captures stop offering to go live
// for no reason visible in this repository's history.
//
// What the flag asserts is real and worth honouring: that a compromised content process
// cannot use this actor to reach anything it should not have. Both of these only ever
// answer with numbers, and neither accepts anything from the page but a point to hit-test
// — see the two child actors.
const SAFE_IN_CONTENT = true;

export const ACTOR_OPTIONS = {
    // The live-tile actor. messageManagerGroups is the security-critical line: it scopes
    // the actor to browsers carrying messagemanagergroup="zen-easel-live", which only
    // live-host.uc.js sets. Without it, this would attach a scroll-eating,
    // click-intercepting actor to every page in the browser.
    //
    // mozSystemGroup on the input events is what makes the locks unbypassable — a page
    // calling stopPropagation() in the default group cannot reach the system group.
    ZenEaselLive: {
        parent: { esModuleURI: `${ACTOR_BASE}ZenEaselLiveParent.sys.mjs` },
        child: {
            esModuleURI: `${ACTOR_BASE}ZenEaselLiveChild.sys.mjs`,
            events: {
                DOMContentLoaded: {},
                pageshow: {},
                // The last point the document's height changes for reasons unrelated to
                // script, so the crop gets one more assertion there. createActor:false
                // for the same reason as scroll: it must not be what brings the actor
                // into existence on a page that never went live.
                load: { createActor: false },
                wheel: { capture: true, mozSystemGroup: true },
                touchmove: { capture: true, mozSystemGroup: true },
                keydown: { capture: true, mozSystemGroup: true },
                selectstart: { capture: true, mozSystemGroup: true },
                click: { capture: true, mozSystemGroup: true },
                auxclick: { capture: true, mozSystemGroup: true },
                contextmenu: { capture: true, mozSystemGroup: true },
                submit: { capture: true, mozSystemGroup: true },
                scroll: { capture: true, mozSystemGroup: true, createActor: false }
            }
        },
        messageManagerGroups: ["zen-easel-live"],
        allFrames: true,
        // A tile is a web page like any other, so this actor was refused in exactly the way
        // the capture one was, and stopped attaching on the same browser update — taking the
        // scroll lock, the selection lock and the link interception with it, silently, since
        // a tile still renders its site without them.
        safeForUntrustedWebProcess: SAFE_IN_CONTENT
    },

    // The capture-measurement actor has to reach ordinary tabs, so its group is the
    // default "browsers". It is inert at rest: with no events and no observers declared,
    // the child is never instantiated until the parent calls getActor(), which happens
    // once per capture.
    ZenEaselCapture: {
        parent: { esModuleURI: `${ACTOR_BASE}ZenEaselCaptureParent.sys.mjs` },
        child: { esModuleURI: `${ACTOR_BASE}ZenEaselCaptureChild.sys.mjs` },
        messageManagerGroups: ["browsers"],
        allFrames: true,
        safeForUntrustedWebProcess: SAFE_IN_CONTENT
    }
};

// Installs one actor, replacing whatever is registered under that name.
//
// Unregistering first is the whole trick: registerWindowActor throws on a name already
// taken and keeps the *old* definition, so registering without it can only ever be a no-op
// against a stale registration. Unregistering is safe — actors already attached to a
// document keep working, and only the definition used for the next one changes.
//
// Returns true when the actor is registered with these options afterwards.
export function ensureActor(name) {
    const options = ACTOR_OPTIONS[name];
    if (!options) {
        console.error(`[zen-easel] there is no actor called ${name}`);
        return false;
    }

    try { ChromeUtils.unregisterWindowActor(name); } catch (e) { }

    try {
        ChromeUtils.registerWindowActor(name, options);
        return true;
    } catch (e) {
        console.error(`[zen-easel] could not register the ${name} actor:`, e);
        return false;
    }
}

// Every actor, each independent of the others: one runs inside live tiles, the other
// measures an ordinary tab at capture time, and a throw from the first must not take the
// second with it.
export function ensureActors() {
    for (const name of Object.keys(ACTOR_OPTIONS)) ensureActor(name);
}

export function removeActors() {
    for (const name of Object.keys(ACTOR_OPTIONS)) {
        try { ChromeUtils.unregisterWindowActor(name); } catch (e) { }
    }
}
