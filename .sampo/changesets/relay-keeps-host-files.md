---
npm/elabora: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/node: minor (Changed)
---

The web app's canvas opens without the network after a first visit: the relay keeps its host's own files (the canvas page, the player's script and stylesheet, the objects' frame script, three.js, the relay page), named in its script by their SHA-256 and checked before it serves them, in a cache of its version (D131). `relayFiles()` now gives every file of the canvas and frames hosts, and a host serves `/relay.js` under a policy of its own (`default-src 'none'; connect-src 'self'`, said in `self.ELABORA_HOST.workerPolicy`) so that the relay may fetch them.

The Lecteur's preview in a browser: `createPageCanvasHost({ chrome: 'live' })` opens the canvas page with the player's bars in a frame that may open a link of the course in a tab of its own and download a file (`PREVIEW_FRAME_SANDBOX`, D132); the editor's canvas and the miniatures never may.
