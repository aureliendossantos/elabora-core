---
npm/@elabora/format: minor (Added)
npm/@elabora/core: minor (Added)
npm/elabora: minor (Added)
---

The editor lays a block's settings out by meaning. The built-in blocks' schemas name each setting's section with `x-group` (`question`, `options`, `scoring`, `data`, `figure`, `markers`; without one, the block's content) and mark the settings authors rarely change with `x-advanced` (a chart's decimals and order, a quiz's weight, an image's caption): the inspector keeps those under « More settings » while they have their default. Components may do the same, `x-group` naming a section in the course's language (translated with the course, units `component.<id>.prop.<setting>.group`); free-object manifests take `x-advanced`. The old `x-group: "design"` mark of components and blocks is gone: nothing read it.
