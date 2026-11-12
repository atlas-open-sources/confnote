/** Storage-independent per-note revision boundary; Cat can keep its local runtime. */
export interface NoteRevision { observe(text: string): Promise<number> }
export interface NoteCoordinator {
  run<T>(key: string, action: (revision: NoteRevision) => Promise<T>): Promise<T>;
}
