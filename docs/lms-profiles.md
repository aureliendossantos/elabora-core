# LMS profiles

Generated from `profiles/*.json`. "?" = not documented: to be measured in a real instance (`toMeasure`). **Format**: the one Elabora picks for a module that names this LMS alone (course.json delivery.lms, delivery.format auto; [Delivery formats](delivery.md)).

| Profile | Documented | Format | SCORM 1.2 | SCORM 2004 | cmi5 | xAPI | Launch | suspend_data 1.2 / 2004 | Package | Update |
|---|---|---|---|---|---|---|---|---|---|---|
| **360learning** — 360Learning | 2026-09-15 | SCORM 2004 (4th edition) | ✔ | 2nd, 3rd, 4th | ✔ | discouraged | iframe | 4096 / 64000 (accept) | ≤ 4096 MB extracted, ≤ 50000 files, ratio ≤ 200 | replace-loses-progress |
| **cornerstone** — Cornerstone (release 26.2) | 2026-09-18 | SCORM 2004 (3rd edition) | ✔ | 3rd, 4th | ✘ | ✔ | iframe, popup, new-tab | ? / ? | ≤ 2048 MB | lms-versioning |
| **docebo** — Docebo | 2026-09-03 | SCORM 2004 (3rd edition) | ✔ | 3rd | ? | ✔ | nested-iframe, iframe, popup | 4096 / 64000 | ≤ 1024 MB | in-place-if-same-structure |
| **moodle** — Moodle 4.5–5.2 (mod_scorm) | 2026-09 | SCORM 1.2 | ✔ | ✘ | plugin | plugin | iframe, popup | 4096 / ? (reject) | ? | auto-update |
| **rise-up** — Rise Up | 2026-09 | SCORM 2004 (4th edition) | ✔ | 2nd, 3rd, 4th | ? | ? | iframe | ? / ? | ≤ 1024 MB | in-place-if-same-structure |
| **scorm-cloud** — SCORM Cloud (Rustici) — reference test environment | 2026-10 | SCORM 2004 (4th edition) | ✔ | 2nd, 3rd, 4th | ✔ | ✔ | iframe, popup | 64000 / 64000 | ? | lms-versioning |
| **successfactors** — SAP SuccessFactors Learning (2H 2026) | 2026-10 | SCORM 2004 (4th edition) | ✔ | 2nd, 4th | ✘ | ✘ | popup-chain, popup, iframe | 64000 / 4000 | ? | lms-versioning |
| **teach-up** — Teach Up (import) | 2026-09 | SCORM 1.2 | ✔ | ? | ? | ? | iframe, popup | ? / ? | ≤ 100 MB | ? |
| **totara** — Totara 20 | 2026-09 | SCORM 1.2 | ✔ | ✘ | ? | plugin | iframe, popup | 4096 / ? (reject) | ? | auto-update |
| **unknown** — Unknown LMS (no LMS chosen: strictest documented behaviour) | 2026-10 | SCORM 1.2 | ✔ | ✘ | ✘ | ✘ | iframe, popup, popup-chain, nested-iframe | 4096 / 4000 (reject) | ? | replace-loses-progress |
| **workday** — Workday Learning | 2026-10 | SCORM 2004 (4th edition) | ✔ | 2nd, 3rd, 4th | ✘ | ✘ | popup | ? / ? | ≤ 2048 MB, ≤ 20480 MB extracted, ≤ 100000 files | ? |

## Notes

**360Learning**
- Format: SCORM 2004 (4th edition). SCORM 2004 2nd to 4th editions are processed and suspend_data is kept as sent (64,000 characters in the 3rd and 4th). cmi5, which the vendor recommends, cannot be previewed, and xAPI courses are left out of OPCO reports.
- xAPI courses are excluded from OPCO funding reports: deliver SCORM or cmi5 to French clients.
- cmi5 recommended by the vendor but without preview; launchMethod AnyWindow.
- Connected (dispatch) packages refused.
- Package limits: 4 GB once extracted, 50,000 files, compression ratio 200; no limit on the size of the ZIP itself.
- xAPI is supported but discouraged.
- SCORM 2004 4th edition: cmi.progress_measure shows the progress of an attempt in progress; completion needs cmi.completion_status completed.
- Sources: [Create a course by importing an eLearning file](https://support.360learning.com/hc/en-us/articles/38322663301268-Create-a-course-by-importing-an-eLearning-file)

**Cornerstone (release 26.2)**
- Format: SCORM 2004 (3rd edition). The general requirements name SCORM 2004 3rd edition and recommend it; the 4th edition runtime arrived with release 26.2 (September 2026). One SCO without sequencing calls the same API in both.
- Third-party cookies must be allowed on *.csod.com: test with cookies blocked and document the iOS / private browsing risk.
- One standard per ZIP.
- xAPI (tincan.xml): launched in an iframe by default ("Launch xAPI Course in iFrame"); its JWT token lasts 1,440 minutes at most.
- Sources: [Cornerstone 26.2 — SCORM 2004 4th edition](https://help.csod.com/help/csod_0/Content/0_Whats_New/262/Learning/LMS_support_for_SCORM_2004_4th_Edition.htm) · [Cornerstone general minimum requirements](https://help.csod.com/help/csod_0/Content/General_Minimum_Requirements.htm) · [Modify an online course](https://help.csod.com/help/csod_0/Content/Content/Content_Uploader/Online_Course_Versioning/Modify_an_Online_Course.htm) · [Cornerstone xAPI Package Support](https://help.csod.com/help/csod_0/Content/Catalog/xAPI_Package_Support/xAPI_Support.htm)

**Docebo**
- Format: SCORM 2004 (3rd edition). SCORM 2004 3rd edition, without sequencing, with 64,000 characters of suspend_data instead of SCORM 1.2's 4,096.
- Theater and inline modes add one iframe level; every ancestor iframe needs allow="clipboard-read; clipboard-write" for clipboard access.
- Single completion update.
- No file count limit: Docebo "strongly suggests" at most 15,000 files, it does not refuse more.
- cmi5: no help article mentions it (search of October 2026): not documented, which is not a refusal.
- xAPI: "Tin Can Standard 1.0"; the package needs a tincan.xml for the LRS to know its activity ids.
- Sources: [Uploading and managing SCORM as training material](https://help.docebo.com/hc/en-us/articles/360020128479-Uploading-and-managing-SCORM-as-training-material)

**Moodle 4.5–5.2 (mod_scorm)**
- Format: SCORM 1.2. SCORM 2004 support is partial and closed as won't fix: SCORM 1.2, which Moodle passes the ADL conformance tests for.
- scorm12standard = true by default: 4,096 characters of suspend_data enforced.
- Mastery score overrides lesson_status: send a score consistent with the status.
- SCORM 2004 support is partial and marked won't fix: target SCORM 1.2.
- cmi5 and xAPI only with plugins (mod_cmi5launch needs a CATAPULT player and an LRS).
- Sources: [Moodle SCORM settings](https://docs.moodle.org/en/SCORM_settings) · [Moodle SCORM FAQ](https://docs.moodle.org/en/SCORM_FAQ) · [MDL-89642 (error 101, data loss in Chrome popups)](https://tracker.moodle.org/browse/MDL-89642)

**Rise Up**
- Format: SCORM 2004 (4th edition). Rise Up reads cmi.score.scaled in SCORM 2004 and documents the 2nd to 4th editions; one SCO, as it refuses multi-SCO packages.
- Avoid popups; send final status and score when decided.
- No accents in file names.
- Sources: [SCORM sur Rise Up : compatibilité, suivi de progression](https://helpdesk.riseup.ai/hc/fr/articles/33353469495058-SCORM-sur-Rise-Up-Compatibilit%C3%A9-suivi-de-progression)

**SCORM Cloud (Rustici) — reference test environment**
- Format: SCORM 2004 (4th edition). The reference implementation of every SCORM edition: the 4th edition tests completion and success apart.
- Free Trial tier: 10 recyclable registrations, API included. Use it as the smoke test of the pyramid, not as the only target.
- Player settings (Player*) catalogue LMS quirks.
- No package size limit on paid accounts; a trial account has 100 MB of extracted space for all its courses (support article of 2019).
- Sources: [SCORM Cloud plans](https://rusticisoftware.com/products/scorm-cloud/pricing/) · [SCORM Cloud Release 11/11/2024 (unload)](https://support.scorm.com/hc/en-us/articles/30836282226075-SCORM-Cloud-Release-11-11-2024) · [Error importing a course to SCORM Cloud (trial accounts)](https://support.scorm.com/hc/en-us/articles/206163536-Error-Importing-a-course-to-SCORM-Cloud)

**SAP SuccessFactors Learning (2H 2026)**
- Format: SCORM 2004 (4th edition). SCORM 2004 2nd and 4th editions are documented (the 3rd only within the 2nd's features); 2004 reports completion and success apart, where SCORM 1.2 needs the item's status mapping (Passed/Failed or Complete/Failed).
- Documented suspend_data limits are the reverse of the specifications (1.2 = 64,000; 2004 = 4,000): to be measured.
- Content launched in a popup by default; the API lives in the opener chain (up to top.opener.opener). The content must never open its own window.
- cmi.core.exit = logout ends the LMS session: never use it.
- No cross-DNS SCORM API; Proxlet WAR or cookie-based cross-domain solutions only.
- No published package size limit: the content import accepts files up to the tenant's CONTENT IMPORT maximumFileSizeKB (System Configuration), which an administrator sets; the legacy SCORM import stops at LMS_ADMIN fileUploadMaxSize (10 MB in KBA 2428881).
- Files over 1,800 MB are not cached by Akamai and not supported in iContent (KBA 2984975): keep each media file under that size.
- Sources: [SAP SuccessFactors Learning content implementation guide (2611)](https://help.sap.com/doc/fe0d730664ce418e8bd7d69919d9eaa1/2611/en-US/LRN_Content_Impl_en.pdf) · [KBA 2294748: How to increase the size of the content import and timeout settings](https://userapps.support.sap.com/sap/support/knowledge/en/2294748) · [KBA 2622763: File size error when importing content](https://userapps.support.sap.com/sap/support/knowledge/en/2622763) · [KBA 2428881: Legacy SCORM import failed (Error 502)](https://userapps.support.sap.com/sap/support/knowledge/en/2428881) · [KBA 2984975: Courses may fail to load or display error messages](https://userapps.support.sap.com/sap/support/knowledge/en/2984975)

**Teach Up (import)**
- Format: SCORM 1.2. Only SCORM imports are documented, without an edition of SCORM 2004: SCORM 1.2.
- Smallest documented package cap (100 MB): watch 3D assets.
- Packages over 100 MB are refused, and the limit may be lower depending on the subscription.
- Sources: [Insérer un module SCORM](https://support.teachup.com/fr/ins%C3%A9rer-un)

**Totara 20**
- Format: SCORM 1.2. Totara does not support SCORM 2004's run-time environment: SCORM 1.2.
- "SCORM 1.2 standard" mode: 4,096 characters.
- Mastery score overrides the status.
- Sources: [Totara 20 SCORM activity settings](https://totara.help/totara-20/docs/scorm-activity-settings) · [Totara SCORM activity](https://totara.help/docs/add-a-scorm-activity)

**Unknown LMS (no LMS chosen: strictest documented behaviour)**
- Format: SCORM 1.2. No LMS chosen: SCORM 1.2, the one format every LMS takes.
- Lowest common denominator: SCORM 1.2 single SCO, no sequencing, no popup opened by the content, 4,096 characters of suspend_data.
- No package size, file count or compression limit is assumed: they differ too much between LMSs (100 MB to 4 GB). The build warns with the documented LMSs a package would exceed (W_PACKAGE_TOO_LARGE_FOR_SOME_LMS and the like) until the course names its LMS (course.json delivery.lms).

**Workday Learning**
- Format: SCORM 2004 (4th edition). SCORM 2004 2nd to 4th editions are documented; completion and success apart.
- Three statuses: Not Started, In Progress, Completed; grade only if Provide Course Grade.
- SCORM is not cross-domain: Workday hosts the package.
- Uploads are limited to 2 GB by default for new tenants. With Increase Maximum Upload Size (Edit Tenant Setup - HCM), a ZIP of up to 4 GB goes through Drive or the Learning file picker and up to 20 GB through the Media Import service, but uploads over 2 GB are not scanned for viruses.
- cmi5 and xAPI are not documented; Skilljar lists Workday among the LMSs its xAPI and cmi5 launches do not support.
- Sources: [Workday packaged content](https://doc.workday.com/admin-guide/en-us/human-capital-management/learning/learning-content/packaged-content/hfx1625670674607.html) · [Workday packaged content limits](https://doc.workday.com/admin-guide/en-us/human-capital-management/learning/learning-content/packaged-content/jgo1522169899445.html)
