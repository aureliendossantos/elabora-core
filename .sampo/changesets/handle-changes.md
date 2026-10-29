---
npm/elabora: patch (Added)
npm/@elabora/node: patch (Added)
npm/@elabora/cli: patch (Added)
npm/@elabora/player: patch (Changed)
---

An account's handle can change, once in 30 days, as Elabora's hosting now allows (protocol 7): `elabora account handle <name> --change` renames the space after saying what it does (the old address stops at once with no redirect, links to it break, learners start their progress again, and the old name is held a year), and `elabora account status` says when the next change is allowed. A module built for the web forgets the progress it kept in the browser a year after the learner's last visit: each save dates it, and each visit saves (D41).
