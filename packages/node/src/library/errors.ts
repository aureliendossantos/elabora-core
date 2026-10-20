// Errors of the project library and archives. The code tells the CLI, the MCP server and the app
// what happened without parsing the message.
export type LibraryErrorCode =
  | 'E_PROJECT_NOT_FOUND'     // no library project with that id
  | 'E_NOT_A_COURSE'          // a folder or archive without course.json
  | 'E_ALREADY_IN_LIBRARY'    // importFolder of a folder that is a library project
  | 'E_FILE_UNAVAILABLE'      // a project file that cannot be read (permissions, only in the cloud)
  | 'E_RESERVED_NAME'         // a project file named like a part of the archive format (elabora-archive.json)
  | 'E_ARCHIVE_INVALID'       // not an Elabora archive, or a manifest this version cannot read
  | 'E_ARCHIVE_NEWER'         // made by a newer Elabora (archive or course format)
  | 'E_ARCHIVE_DAMAGED'       // an entry missing, extra, or whose content does not match its hash
  | 'E_ARCHIVE_UNSAFE_PATH'   // an entry that would be written outside the project or into tool folders
  | 'E_ARCHIVE_TOO_LARGE'     // the archive would pass the 4 GB limit of ZIP without ZIP64
  | 'E_ARCHIVE_TARGET'        // the archive would be written inside the project
  | 'E_NOT_ENOUGH_SPACE'      // the disk cannot hold what an import or move would write
  | 'E_REPLACE_TARGET'        // which project to replace is unclear, or it holds another course
  | 'E_TRASH_ENTRY'           // no such entry in the trash
  | 'E_LIBRARY_LOCATION'      // a library location that cannot be used (ELABORA_LIBRARY set, not empty, nested)
  | 'E_SETTINGS'              // the user's Elabora settings file cannot be read
  | 'E_INVALID_ARGUMENT';     // a value the caller gave cannot be used (an empty title)

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: LibraryErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
    this.details = details;
  }
}
