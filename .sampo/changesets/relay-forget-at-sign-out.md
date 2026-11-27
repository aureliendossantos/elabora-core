---
npm/elabora: patch (Fixed)
npm/@elabora/player: patch (Added)
---

What the player keeps of a person on the web app's canvas and frames hosts can go when the person signs out: `forgetHostStorage({ origins })` (`@elabora/player/relay-forget`) frames each host's relay page, hidden, and asks it to empty its origin's local and session storage (`relay/forget`), where the player keeps display settings and a preview's progress by module. The relay's kept files stay.
