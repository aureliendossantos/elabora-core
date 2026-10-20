---
name: elabora-translation
description: Translate or localise an Elabora course, use translation tables/XLIFF, verify completeness and word anchors, build per-language packages and preserve human plan approval.
---

## Translating a course
One package per language; the translations stay in the source course.
1. Read `elabora_translation_table { language: "de" }` (`screen` narrows it; `todo: true` lists work left). No export is needed to start a language. For an external translator, `elabora translate export . --to de` creates or updates `translations/de.xlf` (XLIFF 2.0).
2. Write `elabora_translate_text { language: "de", texts: [{ unit, target }] }`: a batch is one validated, undoable change, and starts the language automatically. Keep Markdown, `$…$` maths (decimal commas inside maths as `2{,}5`), links, code and placeholders; place narration word markers on the corresponding translated words. Alternatively edit XLIFF targets and mark segments `state="translated"`. The app shows the same texts in « Traduction » and in context.
3. Check `elabora_translation_status { language: "de" }` (`elabora translate status . --to de --json`) until `ready`: no missing, stale or broken texts or unplaced word anchors. Plan approval is separate. See `elabora_look { language: "de", screen }` while translating.
4. From the **source course's same server**, use `elabora_validate`, `elabora_check_fit`, `elabora_preview_screenshot`, `elabora_build` and `elabora_test_package` with `language: "de"`. Builds write the translated package and proof into the source's `dist/`; no server switch or generated-folder editing. `allowMissing: true` on checks/build/test explicitly permits a draft (source text for missing/stale units; unplaced word anchors at line starts). Fix translation or design in the source. `release: true` requires human plan approval. The convenient CLI alternative is `elabora translate build . --to de --out ../<course>-de --json`, then validate, fit, screenshot, build and test that copy.
5. A person approves the translated plan: `elabora translate approve . --to de --by "<name, organisation>"`. Never record that approval yourself. Source changes make affected units stale; their previous translation is kept for review. Every tool above also works through `elabora tools call <tool> . --args '<json>'` without MCP.
