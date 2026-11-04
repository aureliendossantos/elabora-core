---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Changed)
npm/@elabora/engine: minor (Changed)
npm/@elabora/cli: minor (Added)
---

What each media weighs in the package, at each media quality, before any build: `elabora media weights [--media-quality q] [--all] [--json]` and MCP `elabora_media_weights` list the media heaviest first, with their kind, file, duration and size, what high, medium and low ship (the master as it is or a rendition, made or estimated, the size shipped), where the course uses them, the narration tracks and the dialogues' lines, and the rest of the package. A media that seems heavier than it needs to be, for what its file shows rather than its size, comes first with a notice: an animated image (several times lighter as a video), or, without ffmpeg, a media that ships as it is rather than as its web copy; with why and what lightens it. A long video that weighs is not one. A package at the high quality ships a rendition, made once and cached, of a master an import would not have left as it is: a video or an image not in its web format, a still image of more than a byte a pixel (a photo saved as PNG), a video far denser than its size needs (`isDense`); the project's files are left as they are. The lower qualities re-encode a dense video stream rather than copy it. `packageWeights` (and the engine's request) now returns `{ quality, qualities, media, rest }` instead of the sizes alone.
