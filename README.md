# Zen Easel

A port of Arc's Easel to Zen. An infinite canvas at `about:easel` for web captures, text,
shapes and ink. Everything is stored locally in your Zen profile.

<img width="1716" height="756" alt="image" src="https://github.com/user-attachments/assets/866b8b9d-8ca2-4720-a6ff-00cd973b99cd" />


## Install

Requires [Sine](https://github.com/CosmoCreeper/Sine). In Sine's settings, enable
installing from unofficial sources, paste this repository's URL into the GitHub install
field, and restart Zen.

Requires the forked [Zen Library](https://github.com/trashshii007/Zen-Library).

## Opening a board

`Ctrl+Shift+E`, the toolbar button, or the **Easels** section of the Zen Library.

**Each board opens in its own tab.** Picking one from the switcher opens or focuses that
board's tab rather than replacing the board you are on, so you can keep several open,
reorder them, and split two against each other like any other pair of tabs. Boards get a
tab title and favicon, `Ctrl+W` closes one, and a restored session reopens what you had.

Every board opens with a heading at the top. It is a text box, and it is also the
board's name: rename it anywhere and the tab, switcher and library card follow.

## Capturing the web

<img width="396" height="186" alt="image" src="https://github.com/user-attachments/assets/5afb6da3-0d11-464d-b8b3-0bb99021feaf" />

- **Zen's screenshot button** → **Move to easel** → pick a board → drag a region.
- **After *Save visible page* / *Save full page*** → **Move to easel**.
- **`Ctrl+Shift+2`** → drag a region; it drops onto the board you had open last.

In the region picker, click without dragging to capture the element under the pointer.
The screenshot panel also offers **Whole window to easel**. *New easel…* starts a fresh
board from the capture. Captures keep their source URL — double-click a card to go back
to the page it came from.

## Blown-out screenshots, and the capture backdrop

If you use a styling extension that makes sites transparent — [Zen
Internet](https://github.com/sameerasw/zeninternet) is the one this was written for —
screenshots come out looking washed out and half-erased. Three ordinary things line up:

1. Zen makes the content view transparent. With `browser.tabs.allow_transparent_browser`
   set, every `<browser>` gets `transparent="true"`, which tells Gecko not to paint the
   default white canvas behind a page. What shows through instead is your Zen window.
2. The extension makes the page's own background transparent so that window is visible —
   its per-site Transparency rules are literally
   `html, body, #root, … { background-color: transparent !important }`.
3. Every screenshot path composites onto **white**. Firefox's `ScreenshotsUtils.createCanvas`
   fills the canvas with `rgb(255,255,255)` and asks `drawSnapshot` for the pixels with the
   same colour behind them.

A snapshot has no browser window behind it — nothing is there at all. So light text that
reads perfectly over a dark Zen window lands on pure white. Nothing is broken; the page is
being composited against something other than what you were looking at.

Zen Easel puts the colour that *was* behind the page into the picture, by changing that one
argument. It covers Zen's own screenshots — visible page, full page, copy region, download
region — as well as Zen Easel's captures and **Move to easel**. The page is never touched:
no stylesheet is injected, nothing is asked of the content process, and the extension is
left alone, so there is no flash and nothing to restore afterwards.

`zen.easel.capture-backdrop` picks what goes behind:

| Value | |
|---|---|
| `auto` *(default)* | your window's colour, on tabs Zen has made transparent |
| `always` | your window's colour, whatever the tab is |
| `page` | plain white or near-black, by your light/dark setting |
| `custom` | `zen.easel.capture-backdrop-color`, exactly as typed |
| `off` | Firefox's white — the feature becomes a no-op |

`auto` reads Zen's own `--zen-main-browser-background`; if that is a gradient or a
translucent mica surface it walks up the chrome from the `<browser>` to the first thing
that paints something opaque, and falls back to your scheme's plain surface colour. An
opaque page is unaffected in every mode — it paints over the backdrop completely — and in
the default configuration the colour applied is the one already showing through, so there
is nothing to notice either way.

If a shot still looks wrong, `custom` with your own colour is the escape hatch, and
`zen.easel.debug` logs where `auto` got its answer from.

## Tools

<img width="538" height="245" alt="image" src="https://github.com/user-attachments/assets/191ee337-df59-435f-b2a0-cb1b66ddc2b7" />

`V` select · `T` text · `R` rectangle · `O` ellipse · `Y` triangle · `L` line ·
`A` arrow · `P` pen · `I` image

Text and image act on the first click rather than arming a mode. The pen stays armed
after a stroke; every other tool drops back to select. Nothing is selected after you
draw it.

## Navigation

| | Mouse | Keyboard |
|---|---|---|
| Zoom | wheel, centred on the pointer | `Ctrl` `+` / `Ctrl` `-` |
| Pan | middle-drag, or `Space`+left-drag | arrow keys with nothing selected |
| Scroll sideways | `Shift`+wheel | — |
| Zoom 100% | click the zoom readout | `Ctrl` `0` |
| Zoom to fit | — | `Ctrl` `1` |
| Zoom to selection | — | `Ctrl` `2` |

The board has a fixed width and zooming out stops at fit-width. It grows downward as you
work, always keeping three window-heights of room below the lowest object.

## Editing

| | Mouse | Keyboard |
|---|---|---|
| Select | click · `Shift`+click to extend | `Tab` / `Shift`+`Tab` to cycle |
| Marquee select | drag on empty canvas | — |
| Select all | — | `Ctrl`+`A` |
| Move | drag · `Shift` locks to one axis | arrows (1px) · `Shift`+arrows (10px) |
| Resize | 8 handles · `Shift` keeps aspect ratio | — |
| Rotate | grip above the top edge · `Shift` snaps to 15° | — |
| Constrain while drawing | `Shift` → square, circle, 45° lines | — |
| Duplicate | `Ctrl`+drag | `Ctrl`+`D` |
| Delete | — | `Delete` / `Backspace` |
| Undo / redo | — | `Ctrl`+`Z` · `Ctrl`+`Shift`+`Z` or `Ctrl`+`Y` |
| Copy / cut / paste | — | `Ctrl`+`C` / `Ctrl`+`X` / `Ctrl`+`V` |
| Raise / lower | — | `Ctrl`+`]` / `Ctrl`+`[` |
| New text box | text tool | `T` |
| Edit text | double-click a box | `Ctrl`+`Enter` commits |
| Context menu | right-click | `Menu` key |
| Lock / unlock | right-click → **Lock** | — |

`Escape` steps out of a live card, then cancels a drag, then returns to the select tool,
then clears the selection.

## Locking

**Lock** on an object's right-click menu pins it to the board. The pointer passes
straight through a locked object: no halo when you hover it, no selection, no drag,
resize or rotate, no double-click to edit, and a marquee, `Ctrl`+`A` and `Tab` all step
over it. Keyboard edits cannot reach one either, because nothing that is locked is ever
selected.

Right-click is the way back. It is the one thing that still finds a locked object, and
its menu says **Unlock**. While it is locked that menu acts on the object you clicked
rather than on the selection, so Duplicate, Copy, the reordering pair and Delete all
still do what they say.

A locked live card or web tile will not go live on a click and will not take the pointer;
locking one that is already running hands the pointer back. A copy of a locked object —
duplicated or pasted — arrives unlocked, since it lands selected and is meant to be moved
into place.

## Colour

Eleven colours in two palettes, **Vibrant** and **Chill**, chosen per board from the
canvas right-click menu. Number keys `1`–`9` and `0` pick the first ten directly.

A swatch recolours the selection and sets the default for the next mark. Stroke widths
beside the swatches work the same way, on shapes and ink.

## Opacity

The slider under the swatches fades whatever is selected, from 100% down to 10%, and
sets the default for the next mark — so the toolbar's dot always previews the mark you
are about to make. It applies to everything on a board: shapes, ink, text, images and
animated GIFs, captures and web tiles. A live tile fades along with its screenshot, so
pressing **▶** on a faded card does not snap it back to full strength. The whole drag is
one undo step.

Pen strokes thin as the pen speeds up and follow stylus pressure. Set
`zen.easel.ink-style` to `uniform` for a constant width.

## Text

<img width="807" height="287" alt="image" src="https://github.com/user-attachments/assets/4c3bf02e-4def-4337-a827-4c0de72c0dc9" />

Controls appear beside the box and apply live, including while typing:

| | |
|---|---|
| **Aa** | typeface list, each row previewed in its own face |
| **Body** / **H2** / **H1** / **H0** / **Ultra** | five paragraph styles — 32, 52, 80, 120 and 180px |
| **▮** | highlighter, drawn per line to the width of the words |

Typefaces are Inter, Nunito, EB Garamond, Inconsolata and Space Mono, plus your system
font. See [fonts/LICENSE.md](fonts/LICENSE.md).

## Backgrounds

<img width="345" height="432" alt="image" src="https://github.com/user-attachments/assets/62ae3da4-3c34-4201-929c-254c74699397" />

Right-click empty canvas for nine background swatches, saved per board. **Follow theme**
is the default and tracks Zen between light and dark, so a new easel arrives matching the
browser; **Arc** is the pale multi-colour wash; **Transparent** declines to tint at all. Every board is a tint rather than a fill, and the toolbar, popups and menus
take the active board's colour.

## Live web cards and web tiles

<img width="918" height="544" alt="image" src="https://github.com/user-attachments/assets/da62dfe2-dd5f-43ca-9569-1cc34c2b468d" />

Point at a capture and a bar fades in over its bottom edge — the site's icon and title,
**▶**, and **↗** to open the source page in a tab. Press **▶** and the pixels are replaced
by the real page, cropped to the region you captured; **❚❚** goes back to the screenshot.
A card you are not pointing at is just the picture, edge to edge.

The toolbar, the topbar and their panels stay on top of a live card. They are drawn inside
the page and a tile is a browser element above it, so they cannot simply be raised — a hole
is cut in the tile layer where each of them is instead.

Click a live card once and the pointer belongs to the page inside it; `Escape` hands it
back. Right-click always gets the easel's menu.

**The bar is the card's handle.** Drag it and the card moves, without the press being
taken as the click that hands the pointer to the site — so a running card can be
rearranged without stopping it first. Everywhere else on a live card still means "let me
use the page". A card too small to carry a bar has none to grab: pause it from the
right-click menu and it drags like anything else.

**Web tiles** are the real site from the start — right-click empty canvas → **Add a web
tile…**. Unlike live cards they scroll, text in them can be selected, and forms submit.
YouTube links dropped or pasted become 16:9 embed players.

A web tile has no screenshot behind it, so it keeps its own: a few seconds after it
loads, and again whenever you stop it, the tile's current frame is saved as the card's
picture. A stopped tile shows that rather than a blank panel — a video keeps its poster
frame — with a strip along the bottom saying it is not running. Nothing is downloaded for
this; the picture is the tile's own output.

Once a card is live it **stays running**. Scrolling it off the board, switching to another
easel, switching tabs and minimising the window all stop it *painting*, not running — so a
dashboard you left open is still current when you come back, rather than a stale
screenshot.

A card you cannot see for **30 minutes** stops on its own (`live.idle-timeout-min`; `0` to
never). Only out-of-sight cards age: one on screen, or one playing audio, never times out.
A card that does times out goes back to its screenshot, and one click starts it again.

Press **❚❚** to stop one for real. The count in the top bar shows how many are running in
the window, including any on boards you do not have open; click it to see them, stop one,
or **Stop all live cards**.

Closing a board's tab stops that board's cards, and `Ctrl+R` stops them too — a reload
starts the board over, websites included. Closing Zen stops everything.

Both are opt-in and capped — twelve at once by default (`live.max-tiles`; `0` for no cap),
because each live card is a separate content process. Cards always open as screenshots.
Background cards keep playing audio if they were already playing, and never start on their
own; **Mute this card** in the right-click menu overrides that per card. Links inside
either open in a normal tab. `zen.easel.live.enabled = false` is a hard off switch.

## Dropping things on the canvas

Drag an image file to place it (PNG, JPEG, WebP, GIF, AVIF). Drag a tab, link or URL for
a link card you can double-click to open. Dropped plain text becomes a text box. GIFs
animate.

## Alignment

Objects snap to each other on six axes — left, centre, right, top, middle, bottom — with
a line showing the match. Hold `Alt` to suppress. Set **Snapping** to *Grid* in settings
for grid snapping instead.

## Exporting

Right-click empty canvas for **Export as PNG…** or **Export as JPEG…**, or press
`Ctrl+Shift+S`. The board renders at full resolution, framed to its contents.

## Where your easels live

```
<profile>/zen-easels/
  index.json                   which easels exist, and which was open last
  easels/<id>.json             one document: objects, background, saved viewport
  easels/<id>.thumb.png        card thumbnail for the library
  assets/<id>/<uuid>.png       captures and dropped images
```

Set `zen.easel.storage-dir` to keep them elsewhere. Writes are atomic and flushed 500ms
after you stop working, on close, and at shutdown.

## Settings

In Zen's mod preferences, or `about:config`:

| Pref | Default | |
|---|---|---|
| `zen.easel.shortcut.new` | `Ctrl+Shift+E` | open the easel (restart to apply) |
| `zen.easel.shortcut.capture` | `Ctrl+Shift+2` | capture a region (restart to apply) |
| `zen.easel.wheel` | `zoom` | `zoom` or `pan`; `Ctrl`+wheel zooms either way |
| `zen.easel.ink-style` | `variable` | `variable` thins with speed and pressure; `uniform` is constant |
| `zen.easel.grid` | `dots` | `none`, `dots` or `lines` |
| `zen.easel.snap` | `guides` | `guides`, `grid`, or `none`. Hold `Alt` to suppress |
| `zen.easel.grid-size` | `24` | canvas pixels, for `snap: grid` |
| `zen.easel.capture-backdrop` | `auto` | what goes behind a captured page: `auto`, `always`, `page`, `custom`, `off` |
| `zen.easel.capture-backdrop-color` | *(empty)* | CSS colour for `custom` |
| `zen.easel.live.enabled` | `true` | off means no easel ever loads a website |
| `zen.easel.live.max-tiles` | `12` | how many cards may be live at once; `0` for no cap |
| `zen.easel.live.idle-timeout-min` | `30` | stop a card after this long out of sight; `0` for never |
| `zen.easel.live.reveal-delay-ms` | `140` | pause before showing live cards again after a tab switch |
| `zen.easel.live.private` | `false` | load live cards in a private session |
| `zen.easel.live.container` | `0` | container ID for live cards; `0` is your normal session |
| `zen.easel.live.allow-http` | `false` | allow live cards over plain http |
| `zen.easel.autosave-ms` | `500` | delay after the last change |
| `zen.easel.storage-dir` | *(empty)* | empty means `<profile>/zen-easels` |
| `zen.easel.debug` | `false` | `[zen-easel]` logging in the Browser Console |

`Ctrl+Shift+E` is also the DevTools Network Monitor while DevTools has focus. Rebind it
if that gets in your way.

Changes to the mod need a Zen restart — `supportsUnload` is off.

## Credit

Feature design is Arc's, by The Browser Company. This is an independent reimplementation
for Zen with no Arc code in it.

The renderer's structure is modelled on
[Excalidraw](https://github.com/excalidraw/excalidraw) (MIT). The variable-width stroke
geometry is an independent implementation of the approach described by
[perfect-freehand](https://github.com/steveruizok/perfect-freehand) (Steve Ruiz, MIT).
No code from either project was copied.

---

The full write-up — design rationale, architecture, and security notes — is in
[docs/MANUAL.md](docs/MANUAL.md).
