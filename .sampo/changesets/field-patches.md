---
npm/elabora: patch (Added)
npm/@elabora/core: patch (Added)
---

`update_course` takes `patch`: keys of a setting (delivery, navigation, narration…) changed one by one on course.json as it is when the change is written (null removes one). `upsert_layer` without `blocks` changes an existing layer's fields one by one, its blocks and narration as they are.
