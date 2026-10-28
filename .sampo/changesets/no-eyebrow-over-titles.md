---
npm/elabora: minor (Changed)
npm/@elabora/format: minor (Changed)
npm/@elabora/player: minor (Changed)
npm/@elabora/core: minor (Changed)
npm/@elabora/node: minor (Changed)
npm/@elabora/cli: minor (Changed)
---

No eyebrow over a title (D63 amended): the opening no longer writes its section and « Leçon 2 sur 6 » above the title, and loses its `eyebrow` prop (schemas 0.1.4, no migration); it keeps its reading time. The layout hooks `data-t-section` and `data-t-lesson` and the player label `lessonOf` are gone. Where the learner is belongs to the module's UI, or to a numbering of the course's style: the templates Clear and Organic number their part openers with forks of the opening (`clear-section`, `organic-part`, a `number` prop), as Flow and Shapes do. The rules every course gives its agents (revision recorded, unedited copies brought up to date), `elabora-course-authoring` and `elabora-visual-design` say: no line over a title. The examples lose theirs (`medieval-charts`' folio and its diptych).
