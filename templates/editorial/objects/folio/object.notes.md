# Folio and plates

**Decoration.** The magazine page of the Editorial template: a thumb index on the right edge (one tab per part, in the part's plate colour), the rules under the top bar and at the foot of the page, and the folio. It carries no information: the course reads the same without it (the player's outline and progress say where the learner is).

**Follows the course.** The tab of the section in progress (`sectionIndex` of `sectionCount`) stands out; on a part opener (variant `plate`) it unfolds into a colour plate on the right of the page, and on the first and last screens (`screenIndex` 0 and `screenCount − 1`) every section's plate shows side by side. Back on a paper page, the plate folds back into its tab. The folio is `screenIndex + 1`, on the left on even pages and on the right on odd ones; it turns through a mask at each new screen, up going forward and down going back (`direction`). On the black spread (variant `ink`) the rules and the folio take the light ink. Everything stays between the player's bars (safe area); under 640 px only the tabs and a slim plate along the edge remain.

**Still frames.** Under reduced motion, on a machine frozen below 24 frames per second (`host.onStill`), on the first screen shown and on a resumed session, the page is drawn as it ends, at once.
