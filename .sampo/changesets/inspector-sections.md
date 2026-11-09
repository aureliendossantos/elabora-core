---
npm/@elabora/format: minor (Added)
npm/@elabora/core: minor (Added)
npm/elabora: minor (Added)
---

Schemas 0.1.10. The editor lays a block's settings out by meaning. The built-in blocks' schemas name each setting's section with `x-group` (`question`, `options`, `scoring`, `data`, `figure`, `markers`; without one, the block's content). Components may do the same, `x-group` naming a section in the course's language (translated with the course, units `component.<id>.prop.<setting>.group`). The old `x-group: "design"` mark of components and blocks is gone: nothing read it.
