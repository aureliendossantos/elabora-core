---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Changed)
npm/@elabora/engine: patch (Fixed)
---

The ElevenLabs key's page in a browser follows no redirect with the key, and gives back of `account` and `subscription` only the plan and its count (`SUBSCRIPTION_FIELDS`), never the account's ids or its key's preview (D136). A voice's sample is read from ElevenLabs' bucket only by a plain path (no escape, query, fragment or dot segment) or from its preview route on a host named in `PREVIEW_HOSTS`: the main one, the US one, and the EU's and India's data residency.
