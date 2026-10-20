---
npm/elabora: minor (Changed)
npm/@elabora/node: minor (Changed)
npm/@elabora/cli: minor (Changed)
---

Readable versions of an author's sources no longer use LibreOffice or poppler, which are rarely installed, cannot ship with Elabora and could not be tested in CI. A PowerPoint deck gives, slide by slide, its texts, speaker's notes and the pictures the slide places (pictures, shapes filled with a picture, the background), each at its place in the reading order, with the file's thumbnail; icons, bullets and rules are left out and counted in the notes, and the readable version says that slides are not drawn and that the deck added as a PDF shows them. A file in an older office format (.doc, .rtf, .odt, .ppt, .pps, .odp, .key) is reported as unsupported with notes that say to save it as .docx or .pptx, or as a PDF, from the application that made it. PDFs are read as they are. ELABORA_SOFFICE, ELABORA_PDFTOPPM, ELABORA_PDFTOTEXT, the render option of makeSourcesReadable and findOfficeTools are removed.
