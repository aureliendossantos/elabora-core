---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
---

A copy whose room closes it because its session ended (4009: signed out, the device revoked, the session expired) no longer reconnects in a loop against a refusal: it keeps its changes and its link, is not tried again, even when asked, and `cloudStatus` says `held: 'signed-out'`.
