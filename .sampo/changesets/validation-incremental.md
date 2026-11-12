---
npm/@elabora/core: minor (Added)
npm/@elabora/engine: patch (Changed)
---

A project's validation kept change by change (D86): `@elabora/core/validate/incremental` gives `validationState(files)`, `revalidate(previous, files)` (only what the files changed can affect runs again, with the same findings as `validateProject`) and `newErrors(before, after)`, the errors a change adds. At 200 screens, a change to a screen is validated in a tenth of the time of a whole validation. The engine's session uses the same rules from the core.
