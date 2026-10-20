---
name: elabora-course-authoring
description: Plan, screen, event, review and delivery workflow for an Elabora course. Read for general course editing; open a focused reference only when the task needs its details.
---

# Authoring an Elabora course

The working `plan.json` fixes what is taught, said and assessed; screens implement it. Start with the course `AGENTS.md`, its author notes and `elabora_overview` / `elabora project .`. Read only relevant sources via `elabora_source_read` and the current plan via `elabora_get_plan`.

## Choose a reference only when needed
- **New course, objectives, plan decisions, revisions or renames:** `plan-and-maintenance`.
- **Create/edit screens, native blocks, media, events or interactive practice:** `screens-and-events`.
- **Build/test, web packaging, online review comments or undo:** `delivery-and-review`.
- **Voice, timed visuals and paid-provider quota:** load separate skill `elabora-narration`.
- **Translation or Storyline/Rise imports:** load `elabora-translation` or `elabora-importing`.
- **Pedagogy, design, component structure or free objects:** load their specialist skills, not all of them by default.

CLI: `elabora tools skills elabora-course-authoring <reference>`. MCP resources: `elabora://skills/elabora-course-authoring/references/<reference>`.

## Short workflow
1. Read the author notes, relevant source materials, plan and `elabora project .`. For a placeholder plan, write a complete draft even from a vague brief, recording choices in `decided` and at most one `question`. Never make or validate plan versions.
2. Build screens covering plan items. Use `elabora_list_components` and `elabora_get_schema`; prefer blocks and reused components. Reference validated text/questions instead of copying. For media, use `elabora_media_import`; for renames, `elabora_rename`.
3. Add practice/feedback at the right level. Use declarative events and layers, not custom code unless no built-in structure suffices. See `elabora-pedagogy` for instructional guidance.
4. Read diagnostics after edits; run `elabora_validate`. Check in proportion to what the change does: a presentation-only fix (timing, easing, colour, a decoration that moves nothing) needs one `elabora_look` of the affected screen in the state that shows it, and no plan change, fit or object gates; a layout change adds `elabora_check_fit` on the screens it reaches; content, structure or behaviour take the whole route. Broaden only when a check reveals a problem. Before handoff, `elabora_check_fit`, screenshots and relevant tests.
5. For delivery, choose an LMS profile, build and test. The author handles approvals, publishing and resolving reviews. Reports of changes belong in your handoff.

MCP and CLI use the same operations: `elabora tools guide`, `elabora tools list <tool> --json`, `elabora tools call <tool> . --args '<json>'` (or `--from <file>`), which prints the tool's JSON. Direct edits to CSS, templates, object code and screen JSON are fine when file access exists, followed by validation. Do not alter the author's MCP settings.
