---
npm/@elabora/format: minor (Changed)
npm/elabora: minor (Changed)
---

Schemas 0.1.12. Every setting keeps its place in its section: `x-advanced` is gone from the blocks' schemas, the component manifest and the free-object manifest. A free-object manifest that still marks a setting with it reports `E_SCHEMA` until the keyword is removed. Sections keep related settings together; a long section is split into more sections instead.
