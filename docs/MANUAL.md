# Zen Easel

A port of Arc's **Easel** to Zen for Windows: a canvas where you drop captures of the
web and arrange, annotate and sketch over them. Fixed width, no top, and it runs on
downward as far as you need.

Easels live at **`about:easel`**, in an ordinary tab — not as an overlay floating over
whatever page you happened to be on. They get a tab title and favicon, `Ctrl+W` closes
one, and a restored session reopens the board you were looking at.

**One tab per board.** Opening a board focuses its tab if it already has one and makes a
new tab if it does not, so several can be open at once and two can be split against each
other. This replaces an earlier "one easel at a time" rule, where the switcher swapped the
document inside a single shared tab. That rule existed because two easel pages used to
race each other on `index.json`, and because everything that looked up "the easel tab" by
walking `gBrowser.tabs` took the first one it found. Both are gone: every write now goes
through `background/store.sys.mjs`, a per-process singleton with one serialised queue, and
the live-tile host resolves tabs by easel id and keeps a layer per board.

Everything stays on your machine. Easels are plain JSON and PNG files inside your Zen
profile that you can read, back up, or delete with any file manager. The one exception
is **live web cards**, which are opt-in per card and documented below — with them off,
the mod makes no network requests at all, and the page's own Content-Security-Policy
enforces that rather than leaving it to convention.

---

## Using it

Open an easel with **Ctrl+Shift+E**, the toolbar button, or the **Easels** section of
the Zen Library (the button beside the workspace indicator in the sidebar).

Every easel opens with a **centred heading** at the top, ready to type into. It is a real
text box — move it, restyle it, colour it — and it *is* the easel's name: rename it here
and the tab, the switcher and the library card all follow; rename it in the library and the
lettering on the board changes to match. This is how Arc does it (`titleObjectID`), and it
is why an Arc board never needs a title bar. Delete it and the easel keeps its name; to get
one back, right-click any text box and choose **Use as easel title**.

Captures always keep the source URL, so double-clicking a card later takes you back to
the page it came from. There are three ways in:

- **Zen's screenshot button.** Press it and the panel that appears — *Save visible page*
  / *Save full page* — now also offers **Move to easel**. Pick an easel and you get a
  region picker; drag, and it lands there.
- **After *Save visible page* or *Save full page*.** The preview that follows has a
  **Move to easel** button beside Copy and Download.
- **Ctrl+Shift+2.** Drag a region and it drops straight onto the easel you had open
  last, no menus. Fastest when you already know where it is going.

In the region picker you can also just **click**, without dragging: the element under the
pointer is outlined as you move, and clicking captures it. This is Arc's
`canClickToCapture` — the page is asked which element you are over and it scores them the
way Arc does, rejecting slivers and anything that is effectively the whole page, and
preferring images and video. It is much the faster way to grab an article, a card or a
chart. The screenshot panel also offers **Whole window to easel**, which skips the picker.

*New easel…* appears in both menus and starts a fresh board from the capture.

Everything is mouse-and-keyboard first. Arc's Easel was built around a Mac trackpad;
every gesture here has a keyboard and mouse equivalent, and nothing is reachable only
by gesture.

### Navigation

| | Mouse | Keyboard |
|---|---|---|
| Zoom | wheel, centred on the pointer | `Ctrl` `+` / `Ctrl` `-` |
| Pan | middle-drag, or hold `Space` and left-drag | arrow keys with nothing selected |
| | *bounded sideways and at the top — see below* | |
| Scroll sideways | `Shift`+wheel | — |
| Zoom 100% | click the zoom readout | `Ctrl` `0` |
| Zoom to fit | — | `Ctrl` `1` |
| Zoom to selection | — | `Ctrl` `2` |

The wheel zooms by default. Set `zen.easel.wheel` to `pan` if you would rather it
scrolled — `Ctrl`+wheel zooms either way.

### The board is a page

It reads like a PDF rather than an unbounded plane. The page has a **fixed width**, and
**zooming out stops at fit-width** — so the page always spans the window and there is
never dead space beside it. You start at the top and scroll **down** to uncover more.

The page **grows with your work**: its bottom always sits three window-heights below the
lowest thing on it, so there is room to keep going without the board being endlessly,
uselessly long. An easel you can get lost in has no home to return to.

### Editing

| | Mouse | Keyboard |
|---|---|---|
| Select | click · `Shift`+click to extend | `Tab` / `Shift`+`Tab` to cycle |
| Marquee select | drag on empty canvas | — |
| Select all | — | `Ctrl`+`A` |
| Move | drag · `Shift` locks to one axis | arrows (1px) · `Shift`+arrows (10px) |
| Resize | the 8 handles · `Shift` keeps the aspect ratio | — |
| Rotate | the grip above the top edge · `Shift` snaps to 15° | — |
| Constrain while drawing | `Shift` → square, circle, 45° lines | — |
| Duplicate | `Ctrl`+drag | `Ctrl`+`D` |
| Delete | — | `Delete` or `Backspace` |
| Undo / redo | — | `Ctrl`+`Z` · `Ctrl`+`Shift`+`Z` or `Ctrl`+`Y` |
| Copy / cut / paste | — | `Ctrl`+`C` / `Ctrl`+`X` / `Ctrl`+`V` |
| Raise / lower | — | `Ctrl`+`]` / `Ctrl`+`[` |
| New text box | click the text tool | `T` |
| Edit text | double-click a text box | `Ctrl`+`Enter` commits |
| Interact with a live card | click it | `Escape` hands the pointer back |
| Context menu | right-click | `Menu` key |

### Tools

Single keys, no modifier:

`V` select · `T` text · `R` rectangle · `O` ellipse · `Y` triangle · `L` line ·
`A` arrow · `P` pen · `I` image

Text and image are **actions, not modes**: both do the thing on the first click rather
than arming a tool and waiting for a second one. `T` drops a ready box in the middle of
the view; `I` opens the file picker straight away, and the image lands centred. There
was nothing to aim in the second click — the picker is a dialog, and the file arrived in
the middle of the view either way.

The toolbar sits at the **bottom left**, as Arc's does. Colour, stroke width and opacity
share one button at its right-hand end: the dot shows the current colour, its size shows
the current stroke width, and how far through it you can see is the current opacity.
Number keys `1`–`9` and `0` pick the first ten palette colours directly; the eleventh is
in the swatch popup. All of these apply to the selection as well as setting the default —
see **Palettes** and **Opacity**.

### Palettes

There are **eleven colours**, in two palettes — **Vibrant** and **Chill** — and the choice
is saved per easel, from the canvas right-click menu. These are Arc's own palettes with
Arc's own values, read out of the colour renditions in its asset catalog rather than
matched by eye.

Switching palette repaints the whole board at once and changes nothing about it: colour is
stored as a name, so an object that is "red" is red in both, and simply resolves to
`#F53714` in Vibrant and `#D74807` in Chill. Black, grey and white are shared.

**The palette sets the colour of what you draw next, and repaints whatever is
selected.** Select something and click a swatch — or press its number key — and it
changes colour; the stroke widths beside the swatches work the same way, on shapes and
ink. With nothing selected you are only setting the default for the next mark.

It used to be the other way round: the swatch never touched the selection, and
recolouring lived in the right-click menu. That was working around a problem that no
longer exists — objects used to stay selected after being drawn, so a swatch click
would silently repaint the thing you had just finished. Nothing is selected after you
draw it any more, so the swatch can mean the obvious thing, and the duplicate row of
swatches in the context menu is gone. Board backgrounds are still there, on empty
canvas, because the toolbar has no control for those.

Pen strokes vary in width: the line thins as the pen speeds up, and follows real
pressure if you draw with a stylus. Set `zen.easel.ink-style` to `uniform` for a
constant width. A single click leaves a dot at the stroke's own width, as in Excalidraw.

**Nothing is selected after you draw it.** No transform box lands on the shape you just
placed, for any tool. Selection is for coming back to something: switch to select (`V`)
and click it.

The pen stays armed after a stroke so you can keep sketching; every other tool drops
back to select.

### Locking

**Lock**, on an object's right-click menu, pins it to the board. It is implemented as one
test in one place: `_hitTest` skips locked objects. Everything that treats a click as
landing on something goes through that function — the hover halo, the live card's floating
bar, selection, dragging, double-click to edit, the click that loads a web tile — so the
pointer falls through a locked object to whatever is behind it, exactly as if it were not
there. There is no separate list of things locking disables, and so no way for a new
pointer feature to quietly not be covered by it.

Selection is the second gate, and it is what makes the keyboard follow. `select()` declines
a locked id outright, so `Ctrl`+`A`, a marquee and `Tab` step over one, and every keyboard
edit — nudging, `Delete`, `Ctrl`+`D`/`C`/`X`, the reordering pair, colour, stroke width and
opacity — is out of reach for free, because all of them act on the selection. Locking an
object that is already selected drops it out of the set: an id left in there keeps a
transform frame with working handles around a thing that is not supposed to move.

**Right-click is the way back**, and the only one. It asks `_hitTest` the question the
other way round, with `includeLocked`, because a menu that could not see a locked object
would leave it with no route to being unlocked. It still does not *select* it — so while
the target is locked, the menu's object items act on the object you clicked rather than on
the selection. That is why `duplicateObjects`, `copyObjects` and `reorderObjects` exist
beside their `…Selection` siblings; the selection cannot speak for something that is never
in it.

Two consequences worth stating:

- **A locked live card or web tile will not take the pointer.** It cannot be clicked to go
  live, and locking one that is already activated hands the pointer back — otherwise the
  site inside a locked card would go on answering clicks that the board around it no longer
  does. If you would rather lock a tile *so that* you can use the site inside it without
  dragging the card by accident, that is the one line to change: drop the `deactivate()` in
  `setLocked` and let `_pointerToolDown` see locked live cards.
- **A copy comes back unlocked**, duplicated or pasted. Figma keeps the lock, but Figma has
  a layers panel to select from; here a locked paste would be a copy you have to hunt for
  and unlock before you could do the thing you pasted it to do.

There is deliberately no keystroke for locking and no badge on a locked object. A key that
locks is a key that makes whatever you just pressed it on stop answering the pointer with
nothing on screen to say why, and the menu that offers **Lock** is the same menu that
offers **Unlock**.

### Opacity

The third row of the style popup, under the swatches and the widths. It is a slider
rather than a set of preset stops, because opacity has no vocabulary the way colour and
stroke width do — the value you want is "a bit fainter than that", which is a drag, not a
choice from a list. It runs from 100% down to 10%, and the floor is not zero on purpose:
a fully invisible object is still on the board, still selectable and still in the way,
and all it tells you is that something has gone wrong.

Unlike a swatch it does not close the popup on first contact — you are aiming at a result
on the board, and a control that dismissed itself could not be aimed. It opens showing the
selection's own value rather than the toolbar default, so the first touch does not jump
anything, and a mixed selection falls back to the default rather than picking one object's
value to speak for the rest.

**Every type fades.** Opacity lives beside `x`, `y` and `rotation` rather than inside any
one type's sub-object, so a capture, a caption and a pen stroke all take it — shapes, ink,
text, still images, animated GIFs, web cards and web tiles.

Three of those are not painted by the canvas and so cannot be reached by the renderer's
`globalAlpha`, and each is faded where it actually lives:

| | |
|---|---|
| animated GIFs | an `<img>` in the media layer — the compositor fades the element |
| a text box being edited | the `<textarea>` overlay, alongside its colour and font |
| a running live tile | sent to the host with the tile's geometry and applied to its wrapper |

That last one is why pressing **▶** on a faded card does not snap it back to full
strength. The hover bar is chrome rather than content, so it stays legible either way.

The whole drag is **one undo step**, not one per pixel: the first slider event opens a
mutation and the release closes it. Committed pen strokes are cached as bitmaps, and the
opacity is applied to the blit rather than baked into the bitmap and left out of the cache
key — so dragging the slider over a board full of ink does not re-rasterise every stroke
on every frame to produce pixels that differ by a constant the compositor applies for free.

A document written before opacity existed has no field at all; every object in one is
meant to be fully opaque, so the missing case and the malformed case both land on 1.

### Text

The text tool is an action, not a mode: click **T** and a ready box appears in the
middle of the view with the word *Textbox* selected, so typing replaces it immediately.
Double-clicking an existing box reopens it. Double-clicking empty canvas deliberately
does nothing — it used to place a box, which meant every mis-aimed double-click left a
stray empty one behind.

Text has no frame around it. It is lettering on a board, not a form field, so there is
no box while you type — the caret and the floating controls are the only chrome.

The controls appear beside the box itself, the way Arc does it, because text size is a
property of the thing you are looking at:

| | |
|---|---|
| **Aa** | typeface list, each row previewed in its own face |
| **Body** / **H2** / **H1** / **H0** / **Ultra** | opens Arc's five paragraph styles — 32, 52, 80, 120 and 180px. The button is labelled with the size the box is currently on, or **··** when it is on none of them |
| **▮** | the highlighter |

Both lists are the same popup. The five styles used to sit inline as five buttons down
the side of the strip, which made the strip taller than most of the boxes it annotated
and put a wall of labels next to text you were trying to read. **Aa** had already solved
that for typefaces, so sizes borrow the solution.

The highlighter is Arc's `contentHugging` fill: a block drawn per line, sized to that
line's measured width rather than the object's box, so it reads as marker over the words
instead of a coloured panel behind the paragraph. The lettering flips to black or white
for legibility against whichever swatch you picked.

All of these apply live to the selected box, including while you are typing in it.

Available typefaces are the ones Arc itself uses in Easels, limited to those that are
openly licensed: **Inter**, **Nunito**, **EB Garamond**, **Inconsolata** and
**Space Mono**, plus your system font. Arc's other Easel faces — ABC Favorit, ABC
Oracle, GT Ultra, Söhne, Pitch, National 2, Marlin, New York — are commercial and are
not redistributable, so they are not bundled. See [fonts/LICENSE.md](fonts/LICENSE.md)
if you own a licence and want to add one.

### Board background

Right-click empty canvas for the background swatches. The choice is saved per easel, so
different boards can look different. **Follow theme** is the default: it has no colour of
its own and tracks Zen between light and dark mode, so a new easel comes up already
matching the browser and keeps matching if the scheme changes under it. The grid contrast
is derived from whatever the board actually ends up painted, so dots stay visible on a
light background and a dark one alike. **Arc** is one click away: a pale multi-colour
wash rather than flat paper, which is most of why Arc's boards read as soft.

Every board is a **tint, not a fill**. All nine presets carry an alpha, and nothing
between the board and Zen's window paints: `.easel-root` and the page's own `<body>` are
permanently transparent, and `.easel-viewport` is the single painter of the board's
colour. What you get is the window wearing the board's colour rather than a sheet of
paper covering it. **Transparent** is the end of that scale — the one board that
declines to tint at all.

Whether that is literally see-through is up to Zen, not to this mod: it needs
`browser.tabs.allow_transparent_browser` set to `true` in `about:config`, which Zen's
transparency themes already do. Without the flag the tint composites against the
window's own colour, which still looks deliberate. The flag is deliberately not set
here — it affects every tab in the browser, not just this page, and that is not a
decision an easel background should be making on your behalf.

Three things need the colour with the alpha taken off, and each preset carries an opaque
`swatch` for them: the menu dot (an 18px disc at half alpha reads as no colour at all), a
rasterised export or library thumbnail (a PNG in another app has no Zen window behind it
to tint), and the canvas-painted chrome — web-card bodies and selection handles — which
would otherwise be holes onto the board.

Transparent replaces the old **Sage** swatch; boards saved on Sage move across to it
automatically the next time they are opened.

### Chrome that follows the board

The topbar, the toolbar, the popups and the context menu are the **active board's colour
at a heavier alpha**, not a fixed panel grey. Switching from Paper to Ink carries the bar
with it instead of leaving a light strip parked on a dark board, and because the chrome
keeps an alpha of its own, the wallpaper behind Zen reads through the whole window rather
than stopping at the topbar.

`_applyBackground` in `modules/canvas.uc.js` is the single place this is decided. It
writes three things onto the `<zen-easel>` host: `--easel-tint` (the board's channels,
which `--easel-panel` re-alphas), `--easel-solid` (the same colour opaque, which the
renderer paints with), and `data-easel-ink`. That last one exists because the chrome's
ink has to follow the *board*, not the OS — a Slate board under a light system theme
still needs light text, and `light-dark()` cannot say so because it is answering a
different question. It is named for the decision rather than toggled so that "no board
applied yet" stays its own state, and the stylesheet falls back to the OS scheme for the
frames before the first board lands.

The **transform handles** flip on the same switch. They are the one piece of selection
chrome that must *not* be the board's colour — a grip painted in the board's own tint is
a grip you cannot see — so `--easel-handle` lands one step brighter than the board in
both directions: white over a light board, a lifted neutral (`#40404a`) over a dark one,
with the accent ring doing the delimiting. White grips on a dark board would be the only
light-scheme thing left once the chrome has flipped, and read as glare against Ink or
Black. Both values are set by media query rather than `light-dark()`, because the
renderer reads them through `getComputedStyle` to paint on a canvas and an unregistered
custom property hands back the literal `light-dark(…)` token, which `fillStyle` cannot
parse.

### Alignment guides

Objects snap to **each other**, not to a grid — the six axes Arc uses: left edge,
centre and right edge horizontally, top edge, centre and bottom edge vertically. A thin
line shows what you lined up with. This is most of why an Arc board looks tidy without
anyone having tidied it: a grid aligns things to the page, and what you actually want is
for them to align to one another.

Two gates keep it from getting in the way. A match only counts within 6 screen pixels,
so the pull feels the same at every zoom; and a fast drag does not snap at all, so
flinging a card across the board does not stutter past every object on the way. Hold
`Alt` to suppress it entirely.

Grid snapping is still available — set **Snapping** to *Grid* in the mod's settings.

### Live web cards

A capture is a screenshot. **Point at the card** and a bar fades in over its bottom edge —
the site's icon, its title, a **▶** button and an **↗** button. Press **▶** and the pixels
are replaced by the real page, cropped to exactly the region you captured, and you can
scroll-free interact with it in place. The button becomes **❚❚**; press it again and the
screenshot comes back. **↗** opens the source page in a tab. (Both live controls are in the
right-click menu too, as **Show live website** and **Show screenshot instead**.)

A card you are not pointing at is just the picture, edge to edge — which is why the bar
appears on hover rather than sitting there permanently. It works the same over a running
site as over a screenshot: a live tile does not take the mouse until you click it, so
pointing at one still reaches the board underneath.

**Click a live card once and the pointer belongs to the page inside it** — the weather
widget's day tabs, a dashboard's filters, a video's controls all work, because it is the
real site. The bar disappears for as long as the site has the pointer, and the card is
outlined instead. `Escape` hands it back to the board, and the bar comes back with it.

Since the tile takes the mouse once activated, one thing is deliberately routed around it:

- **Right-click always gets the easel's menu**, not the website's, so "Show screenshot
  instead" is never out of reach.

Dragging a live card needs nothing special: until you click it, the tile is transparent to
the pointer, so pressing anywhere on the card and dragging moves it exactly as a screenshot
would.

This is the one part of the mod that touches the network, so it is worth being precise:

- **It is opt-in per card**, behind a one-time explanation, and remembered per object.
- **Cards always open as screenshots**, every time, whatever is saved. Live is entered
  only when asked, and at most twelve at once by default (`live.max-tiles`; `0` for no
  cap). The cap is per *window*, not per board.
- **A live card loads the site with your normal cookies and session**, exactly as a tab
  would — that is what makes a logged-in dashboard show your data rather than a login
  screen. Set `zen.easel.live.private` or point `live.container` at a container if you
  would rather a board did not carry your session around.
- **A live card keeps running.** Scrolling it off the board, opening another easel,
  switching tabs and minimising the window all stop it *painting*; none of them stop it
  running. That is the point — a dashboard is no use if it is stale by the time you look
  back at it — but it does mean a board you are not looking at can still be running
  websites, which is what the count in the top bar is for.
- **A card out of sight for thirty minutes stops on its own**
  (`live.idle-timeout-min`, `0` to disable). The cap bounds how *many* run at once; this
  bounds how long one runs unattended, which is a different problem — you can sit well
  under the cap and still have a logged-in dashboard holding a content process open
  because you scrolled past it before lunch. Only invisible cards age: one on screen is
  being looked at and one making sound is being listened to, so neither times out however
  long it has been there. A card that does times out reverts to its screenshot, and a
  click starts it again — nothing is lost.
- **Audio follows what a background tab does**: a card that was already playing keeps
  playing when it stops painting, and a silent one is muted so nothing can start talking
  from a board you cannot see. **Mute this card** in the right-click menu overrides that
  per card and is saved with the board.
- `zen.easel.live.enabled = false` is a hard off switch: no `<browser>` is ever created.

### Stopping one

Three ways, because a card whose board is closed cannot be reached by the first:

- The **❚❚** button in the card's own bar, which appears when you point at it — for a web
  tile too, which never used to have one because it was always stopped for you.
- The **live count** in the top bar. It reports everything running in the window,
  including cards on boards you do not have open; click it to stop one, or **Stop all
  live cards**. This is the only route to a card whose board is closed.
- Closing a board's tab stops that board's cards, and so does reloading it with `Ctrl+R`
  — a reload starts the board over, websites included, rather than readopting the content
  processes it had a moment earlier. Deleting a board stops its cards, and closing Zen
  stops everything.

The line between the two behaviours is *the page went away* versus *you looked elsewhere*.
Switching tabs, opening another board and minimising the window are the second kind and
stop only the pixels. Unloading the page — closing its tab, reloading it, navigating it
away — is the first, and takes the websites with it.

Inside a live card, scrolling and text selection are disabled — it is a fixed view of
one region, and letting it scroll would just break the crop. Clicking a link opens a
normal new tab rather than navigating the card away from what you captured.

Only cards captured since this version carry the geometry needed to go live; older ones
simply do not offer it.

A card that ends up without that geometry looks exactly like one that has it, so the
difference is only visible by right-clicking and finding no **Show live website**. When it
happens the browser console says why — see the warnings from `capture-host.uc.js`.

### Escape

`Escape` walks a cascade rather than closing straight away: it steps out of a live card,
then cancels an in-progress drag, then drops back to the select tool, then clears the
selection.

### Chrome over live cards

A live tile is a `<browser>` in the browser window, sitting above this page's whole
content area. It is not in the page's z-order at all, so the toolbar, the topbar and every
panel that hangs off them were simply buried by any card that happened to overlap them —
no `z-index` in the stylesheet can win an argument between two different documents.

Menus solve this by lowering the tile (see below). That is not an answer for the toolbar,
because the toolbar never goes away: a card sitting over the bottom-left corner would stop
being live for as long as it stayed there.

So the tile stays up and **a hole is cut in the layer** where each piece of chrome is. The
pixels in a hole come from the page underneath, which is the chrome, drawn over the canvas
exactly as it always was. The page measures — they are its elements, and it is the only
side that knows when one appears — and the host cuts, with a single `clip-path` on the
layer: an outer ring the size of the layer, then one rounded-rectangle subpath per hole,
under the even-odd rule.

Two things about that are worth knowing.

**The hole list is a selector list**, in `live-layer.uc.js`. Anything not currently showing
measures as a zero rect and is skipped, so the list carries no state — a new panel is
covered by adding a line to it. `.easel-menu` is deliberately absent; see below.

**Two holes that overlap cancel each other out.** Under the even-odd rule a point inside
two of them has crossed an odd number of edges and counts as inside the shape again, so the
overlap comes back as painted layer — a hairline of live website lying across whatever two
pieces of chrome met there. One layout really does that: `.easel-list` and
`.easel-live-panel` are positioned 34px below a button that is itself a few pixels down
from the top of a 44px bar, so they begin two or three pixels above its lower edge. The
rects are made pairwise disjoint before being sent, by shrinking the later one when the
intersection is a clean band along one of its edges — which is exact, because that band is
already inside the earlier hole — and by merging into a bounding box when it is not, which
cuts out slightly more than the two panels cover rather than risk cutting out less.

The chrome's own drop shadow and backdrop blur stay in the page, so a toolbar over a live
tile blurs the board behind it rather than the website, and its shadow stops at the edge of
the hole. That is the visible cost of the approach and it is a small one.

One more thing follows from painting being on demand: opening a popup moves nothing on the
board, so nothing would schedule the frame that would notice it. The few places that show
or hide a panel call `chromeChanged()` on the page element, which re-measures immediately.

### Menus over live cards

A live tile is a real `<browser>` owned by the browser window, sitting above the easel
page's entire content area — so nothing drawn *inside* the page can be on top of one.
Right-clicking a live card therefore put the easel's own menu behind the website.

The menu cannot be raised, so the card is lowered: any tile the menu overlaps is hidden
while it is open, and the canvas paints that card's screenshot again underneath. Only
the tiles actually covered, so right-clicking empty board does not make every live card
on screen blink. The site keeps running throughout — it is hidden, not unloaded.

Menus keep this treatment rather than getting a hole cut for them. A hole would be the
lighter answer — nothing hidden, nothing repainted — but suppression is the proven path
and a menu is transient enough not to need it.

### Web tiles

A live card is a screenshot you can turn into the real site. A **web tile** is Arc's other
object — `webBrowser` — which is the real site from the start: no screenshot, no crop, just
a window onto a page sitting on the board. Right-click empty canvas and choose **Add a web
tile…**. It stays a frame until you click it, then loads.

Unlike a live card it **scrolls**, text in it can be selected, and forms in it submit —
those locks exist to protect a crop, and a web tile has no crop to protect. Links still
open in a real tab, and it counts against the same three-tile cap.

**YouTube links become players.** Paste or drop one — a `watch?v=`, a `youtu.be` short
link, a `/shorts/`, a `/live/` — and you get a web tile pointed at the embed player,
sized 16:9, with a `t=` timestamp carried across if the link had one. That is a URL
rewrite and nothing more: no new object type, no player of our own, just the tile
machinery that already existed pointed somewhere better. A watch page inside a 560px
tile is mostly sidebar. Arc reaches the same place by the same route — its Easel YouTube
support runs through `YouTubePlayerKit`'s bundled `YouTubePlayer.html`, an IFrame player.

It is the one load in the mod that sends a `Referer`, and that is not decoration. The
embed player refuses to configure itself for a request that does not say who is
embedding it: with no such header it answers
`ERROR_CODE_EMBEDDER_IDENTITY_MISSING_REFERRER`, which the player renders as *"Error 153
— Video player configuration error"*. Nothing supplies one on its own here, because a
tile is a top-level document rather than an iframe inside a page.

So a YouTube tile — and only a YouTube tile, matched on the exact URL shape this mod
builds — is loaded with a referrer of `http://localhost/`. That value is a deliberate
choice rather than a plausible-looking stand-in: the header names whoever is doing the
embedding, and anything else would be this mod telling YouTube it is a website it is
not. `localhost` says the true thing, which is that a local application is asking.
Passing the video's own page does not work either — YouTube refuses itself with
`ERROR_CODE_EMBEDDER_IDENTITY_DENIED`.

Worth noting what this means for the rewrite's original rationale. Watch pages declining
to be framed is an `X-Frame-Options` problem, and a live tile is a top-level browsing
context in its own `<browser>`, never a frame — so that protection never applied to it.
The rewrite is kept for the layout reason alone, and the embedder-identity check is the
price it turned out to carry.

### Animated images

GIFs animate, and they are the one thing on the board that is **not** painted to the
canvas. That took three attempts, so it is worth recording why.

`ctx.drawImage` paints an image's *current* frame, and an image only has a current frame
while Gecko is ticking it — which it does for images it is **laying out**, driven by the
frame that displays them. An `<img>` built solely to be a drawImage source has no such
frame and stays on frame 0 for ever. A hidden-but-rendered 1px holder did not convince
the engine otherwise. Decoding every frame through `ImageDecoder` and running our own
clock would have sidestepped the question entirely, but `ImageDecoder` is not reliably
available in this build.

What does work is the boring answer, and it is the one `zen-library` was already using in
its media grid: put a normal `<img>` in the page and let it be displayed. So animated
images live in a DOM layer, positioned over the board each frame and rotated with a CSS
transform, and the canvas skips them.

That layer sits **below** the canvases:

```
viewport background (grid + wash)
  → media layer        ← animated images
  → static canvas      ← every other object
  → active / overlay canvas
```

so a GIF covers the grid, as an image should, and everything on the board draws over it.
The ordering is deliberate: an easel is a thing you annotate, so a shape or a caption
placed on top of a GIF has to be visible. The cost is that a GIF cannot be brought in
front of another image, which is much the rarer want.

It is also cheaper than painting. The compositor animates these for free, so nothing
drives a repaint — where the canvas route would have meant redrawing the whole static
layer twenty times a second for as long as a GIF was on screen. Exports and library
thumbnails still go through the canvas and get the first frame, which is what a still
should be.

### Exporting

Right-click empty canvas for **Export as PNG…** or **Export as JPEG…**, or press
`Ctrl`+`Shift`+`S`. The whole board is rendered at full resolution, framed to its contents,
and live cards and web tiles are exported as their screenshot or frame — the file is a
picture of the board, which is the only thing an easel can sensibly be exported as. Arc
does the same, and exports JPEG.

### Reflowing with the window

Arc's canvas is `verticallyScrolling`: the document has no width of its own — it *is* the
width of the window, and the board is relaid out whenever that changes. This mod's own
model is a fixed 3600-unit page with fit-width as the zoom-out limit. At fit-width the two
are indistinguishable; they part company when you resize.

Both are available, per easel, from the canvas right-click menu — **Fit the board to the
window**. It is on by default for new easels: a board that is exactly the window is what
opening a blank easel should give you, and the fixed sheet only earns its keep once there
is enough on the board to want a page wider than the view. Boards saved before this
default changed keep the fixed page they were drawn on, and either mode is one click away
on any board. Switching adopts the current width as the layout width, so nothing moves at
the moment you switch; from then on the board scales with the window, keeping every
object's position and size relative to the page, the way Arc's does.

This is the whole of what "Arc uses a different canvas setup" amounts to, and it is
already here. Arc's easel is native AppKit — `EaselCanvasViewController`, one `NSView`
per object — and there is no rendering engine in `Arc.app` to port: the only JavaScript
in `ARC_EaselUI.bundle` is a 1.4KB `DisableInlineLinks.js` that forces links inside an
easel's web view to open in a new tab, which this mod already does more robustly in
`ZenEaselLiveChild` (system event group, so a page calling `stopPropagation` cannot get
underneath it; Arc's is a plain capture listener on `document.body`). A view-per-object
tree would be slower here than the three-canvas split, which is the reason extending a
4000-point stroke does not repaint the board. So: nothing to port, and nothing gained by
trying.

### Dropping things on the canvas

Drag an image file onto the canvas to place it (PNG, JPEG, WebP, GIF and AVIF). Drag a
tab, a link, or a URL to get a link card you can double-click to open. Dropped plain
text becomes a text box.

Link cards are filled in from what the browser already knows — if the URL is open in a
tab, its title and favicon. Arc fetches the page and parses its `og:` tags; that is
deliberately not done here, because it would mean the mod issuing a request for an
arbitrary stored URL from a privileged page, with your cookies attached and no CORS in
the way.

### Touchpads

Windows precision touchpads work with no extra setup: two-finger scroll pans and pinch
zooms, because Gecko already delivers those as `wheel` and `Ctrl`+`wheel` events. There
is no gesture-specific code anywhere in this mod.

---

## Where your easels live

```
<profile>/zen-easels/
  index.json                   which easels exist, and which was open last
  easels/<id>.json             one document: objects, background, saved viewport
  easels/<id>.thumb.png        card thumbnail for the library
  assets/<id>/<uuid>.png       captures and dropped images
```

Set `zen.easel.storage-dir` to keep them somewhere else.

Unreferenced assets are swept once a day, on idle, with a 24-hour grace period so a
file written moments ago is never collected before the object referencing it is saved.
`.tmp` files left by an interrupted write and asset directories whose easel is gone are
swept the same way.

Documents are written atomically through a temp file, so a crash mid-write leaves the
previous good copy intact rather than a truncated one. Changes are flushed 500ms after
you stop working (tunable via `zen.easel.autosave-ms`), when you close the easel, and
again during shutdown via an AsyncShutdown blocker.

Images are handed to the renderer as `blob:` URLs rather than `file://` ones. Profile
paths routinely contain spaces and parentheses, and every `file://` URL built from one
is a quoting bug waiting to happen.

---

## Settings

In Zen's mod preferences, or directly in `about:config`:

| Pref | Default | |
|---|---|---|
| `zen.easel.shortcut.new` | `Ctrl+Shift+E` | open the easel (restart to apply) |
| `zen.easel.shortcut.capture` | `Ctrl+Shift+2` | capture a region (restart to apply) |
| `zen.easel.wheel` | `zoom` | `zoom` or `pan`; `Ctrl`+wheel zooms either way |
| `zen.easel.ink-style` | `variable` | `variable` thins with speed and follows stylus pressure; `uniform` is a constant width |
| `zen.easel.grid` | `dots` | `none`, `dots` or `lines` |
| `zen.easel.snap` | `guides` | `guides` (to other objects), `grid`, or `none`. Hold `Alt` to suppress |
| `zen.easel.grid-size` | `24` | canvas pixels, for `snap: grid` |
| `zen.easel.live.enabled` | `true` | off means no easel ever loads a website |
| `zen.easel.live.max-tiles` | `12` | how many cards may be live at once, per window; `0` for no cap |
| `zen.easel.live.idle-timeout-min` | `30` | stop a card after this long out of sight; `0` for never |
| `zen.easel.live.reveal-delay-ms` | `140` | pause before showing live cards again after a tab switch; `0` for none |
| `zen.easel.live.private` | `false` | load live cards in a private session |
| `zen.easel.live.container` | `0` | container ID for live cards; `0` is your normal session |
| `zen.easel.live.allow-http` | `false` | allow live cards over plain http |
| `zen.easel.autosave-ms` | `500` | delay after the last change |
| `zen.easel.storage-dir` | *(empty)* | empty means `<profile>/zen-easels` |
| `zen.easel.debug` | `false` | `[zen-easel]` logging in the Browser Console |

`Ctrl+Shift+E` is also the DevTools Network Monitor while DevTools has focus. Rebind it
if that gets in your way.

---

## How it is built

The mod runs in three places, and which one a file belongs to is the main thing to know
when reading it.

**Once per process** — `background/`. Registration is process-global, so it cannot live
in a per-window script: the first window would succeed and every window after it would
throw, and unregistering on window close would tear the feature out from under every
window still open.

| | |
|---|---|
| `background/registry.sys.mjs` | registers `about:easel`, and installs the actors at boot |
| `background/actors.sys.mjs` | what the two window actors are, and how to install them |
| `background/store.sys.mjs` | owns the disk: index, write queue, shutdown blocker, asset sweep |
| `background/validate.sys.mjs` | the URL/id/asset-name rules, shared by everything |

**In the browser window** — the parts that genuinely cannot live in a page.

| | |
|---|---|
| `ZenEaselHost.uc.js` | toolbar button, shortcut, opening/focusing the easel tab, the bridge |
| `modules-host/capture-host.uc.js` | region picker over Zen's chrome, `drawSnapshot` |
| `modules-host/screenshot-hook.uc.js` | "Move to easel" inside Zen's screenshot preview |
| `modules-host/live-host.uc.js` | the live tiles themselves — `<browser>` elements, the layer over the easel tab, load watching |
| `modules-host/split-resize.uc.js` | not an easel feature: fixes a Zen split-divider bug where mouse events from an in-process about: page arrive in that page's coordinates, so the divider snaps and the panes strobe. Behind a setting, and meant to be deleted once Zen fixes it upstream |

**In the page** — `about:easel` itself, a system-principal chrome document in the parent
process.

| | |
|---|---|
| `page/easel.xhtml` | the document: CSP, title, favicon, stylesheet, boot script |
| `page/easel-boot.js` | the loader of record, at parse time |
| `page/easel-page.uc.js` | the `<zen-easel>` element and the page controller |
| `modules/objects.uc.js` | object model, validation, hit-testing, palette |
| `modules/renderer.uc.js` | canvas painting, culling, stroke bitmap cache, text wrapping |
| `modules/freehand.uc.js` | variable-width stroke geometry |
| `modules/guides.uc.js` | Arc's six alignment guides |
| `modules/live-layer.uc.js` | live web cards and web tiles: which are live, the cap and its LRU, crop geometry, activation |
| `modules/text-editor.uc.js` | the textarea shown while editing a text box |
| `modules/store.uc.js` | the page's view of the store: open document, blob cache, debounce, thumbnails |
| `modules/canvas.uc.js` | viewport transform, input, selection, undo, the title heading, export |
| `modules/tools.uc.js` | toolbar, palette, context menu |
| `modules/capture-page.uc.js` | placing captures, drops, file import |
| `modules/library.uc.js` | easel switcher |
| `actors/` | the two JSActor pairs — see below |
| `fonts/` | Arc's openly licensed Easel typefaces |

### Why `about:easel` is registered the way it is

`background/registry.sys.mjs` maps `about:easel` onto `page/easel.xhtml` with the flags
`ALLOW_SCRIPT | IS_SECURE_CHROME_UI`, following Firefox's own `AboutDevtoolsToolbox`.
What is *absent* from those flags is the mechanism: with no `URI_MUST_LOAD_IN_CHILD` or
`URI_CAN_LOAD_IN_PRIVILEGEDABOUT_PROCESS`, `ChromeUtils.predictRemoteTypeForURI` returns
`NOT_REMOTE` and the page is pinned to the parent process — which is where it has to be,
because it uses `IOUtils` for storage and creates the privileged `<browser>` elements
live cards are built from. And with no `URI_SAFE_FOR_UNTRUSTED_CONTENT`, an ordinary web
page cannot navigate anything to it.

If that registration ever fails, `ZenEaselHost` falls back to loading the same file at
its `chrome://` URL. The cost is an ugly address bar, not a broken feature.

### The page ↔ window seam

The page reaches the browser window through `window.browsingContext.topChromeWindow` —
same process, same principal, so a direct object handle rather than IPC. The traffic is
deliberately one-directional: the page holds the window, the window never holds the
page, because a chrome-window reference to a page object would keep that page's
compartment alive after its tab closed. When the host needs a page it walks
`gBrowser.tabs` and looks it up afresh. Everything that crosses is a plain string,
number or byte array.

The write queue lives in the background module for a related reason. When the easel was
an overlay, `close()` was guaranteed to run and could await the final write. A tab has no
such guarantee — `pagehide` cannot await — so `pagehide` only serialises the document
into the queue, and that queue's `AsyncShutdown` blocker owns the guarantee from there.
It also means two easel tabs cannot race each other on `index.json`.

### The two actors

| | |
|---|---|
| `ZenEaselCapture` | measures the viewport and crop rect inside the page being captured |
| `ZenEaselLive` | the scroll lock, selection lock and link interception inside a live card |

`ZenEaselLive` is scoped by `messageManagerGroups: ["zen-easel-live"]`, matching an
attribute only `live-host.uc.js` sets, so it attaches to live tiles and to nothing else
in the browser. Its input listeners are registered in the system event group, so a page
calling `stopPropagation()` cannot get underneath them.

`ZenEaselCapture` has to reach ordinary tabs, so its group is the default `browsers` —
but it declares no events and no observers, which means the child is never instantiated
until the parent calls `getActor()`. At rest it costs nothing and sees nothing.

**Everything is painted to canvas, across three layers.** This follows the split
Excalidraw uses:

```
static    committed objects · repainted when the scene or viewport changes
active    the object under the pointer right now · repainted every frame
overlay   selection outlines, handles, marquee · screen space, no world transform
```

The split is the whole point. Extending a stroke touches only the active layer, so a
long scribble costs the same per sample as a short one; before this, every sample
re-laid-out every object on the board. Dragging a selection moves those objects to the
active layer too, so it costs O(selection) per frame rather than O(scene).

**Hit-testing runs in JavaScript against the model**, with a zoom-aware tolerance —
never through DOM dispatch. That was true under the old DOM renderer as well, and it is
why dropping the DOM cost nothing here.

**Text is painted like everything else**, with a real `<textarea>` positioned over the
canvas while a box is being edited (the canvas skips that object meanwhile, so there is
exactly one visible copy). Arc's `EaselCanvasViewController` owns one view controller
per object, and the object taxonomy here — text, shape, ink, image, webcard — follows
the types named in Arc's binary.

### What makes it feel responsive

- **One rAF-throttled paint.** Input handlers mutate the model as fast as the device
  reports; painting happens once per frame however many events arrived. A 1000Hz mouse
  used to run a full layout pass ~16 times per displayed frame.
- **Preferences are cached** behind a `Services.prefs` branch observer. Snapping used to
  do two XPCOM reads per object per pointer event.
- **Offscreen objects are culled** against a padded viewport rectangle.
- **Committed strokes are rasterised once** and blitted afterwards, keyed on geometry,
  colour and zoom — Excalidraw's `elementWithCanvasCache` idea. Deliberately not keyed
  on position, so moving a stroke reuses its pixels.
- **Zoom is proportional to scroll distance**, with the step widening as you zoom in and
  damped for the small deltas trackpads emit. A fixed multiplier per notch is what made
  zooming feel steppy.
- **Ink consumes coalesced pointer events**, so throttling to one frame does not
  straighten fast strokes.

**The screenshot integration reaches two of Zen's three surfaces.** They are not equally
reachable, and the difference decides the UX:

| Surface | Where it lives | Reachable |
|---|---|---|
| Buttons panel (*Save visible / full page*) | `MozXULElement` in the chrome document, open shadow root | yes — its class is defined per window, so patching `connectedCallback` catches every instance |
| Preview dialog (*Copy / Download*) | Lit element in a tab dialog | yes — via the document it loads |
| Region bar (*Copy / Download* under a dragged selection) | `insertAnonymousContent()` in the **content process** | **no** — chrome has no handle to another component's anonymous content |

Because the region bar is out of reach, picking an easel from the buttons panel *hands
off* instead: it calls `ScreenshotsUtils.exit()` to dismiss Zen's overlay, waits for that
to land in the content process, and starts this mod's own region picker, which is
chrome-side and already drops captures onto easels. Same capability, one extra step, no
dependency on Firefox internals beyond `exit()`.

Two constraints shape the injected UI. The preview dialog's CSP is `default-src chrome:`,
which blocks an injected `<style>` — so every style is set as an element property, and
the menu is built the same way on both surfaces to stop them drifting apart. And the
preview's `blob:` URL is created inside `ScreenshotsUtils.sys.mjs`, so rather than argue
about which global may read it, the pixels are re-encoded from the `<img>` the dialog has
already loaded.

**Region capture runs in the parent process.** Selection is a chrome-level overlay, not
a content script, so it needs no frame script, ignores page CSP, and still works on
`about:` pages and in the PDF viewer. Pixels come from
`WindowGlobalParent.drawSnapshot` — the same privileged path Firefox Screenshots uses.
The whole viewport is snapshotted and cropped locally, because a sub-rect would have to
be given in document coordinates, which means knowing the content's scroll offset,
which from the parent process means standing up a JSActor for nothing. The true scale
is measured from the returned bitmap rather than assumed from
`devicePixelRatio × fullZoom`, so HiDPI and page zoom correct themselves.

---

## Security and privacy notes

Worth stating plainly rather than leaving implied:

- **Every stored URL passes one gate.** `safeExternalUrl` in `background/validate.sys.mjs`
  is the only place a URL is accepted: `http`/`https` only, no embedded credentials,
  length-capped, and what gets written to disk is the canonical spec, so it is
  re-validated on every load rather than trusted because it was checked once. Opening a
  card uses a **null** triggering principal, not the system principal — two independent
  controls, either sufficient on its own.
- **Asset names and easel ids are validated where paths are built**, not only where they
  are read, and `.svg` is deliberately not an accepted image format: these names end up
  in `createObjectURL` and then an `<img>`.
- **The page has a restrictive CSP, and no `frame-src` at all.** `connect-src 'none'` means
  no `fetch`/XHR can be added later without the policy being edited first, and the absence
  of `http:`/`https:` from `img-src` makes the local-favicons-only rule an engine guarantee
  rather than a convention. The page frames nothing, because it *cannot* — see below — so
  no network of any kind originates from it. It also listens for `securitypolicyviolation`
  and logs it, because a CSP refusal is not an error anywhere else in the platform: the
  load is simply cancelled with no error page, which is exactly how one went unnoticed.
- **Live cards never run web content in the parent process.** The `<browser>` is declared
  remote before it is inserted, and the site is loaded only after the frame loader has
  actually been created and `isRemoteBrowser` checks out; if it fails the element is
  removed and the card stays a screenshot. The sequence follows Firefox's own nested remote
  browser, `inline-options-browser.mjs` — including waiting for `XULFrameLoaderCreated`
  rather than assuming `browser.clientTop` is enough. Forcing the binding to apply is not
  the same as a content process existing.
- **A live tile is a `<browser>` in the browser window, not in the easel page.** This is
  the one piece of the architecture that is not a choice. `about:easel` is a
  system-principal chrome document and Gecko refuses to load web content inside one, in
  every form: a plain `<iframe>` and a XUL `<iframe type="content">` both sit on
  `about:blank`; `<browser type="content">` returns `NS_ERROR_CONTENT_BLOCKED` from the
  docshell; and `<browser type="content" remote="true">` gets a null `frameLoader.remoteTab`
  and fires `oop-browser-crashed`, because `remote="true"` asks for a top-level remote
  frame and Gecko only grants that to a chrome embedder. The `about:addons` precedent this
  was originally designed around does not transfer — extension options are remote content
  inside a remote page, which is ordinary Fission.
- **Residual risks, not papered over:** there is no per-`<browser>` popup or download
  switch in Gecko, so a live card retains those capabilities. A live card runs its scripts
  from the moment it loads — an earlier version left JavaScript off until the card was
  clicked into, but a card whose scripts are off is not live in any sense a person would
  recognise.

  This used to be bounded largely by impermanence: cards were capped at three, torn down
  when they scrolled out of view, and torn down entirely when the easel tab went to the
  background. Making them persist removes two of those three, and it is worth being blunt
  that this widens the exposure rather than pretending the replacement is equivalent. A
  card can now be loaded with your session, running scripts, on a board you are not
  looking at, in a window you have minimised.

  What bounds it instead:

  - Live is still opt-in per card, behind the same one-time explanation, and cards still
    always open as screenshots — nothing goes live because a file said so.
  - The cap is now per window rather than per board, which is a stricter reading of the
    same number, and it is enforced before the `<browser>` is created.
  - **A card out of sight for thirty minutes stops itself.** Persistence is for the board
    you came back to, not the one you forgot about, and this is what keeps "until you stop
    it" from meaning "until you quit Zen" in practice.
  - Every running card is **counted and reachable**. The top-bar census lists everything
    alive in the window with the board it belongs to, and **Stop all live cards** returns
    that to zero. Nothing can run that the user cannot see and stop, which is the property
    the old teardown provided by accident and this provides on purpose.
  - Closing the easel tab, or the window, stops everything.
  - Background cards are muted unless they were already playing, so nothing can make noise
    from a board with no tab to trace it to.

  One genuine cost with no mitigation: a live card keeps its content process at foreground
  priority for as long as it runs, because `ProcessPriorityManager` keys off the active
  `BrowserParent` and the tile is deliberately kept active. N background cards are N
  processes the OS will not deprioritise. That is the price of the feature working at all,
  and the cap is the only lever on it.

---

## Not in this version

The Easels-&-Notes sidebar as Arc has it, and custom background colours beyond the
presets.

Rotation is in, with two deliberate limits. A multi-selection's transform box stays
square while its contents turn — a tilted box would not contain what it claims to, and
Excalidraw makes the same call. And an object's bounding box, which the marquee and
zoom-to-fit are measured against, is the unrotated one, so a rotated object's corners
can fall slightly outside it.

Also not done yet, and honestly incomplete rather than deliberately excluded:

- **In-easel search.** Arc has a find tool for the board itself
  (`SearchPopover`, behind its `easel-search-tool-enabled` flag). There is none here.
- **Arc's `video` and `richText` objects.** Both are real Arc object types. Neither has an
  obvious way in from Zen yet, so neither is implemented.

Sharing and collaboration are not planned at all — being local-first is the point.

**Two deliberate divergences**, worth stating rather than leaving to be discovered:

- Arc's font picker offers four semantic slots (`mono`, `fancy`, `hip`, `clean`) mapped to
  faces that are mostly commercial. This one offers the five openly licensed faces Arc
  ships, by name.
- Arc's stored shape enum is `rectangle`, `circle`, `arrow`, `freehand`; its toolbar icon
  set also includes triangle and line, which is the set implemented here.

Known limits:

- `drawSnapshot` may return only the top-level document on pages with out-of-process
  iframes, so a capture over a cross-origin embed can come back blank in that region.
- Favicons are only kept when they are already local (`page-icon:`, `data:`). A remote
  icon URL is dropped rather than fetched, so some link cards show no icon.
- `supportsUnload` is off: changes to the mod need a Zen restart.

## Credit

Feature design is Arc's, by The Browser Company. This is an independent reimplementation
for Zen with no Arc code in it.

The renderer's structure — three canvas layers, a per-element bitmap cache, the
rAF-coalescing throttle, and the proportional zoom curve — is modelled on
[Excalidraw](https://github.com/excalidraw/excalidraw) (MIT). The variable-width stroke
geometry is an independent implementation of the approach described by
[perfect-freehand](https://github.com/steveruizok/perfect-freehand) (Steve Ruiz, MIT),
which is what Excalidraw uses. No code from either project was copied.
