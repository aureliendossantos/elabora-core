---
npm/elabora: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

Module templates (D68): four courses whose charter is the product, in `templates/` (CC0, fonts under the SIL OFL): Organic (soft gradient blobs that drift from warm to cool tones, one hue per part), Flow (luminous ribbons and particles that leap at each new screen), Clear (one accent, a strict grid, a rule that moves to the part in progress) and Shapes (Bauhaus shapes that compose a new tableau for each part). Each has the same 14 screens of placeholder texts made of the core's blocks, the same sections and plan, two or three backdrop variants and a French translation. `elabora templates` lists them; `elabora init <dir> --template <id>` and `elabora projects create --template <id>` make a course from one, under the author's id and title (the cover says it), in the language asked when the template is translated into it, with AGENTS.md notes that say where it comes from; the library's `createProject` takes a template folder and records the project's origin (`kind: "template"`).
