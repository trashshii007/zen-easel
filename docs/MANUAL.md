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

Open an easel with the toolbar button, or from the **Easels** section of the Zen Library
(the button beside the workspace indicator in the sidebar).

Every easel opens with a **centred heading** at the top, ready to type into. It is a real
text box — move it, restyle it, colour it — and it *is* the easel's name: rename it here
and the tab, the switcher and the library card all follow; rename it in the library and the
lettering on the board changes to match. This is how Arc does it (`titleObjectID`), and it
is why an Arc board never needs a title bar. Delete it and the easel keeps its name; to get
one back, right-click any text box and choose **Use as easel title**.

Captures always keep the source URL, so double-clicking a card later takes you back to
the page it came from. The shape is always the same — take the picture first, then say
where it goes — and there are two ways in:

- **A dragged region.** Zen's own screenshot button or keybinding. Drag a selection
  and the bar that appears under it carries **Easel** beside Copy and Download.
- **After *Save visible page* or *Save full page*.** The preview that follows has an
  **Easel** button beside Copy and Download.

Either one opens the same menu: your three most recently used boards, then *New Easel*,
then *See all easels…* if there are more. Nothing is captured until a destination is
picked, so backing out of the menu leaves the selection exactly where it was.

Zen's overlay does the selecting, which is why there is no picker of this mod's own any
more. That is a straight gain: it highlights the element under the pointer, gives the
selection resize handles, and scrolls the page when a drag reaches the window edge —
none of which the picker that used to live here ever grew.

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
| Re-take a live card's picture | the circular arrow in its bar | — |
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
Number keys `1`–`9` and `0` pick the first ten standard colours directly; the eleventh is
in the picker. All of these apply to the selection as well as setting the default —
see **Colour** and **Opacity**.

### Colour

The colour button opens a **wheel**, not a fixed grid: hue is the angle, saturation the
distance from the centre, and **Brightness** is the third axis. Any colour is reachable. The
hex field takes `#833BDD`, `833bdd` or `#83d` and commits on Enter or on leaving the field;
the RGB channels beside it are a readout. **Opacity** sits under Brightness and replaced the
standalone opacity row, behaving identically (see **Opacity**).

Everything except the swatches lives in one column beside the wheel — hex, channels, and both
sliders — so the panel is a wheel and a column rather than a wheel and a stack of full-width
rows. The captions sit above their tracks for the same reason: the column is too narrow to
give a label, a track and a readout a line each.

**The wheel opens on the colour in force**, reported as it is: select something and the panel
starts on that object's colour and opacity, exactly as the opacity slider already did, and a
mixed selection falls back to the toolbar's own. Black shows a brightness of `0`, because
that is what black is — reaching for the wheel is what lifts it, so the drag paints a colour
rather than more black.

The pen starts **white under a dark Zen theme and black under a light one**. A fixed black
default was invisible on the board a dark browser comes up on.

**Recently used** shows the last four colours that actually landed on the board, most recent
first, saved per easel. It is fed from objects being drawn or recoloured, and from the board's
own colour when the background panel closes — not from the wheel being moved, so exploring the
wheel does not fill it with near-misses. A paste or a `Ctrl+D` is left out for the same reason
in reverse: four differently-coloured objects arriving at once would replace the whole row in
one action, and none of those colours was chosen here.

**Favourites** sits beside it, four slots wide. **Left-click** one to put back the whole look
— the wheel, the brightness that follows from it, and the opacity it was saved at, as a
single undo step. **Right-click** one to save what the panel is currently on into that slot,
replacing whatever was there. Unlike the recents these are a personal palette rather than a
property of one board: they live in `zen.easel.favorites` and follow you between easels and
between the toolbar and the background panel.

That pref is read through `prefStr` at the moment the panel is built, not out of
`ZenEaselUtil.prefs`. The cache exists to keep pointer-move handlers off XPCOM and is
refreshed by an observer; a store that is written and read back in the same gesture wants
neither, and routing it through the cache is what made every favourite vanish the moment the
panel closed.

Both rows are always drawn at full width, with unfilled slots black. A row that grew as you
used it would shift everything under it, and a favourite's slot is its identity — you replace
the third one, not "the third one there happens to be".

**Standard** is Arc's own eleven colours on the first row and the seven Chill variants that
differ on the second — read out of the colour renditions in Arc's asset catalog rather than
matched by eye. Arc kept these as two switchable palettes stored per easel; that is gone,
and both sets are simply always on offer. Boards saved under the old scheme migrate on
open: a Chill board keeps its Chill values, and the file is rewritten with hex colours the
next time it saves.

**The picker sets the colour of what you draw next, and repaints whatever is
selected.** Select something and drag the wheel — or click a swatch, or press a number
key — and it changes colour; the stroke widths below work the same way, on shapes and ink.
With nothing selected you are only setting the default for the next mark. A whole wheel
drag is **one** undo step, not one per pixel of the gesture.

It used to be the other way round: the swatch never touched the selection, and
recolouring lived in the right-click menu. That was working around a problem that no
longer exists — objects used to stay selected after being drawn, so a swatch click
would silently repaint the thing you had just finished. Nothing is selected after you
draw it any more, so the swatch can mean the obvious thing, and the duplicate row of
swatches in the context menu is gone.

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

Right-click empty canvas and pick **Background** for the same wheel the toolbar uses. The
choice is saved per easel, so different boards can look different. **Follow theme** is the
default, in the panel's Standard row: it has no colour of its own and tracks **Zen's**
theme — not the OS scheme, which is a different question — so a new easel comes up pale
under a light workspace and near-black under a dark one, and keeps matching if the theme
changes under it. The grid contrast is derived from whatever the board actually ends up
painted, so dots stay visible on a light background and a dark one alike. **Arc** is one
click away: a pale multi-colour wash rather than flat paper, which is most of why Arc's
boards read as soft.

**The wheel shows the board that is in force**, on opening and after every pick. Click Paper
and the wheel, the brightness and the opacity all move to Paper; reopen the panel later and
they are still on it. Presets carry an opaque `swatch` and an alpha for exactly this. The two
boards with no colour of their own, Follow theme and Transparent, fall through to the same
default the pen does — white under a dark Zen theme, black under a light one — which is also
what a brand new easel is sitting on. An easel already set to a colour of its own opens on
that colour and its own opacity.

The panel **stays open** when you pick, rather than dismissing itself with the menu. A
preset is a whole board — a colour and an alpha — and the point of clicking one is to watch
both land and then keep adjusting from there.

Every board is a **tint, not a fill**. Every preset carries an alpha, and nothing
between the board and Zen's window paints: `.easel-root` and the page's own `<body>` are
permanently transparent, and `.easel-viewport` is the single painter of the board's
colour. What you get is the window wearing the board's colour rather than a sheet of
paper covering it.

The panel's lower slider is **Opacity**, and it is that scale made continuous: `100%` is
the board fully solid, `0%` is it declining to tint at all — the same thing the
**Transparent** preset means. It tracks the board like the colour does: every preset carries
an alpha of its own — Arc `0.44`, Paper `0.50`, Black `0.54` — so picking one moves this
slider to it, and Transparent takes it to `0`. Only the two boards with no colour of their
own have no alpha either, and those open fully opaque. Below about 20% the board is treated
as having no colour of its own, and an export comes out with a transparent ground instead of
a solid one.

The board's colour joins **Recently used** too — recorded when the panel closes rather than
on every slider release, so one session of adjusting leaves one entry rather than a dozen.

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

### Chrome that follows Zen, and a board that does not

The topbar, the toolbar, the popups and the context menu are **Zen's workspace colour at a
heavier alpha**, not a fixed panel grey and not the board's colour. Change workspace or
theme and the easel's panels come with it; change the board and they stay put. Because the
chrome keeps an alpha of its own, the wallpaper behind Zen reads through the whole window
rather than stopping at the topbar.

Set **`zen.easel.hide-topbar`** to remove that bar altogether and give the board the whole
tab. Nothing on it is only there: the easel's name is the heading on the board and the tab's
own label, `Ctrl+0` resets the zoom and the context menu has it too, `Ctrl+W` closes the tab,
and the switcher — the board list, New, Rename, Delete — reappears as **Easels** in the
right-click menu on empty canvas. The one thing that does go is the live-card count, which
reports the whole window; with the bar off, a card is stopped from its own right-click menu
or its floating bar, board by board.

They used to be the *board's* colour. That stopped working once the background became a
wheel and a slider rather than nine presets: dragging the board's opacity dragged every
panel with it, and crossing the sheer threshold flipped them light-to-dark mid-gesture.

`_syncZenColors` in `page/easel-page.uc.js` is where the chrome's colour is decided. Zen's
theme lives in the browser window, not in this document, so it reaches across and writes
`--easel-chrome-tint` (the surface's channels, which `--easel-panel` re-alphas),
`--easel-chrome-solid` (the same colour opaque, for the two rings that cannot be
see-through), `--easel-accent`, and `data-easel-chrome-ink`. That last one exists because
the ink has to follow the *panel*, not the OS — Zen's workspace colour can be dark under a
light system theme — and `light-dark()` cannot say so because it is answering a different
question. It runs at startup and again whenever the tab comes back into view, which is what
catches a workspace switch.

Zen's colours are read through a **probe element** rather than off the root:
`getPropertyValue` hands a custom property back as authored, so a value written as
`light-dark()` or `color-mix()` would arrive as a token string nothing here can parse.
Setting it as a real `background-color` on a throwaway `<div>` and reading the computed
value back is what turns it into an `rgb()`.

`_applyBackground` in `modules/canvas.uc.js` still writes `--easel-tint`, `--easel-solid`
and `data-easel-ink`, but nothing in the stylesheet reads the first two any more. What is
left of them is the canvas: the floating card bar borrows the channels, and the renderer
paints card bodies with the opaque colour — both sit *on* the board and would be holes onto
it in any other colour.

The **transform handles** flip on `data-easel-ink`, the board's own switch. They are the one
piece of selection chrome that must *not* be the board's colour — a grip painted in the
board's own tint is a grip you cannot see — so `--easel-handle` lands one step brighter than
the board in both directions: white over a light board, a lifted neutral (`#40404a`) over a
dark one, with the accent ring doing the delimiting. White grips read as glare against Ink
or Black. Both values are set by media query rather than `light-dark()`, because the
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

### Moving a card's view, and the refresh button

A card made from a screenshot is pinned to the region it was cut from: it does not scroll,
because scrolling it would mean it was no longer showing what you saved. That holds right
up until you click into it — while the pointer is inside the card the page scrolls, selects
and submits normally, which is how you sign in to a site inside a card, and how you fix a
card whose page has since been redesigned under it. Stepping back out re-pins the card
wherever you left it, so the site cannot then drift on its own.

That leaves the picture on the front of the card still showing the old view. **The circular
arrow in the bar re-takes it**: the card's picture becomes what the tile is showing now, and
the place in the page it opens to moves to match. The button is only there while the card is
actually running, because both come from the tile's own pixels.

It works on a web tile too, where there is no crop — it pins the thumbnail you are looking
at as the one the card shows when it is stopped, and remembers the scroll position. That pin
lasts until you browse the tile somewhere else.

Set `zen.easel.live.reposition` to `false` if you would rather a card never scrolled at all.

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
  screen. A card captured in a **container tab** reopens in that same container, because
  that is the session it was showing you; cards captured outside one use your normal
  session. Set `zen.easel.live.private` or point `live.container` at a container if you
  would rather a board did not carry your session around.
- **Treat a board file you did not make like any other file someone sent you.** Playing a
  card loads a URL out of that file as though you had followed a link on the site itself,
  so an imported board can make a signed-in request you did not intend. It takes a
  deliberate click — cards never go live on their own — but it is worth knowing before you
  press play on somebody else's board.
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

### The capture backdrop

Screenshots taken in Zen with a transparency extension running come out blown out and
half-erased. It is worth spelling out why, because nothing about it is a bug and none of
the three parts is doing anything wrong.

1. **Zen makes the content view transparent.** With
   `browser.tabs.allow_transparent_browser` set, `tabbrowser.js` puts `transparent="true"`
   on every `<browser>`. That tells Gecko not to paint the default white canvas behind a
   page. What shows through instead is the Zen window.
2. **A styling extension makes the page's background transparent** so that window is
   visible. [Zen Internet](https://github.com/sameerasw/zeninternet) — the one this was
   written for — stores per-site "Transparency" features that are literally
   `html, body, #root, #app, nav, … { background-color: transparent !important;
   background-image: none }`, injected as a `<style>` element at the end of `<head>` and
   re-anchored there by a `MutationObserver`.
3. **Every screenshot path composites onto white.** In Firefox's `ScreenshotsUtils`,
   `createCanvas` does `context.fillStyle = "rgb(255,255,255)"` and then asks
   `drawSnapshot(rect, dpr, "rgb(255,255,255)")` for the pixels.

A snapshot has no browser window behind it — nothing is there at all. So the light text you
read comfortably over a dark Zen window lands on pure white and half of it disappears. It
is also why **Easel** from the preview dialog looks the same: that image was
already taken by Zen through `createCanvas` before this mod ever saw it.

#### What is done about it

The colour that was actually behind the page is put into the picture, in both of the two
places `createCanvas` hardcodes white: the `fillRect` that backs the canvas, and the
background handed to `drawSnapshot`.

The page is never touched. An earlier attempt at this made the page opaque for the length
of the shot with a user-agent-origin sheet, because the extension's rules are author
`!important` and only UA or user `!important` outranks them without a specificity fight.
That works, but it means an IPC round trip into the content process, a visible change to a
live page, and a restore path that must survive a capture that throws — three ways to
leave a page altered because a screenshot went wrong. Substituting the colour needs none of
it: nothing in the content process is asked to do anything, the extension is left alone,
and if every part of this fails the result is exactly the white you get today.

Two paths, one answer:

- **Zen Easel's own captures.** `capture-host.uc.js` passes the colour to `drawSnapshot`
  instead of white, and retries once on white if Gecko refuses it — a backdrop must never
  be the reason a capture fails.
- **Zen's native screenshots.** `background/capture-backdrop.sys.mjs` takes over
  `ScreenshotsUtils.createCanvas`, which is the single funnel for all four outputs (save
  visible page, save full page, copy region, download region) and is reached internally as
  `this.createCanvas`, so replacing the property covers every one. The preview dialog comes
  along for free: it displays whatever that returns.

  The replacement is a faithful copy of Firefox's own `createCanvas` with the colour
  substituted twice — including the modulo arithmetic on the tile offsets, which is
  load-bearing: at a `devicePixelRatio` like 0.3 the snapshot size floors to 307 while tiles
  start every 307.2 device pixels, and without the correction every fifth tile lands a pixel
  out and leaves a visible seam. Every failure path — a colour Gecko will not parse, a tab
  that navigated mid-capture, a rect it refused — falls back to calling Firefox's own
  `createCanvas`, so the worst this can do is produce exactly the white it was written to
  replace.

  Reimplementing it rather than wrapping it is what closed the last gap. The earlier version
  shimmed `drawSnapshot` for the duration of the call, which could not reach the `fillRect`
  *inside* `createCanvas` — so on a fractional `devicePixelRatio` a dark backdrop still left
  a white hairline along the right and bottom edges. It also had three moving parts that
  each failed silently: an own-property shim with a prototype fallback, a `WeakMap` of
  in-flight captures, and a gate that only fired when the caller passed Firefox's exact
  white literal.

That hook lives in a background module rather than in a window script for a specific
reason. `ScreenshotsUtils` is an ESM singleton, so patching it is process-global, while
window scripts are per-window and are nuked when their window closes. A patch installed
from window A that still referenced A's functions would start throwing "can't access dead
object" the moment A was closed — and the only symptom would be that screenshots quietly
broke in every *other* window. So it holds no window reference at all: at capture time it
finds the `gZenEaselCaptureBackdrop` for that browser, asks it for a colour, uses the
string, and drops it. A window with no Zen Easel host loaded simply has no opinion.

Finding it used to be `browser.ownerGlobal` alone, and it was widened while chasing the
white screenshots. That turned out to be the wrong suspect: the symptom is fully explained
by the stale-module early return described below, and `ownerGlobal` was never shown to fail.
It is defined as `ownerDocument.defaultView`, which for a `<browser>` in the chrome document
is the browser window. Attempts to measure it otherwise were reading the Browser Console,
which cannot see that property at all and reports null for every node, `documentElement`
included — a good reminder that a console reading is a measurement of the console until a
known-good control says otherwise. The extra candidates that remain — `topChromeWindow`,
then any open browser window that has a host — are unverified belt-and-braces rather than a
fix for anything diagnosed, and the last of them is the one branch that could answer with
the wrong window's colour in a private or unsynced window.

Installation is restore-then-repatch rather than an early return on a marker. The early
return was the one path that did nothing and still reported success — the caller logged
"hooked: true" and every screenshot still came out white — and it made the module
impossible to fix in place, because a patch installed by an earlier revision owned the
property for the session and the only code that could displace it was that same stale copy.
Keeping the true original on the object means a second call re-wraps a clean function
rather than wrapping its own wrapper, and the newest copy always wins.

#### Where the colour comes from

`resolve()` in `capture-backdrop.uc.js`, and it is all reads:

1. Zen's own `--zen-main-browser-background`, which is what `.zen-browser-generic-background`
   paints behind the content area and is defined on `:root` including the private-window and
   unsynced-window variants.
2. Failing that — a theme using a gradient, or a translucent mica surface — a walk up the
   chrome from the `<browser>` to the first thing that paints something opaque, checking
   `::after` and `::before` too, because Zen paints the window background on pseudo-elements
   rather than on the boxes themselves.
3. Failing that, the plain `Canvas` system colour for whichever scheme the window is in.

Anything translucent along the way is skipped rather than used: a translucent layer means
what is under it is still part of what you were looking at. And a translucent *result* is
rejected outright, because a PNG with an alpha channel looks blown out again the moment it
is viewed on white, which is the whole complaint. `custom` is the one exception — if you
type `rgba(0,0,0,0.5)` you get it.

Resolution goes through one hidden, zero-sized, out-of-flow probe element, made once per
window and kept: `var()`, `light-dark()`, `color-mix()` and system colours all need the
window's own style system to resolve, and that is also what validates the custom pref —
a value Gecko refuses leaves the declaration at `transparent`, which is rejected along with
everything else that would not cover white. Keeping the probe rather than adding and
removing one per capture means no DOM mutation that Zen's own observers would see.

#### Settings

`zen.easel.capture-backdrop`: `auto` (default — the window's colour, on tabs Zen has made
transparent), `always`, `page` (plain white or near-black by your light/dark setting),
`custom`, `off`. `zen.easel.capture-backdrop-color` holds the colour for `custom`.

`off` restores Firefox's white on both paths exactly. An opaque page is unaffected in every
mode, because it paints over the backdrop completely; and in the default configuration the
colour applied equals the one already showing through, so there is nothing to see either
way. `zen.easel.debug` logs which of the three sources `auto` got its answer from.

One gap is left on the native path. `createCanvas` also fills its `OffscreenCanvas` with
`rgb(255,255,255)` before it draws, to cover the device-pixel rows that rounding leaves the
renderer short of, and that fill is inside the function being wrapped. On a fractional
`devicePixelRatio` a dark backdrop can therefore still leave a white hairline at the right
or bottom edge. Reaching it would mean reimplementing `createCanvas` rather than wrapping
it, which is a much worse trade than a hairline.

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
| `zen.easel.hide-topbar` | `false` | remove the top bar; the switcher moves to the canvas' right-click menu |
| `zen.easel.wheel` | `zoom` | `zoom` or `pan`; `Ctrl`+wheel zooms either way |
| `zen.easel.ink-style` | `variable` | `variable` thins with speed and follows stylus pressure; `uniform` is a constant width |
| `zen.easel.grid` | `dots` | `none`, `dots` or `lines` |
| `zen.easel.snap` | `guides` | `guides` (to other objects), `grid`, or `none`. Hold `Alt` to suppress |
| `zen.easel.grid-size` | `24` | canvas pixels, for `snap: grid` |
| `zen.easel.capture-backdrop` | `auto` | what goes behind a captured page: `auto`, `always`, `page`, `custom`, `off` |
| `zen.easel.capture-backdrop-color` | *(empty)* | CSS colour for `custom` |
| `zen.easel.live.enabled` | `true` | off means no easel ever loads a website |
| `zen.easel.live.max-tiles` | `12` | how many cards may be live at once, per window; `0` for no cap |
| `zen.easel.live.idle-timeout-min` | `30` | stop a card after this long out of sight; `0` for never |
| `zen.easel.live.reveal-delay-ms` | `140` | pause before showing live cards again after a tab switch; `0` for none |
| `zen.easel.live.private` | `false` | load live cards in a private session |
| `zen.easel.live.container` | `0` | container ID for cards that did not record one of their own; `0` is your normal session |
| `zen.easel.live.allow-http` | `false` | allow live cards over plain http |
| `zen.easel.live.reposition` | `true` | let a live card be scrolled while you are using it, so the refresh button can move where it opens to |
| `zen.easel.live.extension-identity` | `false` | experimental: let extensions treat live cards as tabs, so uBlock Origin's cosmetic filters and Dark Reader apply inside them — adds a hidden tab per running card |
| `zen.easel.autosave-ms` | `500` | delay after the last change |
| `zen.easel.storage-dir` | *(empty)* | empty means `<profile>/zen-easels` |
| `zen.easel.debug` | `false` | `[zen-easel]` logging in the Browser Console |

Every one of these applies live. The mod binds no keys of its own: an easel is opened from
the toolbar button or the library, and a capture starts in Zen's own screenshot overlay,
under whatever keybinding Zen already has for it.

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
| `background/registry.sys.mjs` | registers `about:easel` and the urlbar provider, and installs the actors at boot |
| `background/actors.sys.mjs` | what the three window actors are, and how to install them |
| `background/store.sys.mjs` | owns the disk: index, write queue, shutdown blocker, asset sweep |
| `background/urlbar.sys.mjs` | the address-bar provider that suggests boards by title, or by the `easel` keyword |
| `background/validate.sys.mjs` | the URL/id/asset-name rules, shared by everything |
| `background/capture-backdrop.sys.mjs` | hooks `ScreenshotsUtils.createCanvas` so Zen's own screenshots composite onto the window's colour instead of white |

**In the browser window** — the parts that genuinely cannot live in a page.

| | |
|---|---|
| `ZenEaselHost.uc.js` | toolbar button, opening/focusing the easel tab, the bridge |
| `modules-host/capture-host.uc.js` | turns a region Zen selected into pixels, via `drawSnapshot`, and measures the page for a live card |
| `modules-host/screenshot-hook.uc.js` | the **Easel** button on Zen's region bar and preview dialog, and the send-to-easel menu behind both |
| `modules-host/capture-backdrop.uc.js` | works out what colour was behind the page, for both capture paths |
| `modules-host/live-host.uc.js` | the live tiles themselves — `<browser>` elements, the layer over the easel tab, load watching |
| `modules-host/split-resize.uc.js` | not an easel feature: fixes a Zen split-divider bug where mouse events from an in-process about: page arrive in that page's coordinates, so the divider snaps and the panes strobe. Behind a setting, and meant to be deleted once Zen fixes it upstream |

**In the page** — `about:easel` itself, a system-principal chrome document in the parent
process.

| | |
|---|---|
| `page/easel.xhtml` | the document: CSP, title, favicon, stylesheet, boot script |
| `page/easel-boot.js` | the loader of record, at parse time |
| `page/easel-page.uc.js` | the `<zen-easel>` element and the page controller |
| `modules/objects.uc.js` | object model, validation, hit-testing, colour |
| `modules/renderer.uc.js` | canvas painting, culling, stroke bitmap cache, text wrapping |
| `modules/freehand.uc.js` | variable-width stroke geometry |
| `modules/guides.uc.js` | Arc's six alignment guides |
| `modules/live-layer.uc.js` | live web cards and web tiles: which are live, the cap and its LRU, crop geometry, activation |
| `modules/text-editor.uc.js` | the textarea shown while editing a text box |
| `modules/store.uc.js` | the page's view of the store: open document, blob cache, debounce, thumbnails |
| `modules/canvas.uc.js` | viewport transform, input, selection, undo, the title heading, export |
| `modules/color-picker.uc.js` | the colour wheel panel, shared by the toolbar and the board menu |
| `modules/tools.uc.js` | toolbar, colour and tool state, context menu |
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

### The three actors

| | |
|---|---|
| `ZenEaselCapture` | measures the viewport and crop rect inside the page being captured |
| `ZenEaselLive` | the scroll lock, selection lock and link interception inside a live card |
| `ZenEaselScreenshot` | draws the **Easel** button on Zen's region bar, and reports a click |

`ZenEaselLive` is scoped by `messageManagerGroups: ["zen-easel-live"]`, matching an
attribute only `live-host.uc.js` sets, so it attaches to live tiles and to nothing else
in the browser. Its input listeners are registered in the system event group, so a page
calling `stopPropagation()` cannot get underneath them.

`ZenEaselCapture` and `ZenEaselScreenshot` have to reach ordinary tabs, so their group is
the default `browsers` — but neither declares any events or observers, which means the
child is never instantiated until the parent calls `getActor()`. At rest they cost nothing
and see nothing.

`ZenEaselScreenshot` exists because Zen's region bar cannot be reached any other way: it
is built with `document.insertAnonymousContent()` from `ScreenshotsOverlayChild`, in the
*content* process, so it is neither in the chrome document nor in any shadow root a chrome
script can walk. The child patches `ScreenshotsOverlay.prototype` once per content process
— install-once, restore-never, because the flag lives on an object shared by every document
in that process and any teardown would disarm the button for every other tab.

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
  do two XPCOM reads per object per pointer event. The observer is registered on
  `Services.prefs`, which is the *root* branch, so the name it is handed is the full
  `zen.easel.grid` rather than the `grid` that `PREF_SPEC` is keyed by — it strips the branch
  before looking it up. Comparing the raw name meant the guard matched nothing, so the cache
  sat at whatever it read at startup for the life of the window and editing any `zen.easel`
  pref did nothing until the next restart.
- **Offscreen objects are culled** against a padded viewport rectangle.
- **Committed strokes are rasterised once** and blitted afterwards, keyed on geometry,
  colour and zoom — Excalidraw's `elementWithCanvasCache` idea. Deliberately not keyed
  on position, so moving a stroke reuses its pixels.
- **Zoom is proportional to scroll distance**, with the step widening as you zoom in and
  damped for the small deltas trackpads emit. A fixed multiplier per notch is what made
  zooming feel steppy.
- **Ink consumes coalesced pointer events**, so throttling to one frame does not
  straighten fast strokes.

**The screenshot integration reaches two of Zen's three surfaces**, which between them
cover every way a capture can be made. Where each one lives decides how it is reached:

| Surface | Where it lives | How it is reached |
|---|---|---|
| Region bar (*Copy / Download* under a dragged selection) | `insertAnonymousContent()` in the **content process** | from inside that process — the `ZenEaselScreenshot` child actor patches `ScreenshotsOverlay.prototype` and builds the button as part of the overlay's own markup |
| Preview dialog (after *Save visible / full page*) | Lit element in a tab dialog | directly — via the document it loads |
| Buttons panel (*Save visible / full page*) | `MozXULElement` in the chrome document, open shadow root | no longer used — both routes it offered now arrive by way of the preview dialog |

The panel was dropped rather than kept, and that is the fix for the old "sometimes the
buttons are missing" bug: `ScreenshotsUtils.openPanel` treats the panel as a per-window
singleton it only ever re-shows, so a `connectedCallback` patch runs once per window and
loses a microtask race against `createPanel` every time. What made it work at all was a
single unretried catch-up query. Nothing races now — the button is rebuilt every time the
overlay is.

There is no hand-off any more either. The mod used to dismiss Zen's overlay and stand up a
region picker of its own; the region the user dragged is now encoded straight out of the
selection Zen already holds, so there is one capture UI in the browser rather than two, no
second overlay, and no delay between them.

One constraint shapes the injected UI, and one used to. The preview's `blob:` URL is
created inside `ScreenshotsUtils.sys.mjs`, so rather than argue about which global may read
it, the pixels are re-encoded from the `<img>` the dialog has already loaded. The old
constraint was the preview dialog's `default-src chrome:` CSP, which blocks an injected
`<style>` and forced every menu style to be set as an element property — gone with the
hand-built menu, which is now a XUL `menupopup` in `mainPopupSet`. That is an OS-level
widget: nothing can clip it, it dismisses and keyboard-navigates itself, it flips at a
screen edge, and Zen themes it.

**Region capture runs in the parent process.** Pixels come from
`WindowGlobalParent.drawSnapshot` — the same privileged path Firefox Screenshots uses —
asked for an explicit document-space rect and tiled, because `drawSnapshot` refuses a rect
past `MAX_SNAPSHOT_DIMENSION`. Snapshotting the viewport and cropping was sound only while
the mod's own picker drew its rect over the visible browser and so could not select
anything off-screen. Zen's overlay can: a drag that reaches the window edge scrolls the
page under it, and cropping a viewport bitmap for one of those returns whatever happens to
be at those coordinates now — silently, with a picture that looks like a successful capture
of the wrong thing.

The rect arrives in **content** CSS pixels, relative to the document and already
zoom-corrected, where the old picker's was in chrome pixels and had page zoom divided out.
The two are not interchangeable, and getting it wrong is invisible: both corrections are
no-ops at 100% zoom.

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
- **One actor takes a payload from content, and it is treated as data rather than as a
  capability.** `ZenEaselScreenshot` is the first: the other two only ever answer with
  numbers, while this one reports which region was selected and where its button sits on
  screen. Neither value is trusted with anything. The region is used solely as snapshot
  coordinates against the very browsing context that reported it, and the anchor is only
  ever fed to a popup's screen position — so the worst a compromised content process can do
  with the message is photograph itself and open a menu. It cannot name a different tab, a
  file, or a destination easel; the destination comes from the menu the user picks in the
  parent process. Sending the message repeatedly gets it nothing either, because the menu
  refuses to open a second time while one is already up.
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
