---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

« Ajouter une ressource »: any file (a PDF, a spreadsheet, a document, an image) is copied as it is into assets/resources/ under a readable name and added to the player's resources in one undoable change, titled by the title given, else the PDF's own title, else the file's name. The engine runs it as add_resource, the CLI as elabora player --add-resource <file> [--title] [--description], and agents through elabora_player addResources. Undoing it removes the copy.
