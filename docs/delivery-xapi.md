# Delivery: xAPI (Tin Can)

xAPI records what a learner does as statements in a learning record store (LRS). **It needs an LRS**: the LMS's own, when the LMS launches xAPI packages ("Tin Can" launch), or one the client runs or rents, for a module outside an LMS. Elabora never picks xAPI by itself; a module forces it (`course.json` `delivery.format` `xapi`). For an LMS, [cmi5](delivery-cmi5.md) is xAPI with the rules an LMS needs, and SCORM is what every LMS reads.

## Package

`elabora build --format xapi` writes `<id>-<version>-xapi.zip`, with `tincan.xml` at its root instead of `imsmanifest.xml`, and `elabora/lms.js`, which connects to the LRS before the player starts:

```xml
<tincan xmlns="http://projecttincan.com/tincan.xsd">
  <activities>
    <activity id="urn:elabora:course:<id>" type="http://adlnet.gov/expapi/activities/course">
      <name lang="fr">…</name><description lang="fr">…</description><launch lang="fr">index.html</launch>
    </activity>
  </activities>
</tincan>
```

The activity id is `urn:elabora:course:<id>`, or `course.json` `delivery.activityId` (an IRI the client owns, which some LRSs ask for).

## Where the statements go

- **An LMS that launches xAPI packages** gives `endpoint`, `auth`, `actor`, `registration` and `activity_id` in the address (the Tin Can launch): the statements go to its LRS, as that learner.
- **Outside an LMS**, `course.json` `delivery.lrs.endpoint` names the LRS (its xAPI address, `https://…/xapi/`), and the build takes its key from `ELABORA_LRS_KEY` and `ELABORA_LRS_SECRET` (or `elabora build --lrs-key <key> --lrs-secret <secret>`): never from course.json, which lands in the project's history. The package then carries the key in `elabora/lrs.js` (W_XAPI_KEY_IN_PACKAGE): anyone who has the package can send statements with it. Use a key that can only write statements, for this module. The learner is anonymous: an account named at random and kept in the browser.
- **Neither**: the player runs alone, as a SCORM package without its LMS.

## Runtime behaviour

As in cmi5 ([cmi5](delivery-cmi5.md#runtime-behaviour)), without cmi5's rules: `initialized` at the start; the place, the suspend data, the status and the score in a State API document (`stateId` `elabora-progress`, by registration when there is one); `completed` once complete, `passed` or `failed` with the score; `answered` for each answer; `terminated` when the session ends. xAPI 1.0.3, requests in order and never waited for.

## Emulator (`elabora test`)

The emulator's LRS (`packages/node/src/emulator/lrs.ts`) plays an LMS that launches Tin Can packages, with the checks of cmi5 that xAPI shares (the key of the launch, `X-Experience-API-Version`, statements with an actor, a verb and an object), and the scenario of every format.

```bash
elabora test examples/diagnostic-reseau --format xapi --profile scorm-cloud
```

## Beyond the emulator

- **An LRS is needed.** Without one, nothing is recorded.
- **Financing in France.** 360Learning leaves xAPI courses out of the OPCO reports it makes: deliver SCORM or cmi5 to a client whose training an OPCO finances.
- **Reporting.** An LMS that takes xAPI packages may show only completion and score; the statements are in its LRS, which few LMSs let clients read.
- **Keys in the package.** A key for a module outside an LMS is in the package: rent or set up a key that only writes.
