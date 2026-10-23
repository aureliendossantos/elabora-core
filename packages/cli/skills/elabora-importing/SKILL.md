---
name: elabora-importing
description: Import and repair Storyline 360 and Rise 360 course projects or exports, review import-report.json decisions and losses, and validate the converted course.
---

## A module made with Storyline or Rise
When the author brings a Storyline 360 project (`.story`), a course Storyline published (a folder, a zip, its `story.html`) or a Rise 360 export, import it rather than rebuilding it by hand: `elabora import <file> <new folder>` (beta; without a folder it goes into the app's library). Then read `import-report.json` in the new course: its `summary`, its `decisions` (tell the author each one and its choices; `--choose <decision>=<choice>` imports again with another, into a new folder), its `losses`, and the `note` of the blocks that stand for a feature Elabora has no block for yet. Finish the work they list: write the plan's objective and the items' kinds (the plan is a draft), alternative texts, captions and transcripts, real feedback where a question got a generic one, media to replace (Articulate's Content Library may not be used outside its tools), and lay screens out again where the reading order is wrong. Check slides with `elabora look` and `elabora fit`. A Rise scenario becomes a dialogue block: reread it with `elabora dialogue show` and `paths`, give its options a quality, and see skill `elabora-dialogues`.
