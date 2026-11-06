---
npm/elabora: patch (Added)
npm/@elabora/player: patch (Added)
npm/@elabora/core: patch (Added)
---

The editor's canvas names each zone of a screen's layout and says which blocks it takes: a flow of `placing` carries its slot's `label` and `refuses`, the blocks of the screen the slot does not accept or has no room left for (E_COMPONENT_SLOT's rules, a fork accepted where its parent is). The editor's render gives the layout's slots (`layout.slots`, with `fields` only: packages carry none).
