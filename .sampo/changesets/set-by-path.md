---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/cli: minor (Added)
---

One answer, item, row, node, line or setting changed by its path (D89): `update_block`, `update_screen` and `update_course` (and their MCP tools) take `set`, a list of `{ path, value }` such as `props.options[b].text` or `navigation.lockUntilComplete`, applied on the element as it is and leaving the rest; `null` removes, a new id joins the end of its list, an id is never changed. A command's result now lists in `removed` what its change took away, so a list or a setting given whole no longer drops entries silently.
