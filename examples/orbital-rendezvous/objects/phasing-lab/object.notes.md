# Phasing lab

**Pedagogical role.** The learner flies rendezvous around the Earth, one at a time (three by default). Each shows one instruction and only the controls it needs: the burn always, the laps when it allows more than one, the fuel when it has a budget. The learner sizes the burn with the rule of thumb (about 17 km per lap for each m/s, at 500 km), watches the spacecraft brake, fly its laps, burn back at the same point, and end up next to the satellite, or not. It serves OBJ-2 (size the burn) and OBJ-3 (meet a distance, time and fuel requirement); no native block can show the counter-intuitive motion (braking to move ahead) as it happens, nor give feedback computed from the learner's own manoeuvre.

**Editable without code.** The rendezvous (a list of one to six, each a distance to the satellite, the most laps allowed, an optional fuel budget and an optional instruction; the block's text version must follow them), the catch tolerance, the prediction help (off by default), how much the 3D view magnifies the distance between the craft, the duration of one simulated lap, and the colours of the spacecraft, the satellite, the orbit and the atmosphere (bound to the course tokens).

**Tracking.** Each manoeuvre flown for an open rendezvous is a SCORM interaction on OBJ-3 (response such as `-3.0x1`: burn and laps; correct or not). The score is the mean over the rendezvous of 1 at the first manoeuvre, 0.75 at the second, 0.5 at the third, 0.25 after; the object completes when every rendezvous is caught.

**Physics.** Two-body Kepler propagation of both craft (objects/phasing-lab/orbit.js, the same code draws the course figures). The 3D view magnifies the distance between the two craft (40 times by default); the satellite's tag gives the true distance.
