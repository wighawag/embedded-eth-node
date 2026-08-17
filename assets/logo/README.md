# webevm logo

The mark is the Ethereum octahedron cut into horizontal slices. The diamond says which chain; the cuts say what this library actually is, an EVM that runs in steps, block by block, inside a page. The wide gap at the belt is the octahedron's own seam, kept so the shape still reads as Ethereum at a glance, and the left/right tone split stands in for its facets.

The wordmark splits the same way the name does: `web` in ink, `evm` in the mark's blue.

Everything is drawn from paths and primitives, so each file is self-contained: no fonts, no external references, no raster embeds, and no `var()` (which some rasterisers silently drop).

## Files

| File | Use |
| --- | --- |
| `webevm-mark.svg` | Primary mark, 256x256. All blue, so it sits on light and dark alike. |
| `webevm-mark-mono.svg` | One colour, inherits `currentColor`. |
| `webevm-wordmark.svg` | Horizontal lockup on light backgrounds. |
| `webevm-wordmark-dark.svg` | Horizontal lockup on dark backgrounds. |
| `webevm-wordmark-mono.svg` | Horizontal lockup in one colour, inherits `currentColor`. |
| `webevm-favicon.svg` | Small-size cut: six thick slices instead of ten thin ones. Use below 48px, where the fine cuts smear shut. |

The wordmark letters are outlined geometry, not text, so nothing depends on an installed font and the file rasterises identically everywhere.

## Colours

- Slices, left facet: `#A3B5FA` down to `#7C94F3`.
- Slices, right facet: `#5B75E8` down to `#3B51C8`.
- Wordmark ink: `#1E2333`, or `#F2F4FF` on dark; the `evm` half is `#4E68DC`, or `#8FA2F7` on dark.

## Using it

Dark-mode-aware README or docs page:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/webevm-wordmark-dark.svg">
  <img alt="webevm" src="assets/logo/webevm-wordmark.svg" width="320">
</picture>
```

The mono variants take their colour from CSS, so they follow the surrounding text. That only works when the SVG is inlined in the document; an `<img>` tag isolates it and the mark renders black. Inline the file, or set `fill` yourself, when you need it tinted.

Favicon:

```html
<link rel="icon" href="/webevm-favicon.svg" type="image/svg+xml">
```

## Rasterising

```sh
inkscape webevm-mark.svg -o webevm-mark-512.png -w 512
```

## Room to move

Keep clear space of at least one slice pitch (20 units in the 256 grid) on every side. Do not restretch the lockup, respace the slices, or set the wordmark in a real font: the outlines are the wordmark. If you need the mark below 48px, switch to the favicon cut rather than scaling the primary down.
