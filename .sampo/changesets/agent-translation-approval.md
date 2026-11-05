---
npm/elabora: minor (Changed)
---

An agent can now approve a translated plan for the author, once the author says yes. Its first call writes nothing and returns what to ask: the plan, its texts translated, the name the approval shows (MCP `elabora_translation_approve`; `elabora translate approve` exits with code 3). With the author's yes, the agent calls again with `authorApproved`, the plan's content hash; a plan changed in between is asked again. The approval keeps the author's name and the agent's. Plan versions and a client's validation stay the author's to record.
