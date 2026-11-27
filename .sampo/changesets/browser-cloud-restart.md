---
npm/elabora: patch (Added)
npm/@elabora/engine: patch (Added)
---

The protocol's `cloudRestart { account? }` tries again a browser's copy held `signed-out` or `other-account` once someone signed in, without reloading: with the account the window says, or the one the hosting's cookie is, it syncs when that account is its link's and is held again otherwise (`restarted: false` for a copy not held so). A desktop session answers `not-available` (`E_NOT_HERE`): its host restarts it with `Session.cloudRestart`.
