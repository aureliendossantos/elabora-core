---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: patch (Changed)
---

`charterOf` (`@elabora/core/project/charter`) picks the files of a course's charter from its files however they are read, a folder or a team's project as its room gives them (D137): the theme's folder and fonts with their licences, the components, the backdrop's decoration, the player's logo, what they name, and the generators of the pictures taken with their provenance. `copyCharter` calls it, so a browser's host that starts a module in another module's charter (`create_course` with `from: { kind: "charter" }`) takes the same files as the desktop.
