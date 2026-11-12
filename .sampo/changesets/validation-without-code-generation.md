---
npm/elabora: minor (Changed)
npm/@elabora/format: minor (Changed)
npm/@elabora/core: minor (Changed)
---

`getAjv` is gone from `@elabora/format`. Validation no longer generates code at run time, so it runs where `eval` and `new Function` are forbidden (a Cloudflare Worker, a page under a strict content security policy). The format's schemas are compiled when `pnpm run gen` runs, and the schemas of components and free objects are read by an interpreter that gives the same errors as before. A component or object schema that uses `contains`, `dependentRequired`, `dependentSchemas`, `unevaluatedItems`, `$anchor` or `$dynamicRef` now says it does not compile.
