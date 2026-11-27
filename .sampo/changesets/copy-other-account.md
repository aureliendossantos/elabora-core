---
npm/elabora: patch (Fixed)
npm/@elabora/engine: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

A folder linked for one account no longer sends its changes under the session of another account signed in on the same computer: the copy asks who the session is before its first connection (`account` in the cloud options, which `cloudSessionOptions` gives from `/v1/account`), and a copy linked for another account never connects, keeps its changes and its link, is not tried again, and says `held: 'other-account'`; a session the hosting no longer knows says `held: 'signed-out'`.
