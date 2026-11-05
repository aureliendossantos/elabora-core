---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Fixed)
---

A statement block whose words are a validated text of the plan (`textRef`) shows them: it showed nothing, as only text, callout and heading blocks took the plan's wording. Its checks read the same words (`W_QUOTE_REPEATS`, its maths), and translating it in context finds them in the statement.
