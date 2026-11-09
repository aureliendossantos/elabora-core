---
npm/elabora: patch (Added)
npm/@elabora/core: patch (Added)
---

`update_course`'s `patch` reaches inside a setting by its path (`"theme.tokens"`: the colours one by one) and changes speakers by id (their fields one by one, their voices by language; a new id joins with its name). Setting a speaker's voice now writes that voice alone, so a colour or a name changed meanwhile stays.
