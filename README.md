# Zen Easel

A port of Arc's Easel to Zen. An infinite canvas at `about:easel` for web captures, text,
shapes and ink. Everything is stored locally in your Zen profile.

## Install

Requires [Sine](https://github.com/CosmoCreeper/Sine). In Sine's settings, enable
installing from unofficial sources, paste this repository's URL into the GitHub install
field, and restart Zen.

Requires the forked [Zen Libary](https://github.com/trashshii007/Zen-Library). 

## Opening a board

`Ctrl+Shift+E`, the toolbar button, or the **Easels** section of the Zen Library. Boards
open in an ordinary tab — they get a title and favicon, `Ctrl+W` closes one, and a
restored session reopens the board you were on.

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

`Escape` steps out of a live card, then cancels a drag, then returns to the select tool,
then clears the selection.

## Colour

Eleven colours in two palettes, **Vibrant** and **Chill**, chosen per board from the
canvas right-click menu. Number keys `1`–`9` and `0` pick the first ten directly.

A swatch recolours the selection and sets the default for the next mark. Stroke widths
beside the swatches work the same way, on shapes and ink.

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

Right-click empty canvas for nine background swatches, saved per board. **Arc** is the
default; **Follow theme** tracks Zen between light and dark; **Transparent** declines to
tint at all. Every board is a tint rather than a fill, and the toolbar, popups and menus
take the active board's colour.

## Live web cards and web tiles

<img width="918" height="544" alt="image" src="https://github.com/user-attachments/assets/da62dfe2-dd5f-43ca-9569-1cc34c2b468d" />

Press **▶** in a capture's title strip and the pixels are replaced by the real page,
cropped to the region you captured. Press **❚❚** to go back to the screenshot. Click a
live card once and the pointer belongs to the page inside it; `Escape` hands it back.
Right-click always gets the easel's menu, and the title strip doubles as the drag handle.

**Web tiles** are the real site from the start — right-click empty canvas → **Add a web
tile…**. Unlike live cards they scroll, text in them can be selected, and forms submit.
YouTube links dropped or pasted become 16:9 embed players.

Both are opt-in, capped at three at once, and torn down when they scroll out of view or
the tab is backgrounded. Cards always open as screenshots. Links inside either open in a
normal tab. `zen.easel.live.enabled = false` is a hard off switch.

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
| `zen.easel.live.enabled` | `true` | off means no easel ever loads a website |
| `zen.easel.live.max-tiles` | `3` | how many cards may be live at once |
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
