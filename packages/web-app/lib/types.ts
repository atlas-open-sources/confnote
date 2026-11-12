import type { StorageAdapter } from "./storage.js";
import type { NoteCoordinator, NoteRevision } from "./note-coordination.js";
import type { Principal } from "../../auth/src/index.js";
export type Frontmatter = Record<string, string>;

export interface ParsedNote {
  frontmatter: Frontmatter;
  title: string;
  sections: Record<string, string>;
}

export interface StoredObject {
  path: string;
  size: number;
  mtime: number;
  etag?: string;
}

export interface StoredText {
  text: string;
  mtime: number;
  etag?: string;
}

export interface StoredBytes {
  bytes: Uint8Array;
  contentType: string;
  mtime: number;
  size: number;
  etag?: string;
}

export interface AgendaSpeaker {
  name?: string;
  role?: string;
  title?: string;
  company?: string;
  bio?: string;
  social?: Record<string, string>;
}

export interface AgendaNamedItem {
  id?: string;
  name?: string;
}

export interface AgendaEvent {
  session_id?: string;
  day?: string;
  note_file?: string;
  id?: string;
  type?: string;
  title?: string;
  description?: string;
  start?: string;
  end?: string;
  room?: string;
  track?: string;
  tags?: string[];
  speakers?: string[];
  links?: Array<string | { label?: string; title?: string; url?: string }>;
}

export interface AgendaData {
  schema_version?: string;
  conference: {
    name: string;
    tagline?: string;
    organiser?: string;
    contact?: string;
    date: string;
    start_date?: string;
    end_date?: string;
    timezone?: string;
    venue?: { name?: string; address?: string };
    social?: Record<string, string>;
  };
  rooms?: AgendaNamedItem[];
  tracks?: AgendaNamedItem[];
  speakers?: Record<string, AgendaSpeaker>;
  events: AgendaEvent[];
  sources?: Array<{ url?: string; label?: string; retrieved_at?: string }>;
}

export interface RequestContext {
  abortSignal?: AbortSignal;
  storage?: StorageAdapter;
  notes?: NoteCoordinator;
  noteRevision?: NoteRevision;
  allocateConference?: (agenda: AgendaData) => Promise<string>;
  principal?: Principal;
  workspace: string;
  publicDemo?: boolean;
  origin?: string;
}
