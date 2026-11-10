# Screenshots for the how-to page

Two pictures belong in this folder. `/how-to` asks for each of them on every render, so a
file added here appears on the next page load - no build step, nothing to restart. Until a
file exists, step 3 draws a dashed frame that reserves its space, so the page reads either
way and does not jump when the picture lands.

| File | What it must show |
| --- | --- |
| `add-to-share.png` | The right-click menu on an item in game, with **Add to Share**, **Always Share This Item** and **Share Reserve** visible. |
| `shared-items.png` | The Shared Items window - what `/itemshare list` opens - with an item, its count and where each copy is kept. |

Both are PNGs, drawn at the width of the guide column (760px at most), so a capture around
1200px across or wider stays sharp. The empty frame is 16:9; the real picture keeps its own
shape, so a 4:3 game window is not cropped to fit.

The captions live in `lib/views.js` (`guideShot`), next to the step that shows each
picture, so the words and the image cannot drift apart.
