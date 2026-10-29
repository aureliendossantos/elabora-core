---
npm/elabora: patch (Added)
npm/@elabora/format: patch (Added)
npm/@elabora/core: patch (Added)
---

Schemas 0.1.6: a fork drops the parent's props it does not use with `propsOmit` (`"propsOmit": ["body", "steps"]`), so they are no longer reported unused and instances may no longer give them. A name the parent lacks, a `propsOmit` without `extends`, or a prop the parent's behaviour needs is refused (`E_COMPONENT_SCHEMA`).
