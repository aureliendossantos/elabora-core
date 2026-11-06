---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

cmi5 and xAPI packages, when a module asks for them (`course.json` `delivery.format`, `elabora build --format`): Elabora still picks SCORM 1.2 or SCORM 2004 by itself. They talk to the LMS's learning record store over HTTP: `elabora/lms.js` connects before the player starts, then what the learner does goes in order, without making them wait, and at once with `keepalive` as the page goes. cmi5 (docs/delivery-cmi5.md): `cmi5.xml` with one AU, moveOn from the course's completion rule, the token fetched once per launch, initialized, completed, passed or failed and terminated in cmi5's rules, answers as `answered`, the place and suspend data in a State API document. xAPI (docs/delivery-xapi.md): `tincan.xml` and the Tin Can launch, or outside an LMS the LRS of `delivery.lrs` with a key given to the build (`ELABORA_LRS_KEY`, `ELABORA_LRS_SECRET`, `--lrs-key`, `--lrs-secret`), never in course.json; W_XAPI_NEEDS_LRS, W_XAPI_KEY_IN_PACKAGE, W_XAPI_NO_LRS_KEY. `delivery.activityId` names the course's activity. `elabora test` plays an LMS with its LRS for both, and `--package` reads the format from `cmi5.xml` or `tincan.xml`.
