---
npm/elabora: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

`elabora look` (and the MCP tool `elabora_look`) inspects scroll pages and free objects. `--scroll <px|N%|block-id>` shows the window at that position with animations on; several positions, or `--sheet` on a screen without a timeline, give a contact sheet down the page. `--block <id> [--scale 2]` returns a close-up cropped to one block, drawn again at twice its size. With `--scroll`, `--block` or `--motion` the look reports each block in the window (visible, clipped or outside, and how much), its CSS animations and transitions with their timeline and progress, and the scroll-driven animations that cannot finish because the page ends before their range. `--act click:<text>|click:role=<role>[name=<name>]|key:<key>|drag:x,y->x,y` (repeatable) drives a free object from inside its frame before the capture and reports its state and the events it emitted; a missing target lists what the frame offers. `elabora_look` takes `scroll`, `block`, `scale`, `act` and a PNG `type`. `elabora_preview_screenshot` now honours `scroll`, which it ignored.
