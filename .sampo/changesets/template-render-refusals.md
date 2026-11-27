---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Fixed)
---

A component template renders without what the validator refuses (D141): `renderTemplate` leaves out a refused element (links, forms, frames, scripts, media…) with what is inside it, an event handler, an address other than an SVG fragment, a style other than custom properties, and an image source other than one asset binding, from the same lists `checkTemplate` reports (`TEMPLATE_FORBIDDEN_TAGS`, `templateElementRefused`, `templateAttributeRefused`). In an SVG, `script`, `style`, `foreignObject` and an animation of `href` are refused and left out too. `E_COMPONENT_TEMPLATE` can no longer be waived by the plan.
