---
npm/elabora: patch (Fixed)
npm/@elabora/node: patch (Fixed)
---

A request to Elabora's hosting made with a session the author has since left touches only that session: its refusal no longer signs out the session signed in after it (it ends as `session-replaced`), and its answer no longer writes its account's address into the new session. The same holds for a read-only AI key replaced meanwhile.
