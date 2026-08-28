# Zen Easel

A port of Arc's Easel to Zen. See [this](https://www.youtube.com/watch?v=ukquBSOpmTk) video to learn more.

An infinite canvas at `about:easel` for screenshots, web pages, text, drawings, and images. Everything is stored locally in your Zen profile.

<img width="1834" height="1235" alt="image" src="https://github.com/user-attachments/assets/03372cc8-6d4f-4dc6-9790-be4b9f497843" />

## Features

- Infinite canvas
- Multiple boards, each in its own tab
- Screenshot capture
- Live web cards
- Embedded web tiles
- Pen, shapes, text, and images
- Export as PNG or JPEG
- Local storage

## Install

Requires [Sine](https://github.com/CosmoCreeper/Sine) and [Zen Library](https://github.com/trashshii007/Zen-Library).

1. Enable unofficial sources.
2. Add this repository's URL.
3. Install [Zen Library](https://github.com/trashshii007/Zen-Library)
4. Restart Zen.

**Requires my forked Zen Library**.

## Opening a board

- `Ctrl+Shift+E`
- Toolbar button
- **Easels** section in Zen Library

Each board opens in its own tab.

## Capturing

<img width="633" height="499" alt="capture" src="https://github.com/user-attachments/assets/69999480-ac3b-40c3-8e37-0487f1c2a9a9" />

Drag a region first, then choose where it goes.

- Screenshot → drag a region → **Easel** on the bar beside Copy and Download
- Save visible/full page → **Easel** in the preview
- `Ctrl+Shift+2` opens Zen's own screenshot overlay

Picking **Easel** opens a menu of your boards, most recently used first, plus *New Easel*.

## Tools

<img width="538" height="245" alt="image" src="https://github.com/user-attachments/assets/191ee337-df59-435f-b2a0-cb1b66ddc2b7" />

`V` Select • `T` Text • `R` Rectangle • `O` Ellipse • `Y` Triangle • `L` Line • `A` Arrow • `P` Pen • `I` Image

## Text

<img width="807" height="287" alt="image" src="https://github.com/user-attachments/assets/4c3bf02e-4def-4337-a827-4c0de72c0dc9" />

- Five heading styles

## Backgrounds

<img width="345" height="432" alt="image" src="https://github.com/user-attachments/assets/62ae3da4-3c34-4201-929c-254c74699397" />

- Follow theme
- Arc
- Transparent
- Colour presets

## Live web cards

<img width="625" height="400" alt="output" src="https://github.com/user-attachments/assets/eab2690d-996d-4df6-97e9-26572776bc9e" />

- Play screenshots as live webpages
- YouTube embeds
- Background execution
- Configurable idle timeout
- Configurable live-card limit

## Alignment

- `Alt` disables snapping

## Export

- `Ctrl`+`Shift`+`S`

## Storage

```
<profile>/zen-easels/
  index.json
  easels/<id>.json
  easels/<id>.thumb.png
  assets/<id>/<uuid>.png
```

`zen.easel.storage-dir` changes the storage location.

## Documentation

Implementation details, architecture, and design notes are available in `docs/MANUAL.md`.

## Credits

Feature design is Arc's, by The Browser Company. This is an independent reimplementation for Zen with no Arc code in it.

The renderer's structure is modelled on [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT). The variable-width stroke geometry is an independent implementation of the approach described by [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (Steve Ruiz, MIT).

No code from either project was copied.
