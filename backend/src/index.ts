import type { DefineAPI, DefineEvents, SDK } from "caido:plugin";
import { randomUUID } from "crypto";
import { access, mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";

import {
  type Candidate,
  type Collection,
  type ProjectData,
  type Result,
  emptyProject,
  toCandidate,
  toProjectData,
} from "./model";

export type { Candidate, Collection, Entry, ProjectData, Result } from "./model";

/**
 * Saved requests live here, one JSON file per project, instead of in the
 * frontend's `sdk.storage`. That storage is a single blob shared by every open
 * client and written whole, so a client with a stale copy (a second window or
 * browser tab) silently overwrote everyone else's changes. The backend is the
 * one writer; every change is a small operation applied to the current file.
 */

const MAX_NAME_LENGTH = 200;

/** Project ids are UUIDs; anything else must not reach a file path. */
const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;

type BackendSDK = SDK<API, BackendEvents>;

const cache = new Map<string, ProjectData>();

/** Serializes every read-modify-write, across all projects. */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function fail(error: unknown): { kind: "Error"; error: string } {
  return { kind: "Error", error: error instanceof Error ? error.message : String(error) };
}

function checkProjectId(projectId: unknown): string {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
    throw new Error("Invalid project id");
  }
  return projectId;
}

function checkName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "") throw new Error("Name must not be empty");
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`Name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function fileFor(sdk: BackendSDK, projectId: string): string {
  return path.join(sdk.meta.path(), "projects", `${projectId}.json`);
}

async function exists(file: string): Promise<boolean> {
  // QuickJS errors carry no reliable `code`, so probe instead of catching ENOENT.
  return access(file).then(
    () => true,
    () => false
  );
}

/** A corrupt file throws, which aborts the change instead of overwriting it. */
async function load(sdk: BackendSDK, projectId: string): Promise<ProjectData> {
  const cached = cache.get(projectId);
  if (cached !== undefined) return cached;
  const file = fileFor(sdk, projectId);
  const data = (await exists(file))
    ? toProjectData(JSON.parse(await readFile(file, "utf-8")))
    : emptyProject();
  cache.set(projectId, data);
  return data;
}

async function save(sdk: BackendSDK, projectId: string, data: ProjectData): Promise<void> {
  const file = fileFor(sdk, projectId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
  cache.set(projectId, data);
  sdk.api.send("inspector:changed", projectId);
}

/** Applies `transform` to one project; returning `undefined` means no change. */
function update(
  sdk: BackendSDK,
  projectId: unknown,
  transform: (data: ProjectData) => ProjectData | undefined
): Promise<Result<ProjectData>> {
  return serialized(async () => {
    try {
      const id = checkProjectId(projectId);
      const current = await load(sdk, id);
      const next = transform(current);
      if (next === undefined) return { kind: "Ok", value: current };
      await save(sdk, id, next);
      return { kind: "Ok", value: next };
    } catch (err) {
      return fail(err);
    }
  });
}

// ─── API ──────────────────────────────────────────────────────────────────────

function getProject(sdk: BackendSDK, projectId: string): Promise<Result<ProjectData>> {
  return serialized(async () => {
    try {
      return { kind: "Ok", value: await load(sdk, checkProjectId(projectId)) };
    } catch (err) {
      return fail(err);
    }
  });
}

/** Saves new requests at the top of the list; ones already saved are skipped. */
async function addEntries(
  sdk: BackendSDK,
  projectId: string,
  candidates: Candidate[]
): Promise<Result<{ data: ProjectData; added: number }>> {
  const valid = (Array.isArray(candidates) ? candidates : [])
    .map(toCandidate)
    .filter((c): c is Candidate => c !== undefined);
  let added = 0;

  const result = await update(sdk, projectId, (data) => {
    const seen = new Set(data.entries.map((e) => e.requestId));
    const savedAt = new Date().toISOString();
    const fresh = [];
    for (const candidate of valid) {
      if (seen.has(candidate.requestId)) continue;
      seen.add(candidate.requestId);
      fresh.push({ ...candidate, savedAt });
    }
    added = fresh.length;
    if (fresh.length === 0) return undefined;
    return { ...data, entries: [...fresh.reverse(), ...data.entries] };
  });

  if (result.kind === "Error") return result;
  return { kind: "Ok", value: { data: result.value, added } };
}

function removeEntry(
  sdk: BackendSDK,
  projectId: string,
  requestId: string
): Promise<Result<ProjectData>> {
  return update(sdk, projectId, (data) => ({
    ...data,
    entries: data.entries.filter((e) => e.requestId !== requestId),
  }));
}

/** Removes every saved request; collections are kept. */
function clearEntries(sdk: BackendSDK, projectId: string): Promise<Result<ProjectData>> {
  return update(sdk, projectId, (data) =>
    data.entries.length === 0 ? undefined : { ...data, entries: [] }
  );
}

/** An empty or missing `collectionId` moves the entry to uncategorised. */
function moveEntry(
  sdk: BackendSDK,
  projectId: string,
  requestId: string,
  collectionId?: string
): Promise<Result<ProjectData>> {
  const target = typeof collectionId === "string" && collectionId !== "" ? collectionId : undefined;
  return update(sdk, projectId, (data) => {
    if (target !== undefined && !data.collections.some((c) => c.id === target)) {
      throw new Error("Collection no longer exists");
    }
    return {
      ...data,
      entries: data.entries.map((e) =>
        e.requestId === requestId ? { ...e, collectionId: target } : e
      ),
    };
  });
}

/** Optionally files `requestId` into the new collection in the same change. */
function createCollection(
  sdk: BackendSDK,
  projectId: string,
  name: string,
  requestId?: string
): Promise<Result<ProjectData>> {
  return update(sdk, projectId, (data) => {
    const collection: Collection = { id: randomUUID(), name: checkName(name) };
    return {
      collections: [...data.collections, collection],
      entries: data.entries.map((e) =>
        e.requestId === requestId ? { ...e, collectionId: collection.id } : e
      ),
    };
  });
}

function renameCollection(
  sdk: BackendSDK,
  projectId: string,
  collectionId: string,
  name: string
): Promise<Result<ProjectData>> {
  return update(sdk, projectId, (data) => {
    const checked = checkName(name);
    return {
      ...data,
      collections: data.collections.map((c) => (c.id === collectionId ? { ...c, name: checked } : c)),
    };
  });
}

/** Deleting a collection keeps its requests; they fall back to uncategorised. */
function deleteCollection(
  sdk: BackendSDK,
  projectId: string,
  collectionId: string
): Promise<Result<ProjectData>> {
  return update(sdk, projectId, (data) => ({
    collections: data.collections.filter((c) => c.id !== collectionId),
    entries: data.entries.map((e) =>
      e.collectionId === collectionId ? { ...e, collectionId: undefined } : e
    ),
  }));
}

function toggleCollection(
  sdk: BackendSDK,
  projectId: string,
  collectionId: string
): Promise<Result<ProjectData>> {
  return update(sdk, projectId, (data) => ({
    ...data,
    collections: data.collections.map((c) =>
      c.id === collectionId ? { ...c, collapsed: c.collapsed === true ? undefined : true } : c
    ),
  }));
}

export type API = DefineAPI<{
  getProject: typeof getProject;
  addEntries: typeof addEntries;
  removeEntry: typeof removeEntry;
  clearEntries: typeof clearEntries;
  moveEntry: typeof moveEntry;
  createCollection: typeof createCollection;
  renameCollection: typeof renameCollection;
  deleteCollection: typeof deleteCollection;
  toggleCollection: typeof toggleCollection;
}>;

export type BackendEvents = DefineEvents<{
  /** Fired after a project's saved requests changed, for every open client. */
  "inspector:changed": (projectId: string) => void;
}>;

export function init(sdk: BackendSDK): void {
  sdk.api.register("getProject", getProject);
  sdk.api.register("addEntries", addEntries);
  sdk.api.register("removeEntry", removeEntry);
  sdk.api.register("clearEntries", clearEntries);
  sdk.api.register("moveEntry", moveEntry);
  sdk.api.register("createCollection", createCollection);
  sdk.api.register("renameCollection", renameCollection);
  sdk.api.register("deleteCollection", deleteCollection);
  sdk.api.register("toggleCollection", toggleCollection);
}
