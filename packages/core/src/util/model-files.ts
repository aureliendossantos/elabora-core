// A file of a model a host downloads once (the word aligners, the local voices): where it is on the
// models' host, and the size and SHA-256 that pin it.
export interface ModelFile {
  name: string;
  url: string;   // path on the host, from the repository name
  size: number;
  sha256: string;
}
