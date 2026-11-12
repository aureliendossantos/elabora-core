---
npm/@elabora/core: minor (Added)
npm/@elabora/engine: patch (Changed)
---

A room's refusals are named in the protocol (D85): `E_SYNC_READ_ONLY`, `E_SYNC_PATH`, `E_SYNC_TOO_LARGE`, `E_SYNC_TOO_MANY_FILES`, `E_SYNC_BLOB_MISSING` and `E_SYNC_ID_USED` join the core's four (`RefusalCode`, `REFUSAL_CODES`). A change whose medium the room could not find is sent again, its media first, up to three times; the other refusals end the change as before.
