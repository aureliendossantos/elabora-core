---
npm/elabora: minor (Changed)
npm/@elabora/core: minor (Changed)
npm/@elabora/node: minor (Changed)
---

Ids a command makes end with a short random suffix (D77): a block added without an id is `<screen>-<type>-k3f9`, a layer `<screen>-layer-0qzt`, an event `<screen>-event-…`, a narration line `l4-m2xa`; a duplicated screen or block takes one suffix for itself and the ids it renames (`chemin-copy-k3f9`, `reflexe-choix-copy-k3f9`). Two copies of a project no longer draw the same id. The draw is injectable (`random` of `commandContext`, `executeCommand` and the executor's options) for tests.
