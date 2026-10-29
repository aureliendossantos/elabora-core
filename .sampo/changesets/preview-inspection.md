---
npm/elabora: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

The preview plays the course's LMS (`delivery.lms`, the first) instead of the unknown one, launching it in a frame as that LMS does, and `elabora preview --navigation free` opens every screen whatever the course's rules (a SCORM build takes `navigation: 'free'`, the web target's free navigation of D41; a running preview switches with `setNavigation`). The LMS emulator's page has no band any more. Shown in a frame, it tells its parent page what the LMS receives and what the course does (messages `elabora/lms`: the session, every API call, the course data, its state at every commit, the events run), and sets a variable when asked, its « when it changes » events running as if an event had set it. The player keeps what its events ran (`__elabora.trace`, the trigger and whether each event's conditions held) and sets a variable from outside (`__elabora.setVariable`); `__elabora.state()` gives the step and the variables' values. A preview's page reloads the emulator's page around it after a rebuild, whatever page shows the emulator.
