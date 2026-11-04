---
npm/elabora: minor (Added)
npm/@elabora/player: patch (Changed)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

An animated image becomes a video that loops like it, several times lighter. `elabora media to-video [dir] <block>` (MCP `elabora_image_to_video`, engine command `image_to_video`) makes an image block whose file is a GIF, an animated WebP or an animated PNG a video block with `loop: true`, in its place: its file becomes an MP4 (H.264 High, yuv420p, even sides, `+faststart`, no sound, transparency on white) with its first frame as poster, in one undoable change; the block keeps its id, width (a wide image is a wide block), alt, decorative and generated, its caption becomes the title; the image's file goes when nothing else names it. A centered or wide image only. The « animated » notice of `elabora media weights` names the command, and the course rules (revision 19) ship animated images as loops. In the player, a loop is muted before its source is known (iOS), has no picture-in-picture or casting button, is asked to play when it comes into the window (a browser that declines shows the play button), stays on its first frame while reduced motion is preferred and follows that preference when it changes; its pause button shows on hover, on focus, on touch screens and when the loop stands still.
