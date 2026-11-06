---
npm/@elabora/player: patch (Fixed)
npm/@elabora/core: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

A free object's image settings work as a block's media: a setting whose manifest control is `x-control: "asset"` (a prop, or a field of a list's items) names a file of the course's `assets/`, which the validator reports missing (`E_ASSET_MISSING` at the setting), the editor's canvas serves, the package ships (with the media weights) and the object reads with `ctx.host.asset(props.<name>)`; the backdrop's object too. The compiled block gives the file's path in the package (`files`), a lower media quality's rendition included.
