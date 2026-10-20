# Phasing lab

**Pedagogical role.** The learner plans phasing manoeuvres around the Earth, one per requirement (three by default): for each they choose the first burn (retrograde or prograde, in 0.5 m/s steps) and the number of phasing orbits, predict the result with the rule Δx ≈ 3 T Δv, then watch the servicer fly the manoeuvre, burn back at the same point and end up next to the client, or not. It serves OBJ-2 (size the burn) and OBJ-3 (meet a gap, time and propellant requirement); no native block can show the counter-intuitive motion (braking to move ahead) as it happens, nor give feedback computed from the learner's own manoeuvre.

**Editable without code.** The instruction, the requirements (a list of one to six, each a distance to the client, the most orbits allowed and a propellant budget; the block's text version must follow them), the rendezvous tolerance, the prediction help (off by default), how much the 3D view magnifies the distance between the craft, where the Earth sits on wide screens, the duration of one simulated orbit, and the colours of the servicer, the client, the orbit and the atmosphere (bound to the course tokens).

**Tracking.** Each manoeuvre flown for an open requirement is a SCORM interaction on OBJ-3 (response such as `-3.0x1`: burn and orbits; correct or not). The score is the mean over the requirements of 1 at the first manoeuvre, 0.75 at the second, 0.5 at the third, 0.25 after; the object completes when every requirement is met.

**Physics.** Two-body Kepler propagation of both craft (objects/phasing-lab/orbit.js, the same code draws the course figures). The plot shows the true relative position; the 3D view magnifies the distance between the two craft (40 times by default) and says so.
