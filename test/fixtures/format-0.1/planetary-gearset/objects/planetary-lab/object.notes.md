# Planetary gearset test bench

**Pedagogical role.** The learner applies the Willis equation in reverse (objectives OBJ-2 and OBJ-3): for each requirement (a speed factor and a direction), they choose the held member and the driven member, run the bench and compare the measured output with the requirement. Each run is recorded, so predicting before running pays off; after two missed runs, a hint recalls how to use the equation.

**Editable without code.** Instruction, tooth counts (three presets that assemble with three planets), motor speed, the three requirements (any of the six configurations), ratio display, animation speed, member colours (sun bound to the accent colour, background to the primary colour).

**Tracking.** Every run during the requirements is an interaction linked to OBJ-3 (response: held-driven configuration). Score: 1 per requirement met at the first run, 0.75 at the second, 0.5 at the third, 0.25 after; the average counts twice in the course score.

**Geometry.** `gear.js` holds the tooth profiles, the meshing phases and the kinematics; the SVG figures of the course are generated from the same file (`tools/figures.mjs`), so the illustrations and the 3D model match.
