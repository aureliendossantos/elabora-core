---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Changed)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Changed)
npm/@elabora/cli: minor (Changed)
---

The player says where the learner is (D58, revised on 29 Oct 2026). In a course of two sections or more, the progress is one segment per part, as wide as its share of the screens: a part fills as its screens are completed, the part shown has a stronger line, and each segment is a button to the part's first screen. Hovered or focused, the tooltip gives the part's name, and follows the pointer from part to part; screen readers also hear where it stands, « Partie 2 sur 4 : La torréfaction, en cours ». Tab stops once, on the part shown, and the arrow keys go from part to part. A part not open yet (linear navigation, `lockUntilComplete`) refuses as Next does, in the tooltip and the live region (« Cette partie n’est pas encore disponible »); on a phone a tap opens the outline, where each screen is a line. A course of one section keeps the bar in one piece. The outline's option `screenTitle` becomes `label`: `outline` (« Sommaire », the default), `section` (the part shown) or `screen` (the screen shown), in schemas 0.1.5 without migration (`elabora player . --set outline.label=section`, MCP `elabora_player`). The rules every course gives its agents (revision recorded), `elabora-course-authoring` and `elabora-visual-design` name the progress and the outline as what says where the learner is.
