---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Added)
npm/@elabora/node: patch (Fixed)
---

A course made from a template no longer carries its free objects' visual baselines (`objects/<id>/__snapshots__/`, up to 4 MB for `watercolor`): they are the template's tests, and `elabora object test` records them again on its first run. `isTestFile` in `@elabora/core/project/files` says which files are a free object's tests, for a host that ships examples or templates.
