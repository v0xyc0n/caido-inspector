// Shared by the backend and the frontend: keep this file free of runtime
// imports so both bundles can include it.

export type Entry = {
  requestId: string;
  host: string;
  /** Path including the query string, as shown in the list. */
  path: string;
  savedAt: string;
  port?: number;
  isTls?: boolean;
  /** Collection the entry sits in; absent means uncategorised. */
  collectionId?: string;
};

/** A user-made category, mirroring Replay's collections. */
export type Collection = {
  id: string;
  name: string;
  collapsed?: boolean;
};

/** Everything saved for one project. */
export type ProjectData = {
  entries: Entry[];
  collections: Collection[];
};

/** What the frontend knows about a request it wants to save. */
export type Candidate = Omit<Entry, "savedAt" | "collectionId">;

export type Result<T> = { kind: "Ok"; value: T } | { kind: "Error"; error: string };

export function emptyProject(): ProjectData {
  return { entries: [], collections: [] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Rebuilds a candidate from untrusted input with only the known fields. Values
 * crossing the frontend/backend bridge may arrive as `null` instead of absent.
 */
export function toCandidate(value: unknown): Candidate | undefined {
  const c = record(value);
  if (c === undefined) return undefined;
  if (typeof c.requestId !== "string" || c.requestId === "") return undefined;
  if (typeof c.host !== "string" || typeof c.path !== "string") return undefined;
  return {
    requestId: c.requestId,
    host: c.host,
    path: c.path,
    port: typeof c.port === "number" ? c.port : undefined,
    isTls: typeof c.isTls === "boolean" ? c.isTls : undefined,
  };
}

export function toEntry(value: unknown): Entry | undefined {
  const candidate = toCandidate(value);
  const e = record(value);
  if (candidate === undefined || e === undefined || typeof e.savedAt !== "string") return undefined;
  return {
    ...candidate,
    savedAt: e.savedAt,
    collectionId: typeof e.collectionId === "string" ? e.collectionId : undefined,
  };
}

export function toCollection(value: unknown): Collection | undefined {
  const c = record(value);
  if (c === undefined || typeof c.id !== "string" || typeof c.name !== "string") return undefined;
  return { id: c.id, name: c.name, collapsed: c.collapsed === true ? true : undefined };
}

function compact<T>(values: (T | undefined)[]): T[] {
  return values.filter((v): v is T => v !== undefined);
}

/** Rebuilds a project file's content, dropping anything malformed. */
export function toProjectData(value: unknown): ProjectData {
  const data = record(value);
  if (data === undefined) return emptyProject();
  return {
    entries: Array.isArray(data.entries) ? compact(data.entries.map(toEntry)) : [],
    collections: Array.isArray(data.collections) ? compact(data.collections.map(toCollection)) : [],
  };
}
