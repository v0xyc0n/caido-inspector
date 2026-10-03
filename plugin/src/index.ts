import type { Caido } from "@caido/sdk-frontend";
import type { CommandContext } from "@caido/sdk-frontend";

// ─── Types ────────────────────────────────────────────────────────────────────

type Entry = {
  requestId: string;
  host: string;
  path: string;
  savedAt: string;
};

/**
 * Plugin storage is global to the plugin (one row per user+plugin in Caido's
 * `plugins.db`), but request IDs are only meaningful inside the project that
 * produced them. Entries are therefore bucketed per project id.
 *
 * `unassigned` holds entries written by versions that kept a single flat list.
 * They are persisted back under the legacy `entries` key until a project is
 * selected and they can be attributed to one.
 */
type Store = {
  projects: Record<string, Entry[]>;
  unassigned: Entry[];
};

const STORE_VERSION = 2;

/** Giving up beats hanging forever when the API connection is down. */
const QUERY_TIMEOUT_MS = 15_000;

/** Frames to keep retrying an editor write while the page is being mounted. */
const EDITOR_FLUSH_ATTEMPTS = 30;

// ─── Storage ──────────────────────────────────────────────────────────────────

function isEntry(value: unknown): value is Entry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Partial<Entry>;
  return (
    typeof e.requestId === "string" &&
    typeof e.host === "string" &&
    typeof e.path === "string" &&
    typeof e.savedAt === "string"
  );
}

function emptyStore(): Store {
  return { projects: {}, unassigned: [] };
}

/**
 * Reads storage defensively: `sdk.storage.get()` throws while the plugin is not
 * present in the frontend's plugin state, and the stored shape may predate this
 * version. Never throws, so callers can render unconditionally.
 */
function readStore(sdk: Caido): Store {
  let raw: unknown;
  try {
    raw = sdk.storage.get();
  } catch {
    return emptyStore();
  }
  if (raw === null || typeof raw !== "object") return emptyStore();

  const data = raw as { projects?: unknown; entries?: unknown };
  const store = emptyStore();

  if (data.projects !== null && typeof data.projects === "object") {
    for (const [projectId, entries] of Object.entries(data.projects as Record<string, unknown>)) {
      if (Array.isArray(entries)) store.projects[projectId] = entries.filter(isEntry);
    }
  }
  if (Array.isArray(data.entries)) store.unassigned = data.entries.filter(isEntry);

  return store;
}

function serializeStore(store: Store): {
  version: number;
  projects: Record<string, Entry[]>;
  entries?: Entry[];
} {
  return {
    version: STORE_VERSION,
    projects: store.projects,
    // Keep the legacy key only while it holds something, so an older build of
    // the plugin still finds those entries.
    ...(store.unassigned.length > 0 ? { entries: store.unassigned } : {}),
  };
}

/**
 * Serializes read-modify-write cycles. `sdk.storage.set()` resolves once the
 * mutation has been applied to the frontend's plugin state, so queueing is
 * enough to stop concurrent writes (e.g. a delete during a bulk save) from
 * clobbering each other.
 */
function createStorage(sdk: Caido) {
  let queue: Promise<void> = Promise.resolve();

  const mutate = (transform: (store: Store) => Store | undefined): Promise<void> => {
    const run = async (): Promise<void> => {
      const next = transform(readStore(sdk));
      if (next === undefined) return;
      await sdk.storage.set(serializeStore(next));
    };
    // Run regardless of whether the previous write succeeded.
    queue = queue.then(run, run);
    return queue;
  };

  return {
    entriesFor: (projectId: string | undefined): Entry[] =>
      projectId === undefined ? [] : (readStore(sdk).projects[projectId] ?? []),
    mutate,
  };
}

type Storage = ReturnType<typeof createStorage>;

function newestFirst(a: Entry, b: Entry): number {
  return b.savedAt.localeCompare(a.savedAt);
}

// ─── Editors ──────────────────────────────────────────────────────────────────

type EditorViewLike = {
  dispatch: (spec: unknown) => void;
  state: { doc: { length: number } };
};

type EditorHandle = { getEditorView: () => unknown };

/**
 * Caido only exposes an editor's CodeMirror view while the element is mounted
 * (`getEditorView()` returns `undefined` otherwise, and the view is replaced on
 * every remount). Plugin pages are not kept alive, so leaving the page — which
 * is what switching projects does — invalidates both editors.
 *
 * Writes are therefore best-effort and remembered: whatever could not be
 * applied is replayed when the page is entered again.
 */
function createEditorWriter(editor: EditorHandle) {
  let pending: string | undefined;
  let scheduled = false;
  let attempts = 0;

  const apply = (content: string): boolean => {
    const view = editor.getEditorView() as EditorViewLike | undefined;
    if (view === undefined) return false;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
      return true;
    } catch {
      // View was torn down between the lookup and the dispatch.
      return false;
    }
  };

  const tick = (): void => {
    scheduled = false;
    if (pending === undefined) return;
    if (apply(pending)) {
      pending = undefined;
      return;
    }
    if (attempts > 0) {
      attempts--;
      schedule();
    }
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(tick);
  };

  return {
    set(content: string): void {
      if (apply(content)) {
        pending = undefined;
        return;
      }
      pending = content;
      attempts = EDITOR_FLUSH_ATTEMPTS;
      schedule();
    },
    /** Called when the page is entered, before the editors have mounted. */
    retry(): void {
      if (pending === undefined) return;
      attempts = EDITOR_FLUSH_ATTEMPTS;
      schedule();
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${QUERY_TIMEOUT_MS / 1000}s`));
    }, QUERY_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSavedAt(savedAt: string): string {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return savedAt;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
}

const STYLES = `
.insp-item { padding:8px 12px; cursor:pointer; display:flex; align-items:flex-start; gap:8px;
  border-bottom:1px solid var(--c-border-default,#222); background:transparent; }
.insp-item:hover { background:var(--c-bg-subtle,#1e1e2a); }
.insp-item[data-active="true"] { background:var(--c-bg-subtle,#2a2a3a); }
.insp-item__info { flex:1; min-width:0; }
.insp-item__target { font-size:12px; color:var(--c-fg-default,#ddd);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.insp-item__time { font-size:11px; color:#666; margin-top:2px; }
.insp-item__remove { background:none; border:none; color:#555; cursor:pointer;
  font-size:18px; padding:0; line-height:1; flex-shrink:0; }
.insp-item__remove:hover { color:#ccc; }
.insp-placeholder { padding:16px 12px; color:#666; font-size:13px; }
`;

// ─── Page ─────────────────────────────────────────────────────────────────────

function buildPage(sdk: Caido, storage: Storage) {
  const reqEditor = sdk.ui.httpRequestEditor();
  const respEditor = sdk.ui.httpResponseEditor();
  const reqWriter = createEditorWriter(reqEditor);
  const respWriter = createEditorWriter(respEditor);

  let projectId: string | undefined;
  let selectedId: string | null = null;
  /** Invalidates in-flight loads when the selection or the project changes. */
  let generation = 0;

  // ── Root ────────────────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.style.cssText = "display:flex;height:100%;overflow:hidden;";

  const styles = document.createElement("style");
  styles.textContent = STYLES;
  root.appendChild(styles);

  // ── Left panel ──────────────────────────────────────────────────────────────
  const left = document.createElement("div");
  left.style.cssText =
    "width:300px;min-width:200px;border-right:1px solid var(--c-border-default,#333);display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;";

  const toolbar = document.createElement("div");
  toolbar.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--c-border-default,#333);";

  const toolbarTitle = document.createElement("span");
  toolbarTitle.textContent = "Saved Requests";
  toolbarTitle.style.cssText = "font-size:13px;font-weight:600;";

  const clearBtn = sdk.ui.button({ variant: "tertiary", label: "Clear All", size: "small" });
  clearBtn.addEventListener("click", () => {
    void clearAll();
  });

  toolbar.appendChild(toolbarTitle);
  toolbar.appendChild(clearBtn);

  const list = document.createElement("div");
  list.style.cssText = "flex:1;overflow-y:auto;";
  list.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target === null) return;
    const row = target.closest<HTMLElement>("[data-entry-id]");
    const requestId = row?.dataset.entryId;
    if (requestId === undefined) return;
    if (target.closest("[data-action='remove']") !== null) {
      event.stopPropagation();
      void removeEntry(requestId);
      return;
    }
    void loadEntry(requestId);
  });

  left.appendChild(toolbar);
  left.appendChild(list);

  // ── Right panel ─────────────────────────────────────────────────────────────
  const right = document.createElement("div");
  right.style.cssText = "flex:1;display:flex;flex-direction:column;overflow:hidden;";

  const makeSection = (label: string, editorEl: HTMLElement) => {
    const section = document.createElement("div");
    section.style.cssText =
      "flex:1;display:flex;flex-direction:column;overflow:hidden;border-bottom:1px solid var(--c-border-default,#333);";
    const heading = document.createElement("div");
    heading.textContent = label;
    heading.style.cssText =
      "padding:5px 12px;font-size:11px;font-weight:600;color:#888;letter-spacing:0.08em;border-bottom:1px solid var(--c-border-default,#333);flex-shrink:0;";
    editorEl.style.cssText = "flex:1;overflow:auto;min-height:0;";
    section.appendChild(heading);
    section.appendChild(editorEl);
    return section;
  };

  right.appendChild(makeSection("REQUEST", reqEditor.getElement()));
  right.appendChild(makeSection("RESPONSE", respEditor.getElement()));

  root.appendChild(left);
  root.appendChild(right);

  // ── Rendering ────────────────────────────────────────────────────────────────

  function showPlaceholder(message: string): void {
    const placeholder = document.createElement("div");
    placeholder.className = "insp-placeholder";
    placeholder.textContent = message;
    list.appendChild(placeholder);
  }

  function renderList(): void {
    list.innerHTML = "";

    if (projectId === undefined) {
      showPlaceholder("No project selected.");
      return;
    }

    const entries = storage.entriesFor(projectId);
    if (entries.length === 0) {
      showPlaceholder("No saved requests in this project.");
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "insp-item";
      item.dataset.entryId = entry.requestId;
      if (entry.requestId === selectedId) item.dataset.active = "true";

      const info = document.createElement("div");
      info.className = "insp-item__info";

      const target = document.createElement("div");
      target.className = "insp-item__target";
      target.textContent = `${entry.host}${entry.path}`;
      target.title = `${entry.host}${entry.path}`;

      const time = document.createElement("div");
      time.className = "insp-item__time";
      time.textContent = formatSavedAt(entry.savedAt);

      info.appendChild(target);
      info.appendChild(time);

      const removeBtn = document.createElement("button");
      removeBtn.className = "insp-item__remove";
      removeBtn.dataset.action = "remove";
      removeBtn.textContent = "×";
      removeBtn.title = "Remove";

      item.appendChild(info);
      item.appendChild(removeBtn);
      fragment.appendChild(item);
    }
    list.appendChild(fragment);
  }

  function clearEditors(): void {
    reqWriter.set("");
    respWriter.set("");
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function loadEntry(requestId: string): Promise<void> {
    const project = projectId;
    const token = ++generation;
    const superseded = (): boolean => token !== generation || project !== projectId;

    selectedId = requestId;
    renderList();
    reqWriter.set("Loading…");
    respWriter.set("");

    try {
      const reqResult = await withTimeout(sdk.graphql.request({ id: requestId }), "Loading request");
      if (superseded()) return;

      const req = reqResult.request;
      if (req === null || req === undefined) {
        reqWriter.set("(request no longer available in this project)");
        respWriter.set("");
        return;
      }

      reqWriter.set(req.raw ?? "");

      const responseId = req.response?.id;
      if (responseId === undefined) {
        respWriter.set("(no response captured)");
        return;
      }

      const respResult = await withTimeout(
        sdk.graphql.response({ id: responseId }),
        "Loading response"
      );
      if (superseded()) return;
      respWriter.set(respResult.response?.raw ?? "(no response body)");
    } catch (err) {
      if (superseded()) return;
      reqWriter.set(`Error loading request: ${describe(err)}`);
      respWriter.set("");
    }
  }

  async function removeEntry(requestId: string): Promise<void> {
    const project = projectId;
    if (project === undefined) return;

    if (selectedId === requestId) {
      selectedId = null;
      generation++;
      clearEditors();
    }

    try {
      await storage.mutate((store) => {
        const entries = store.projects[project];
        if (entries === undefined) return undefined;
        return {
          ...store,
          projects: {
            ...store.projects,
            [project]: entries.filter((e) => e.requestId !== requestId),
          },
        };
      });
    } catch (err) {
      sdk.window.showToast(`Inspector: could not remove entry (${describe(err)})`, {
        variant: "error",
      });
    }
    renderList();
  }

  async function clearAll(): Promise<void> {
    const project = projectId;
    if (project === undefined) return;

    selectedId = null;
    generation++;
    clearEditors();

    try {
      await storage.mutate((store) => {
        if ((store.projects[project] ?? []).length === 0) return undefined;
        return { ...store, projects: { ...store.projects, [project]: [] } };
      });
    } catch (err) {
      sdk.window.showToast(`Inspector: could not clear entries (${describe(err)})`, {
        variant: "error",
      });
    }
    renderList();
  }

  // Re-render whenever storage changes (e.g. an entry added via context menu).
  sdk.storage.onChange(() => renderList());

  renderList();

  return {
    root,
    /** Switching projects invalidates the selection, the list and the editors. */
    setProject(nextProjectId: string | undefined): void {
      if (nextProjectId === projectId) return;
      projectId = nextProjectId;
      selectedId = null;
      generation++;
      clearEditors();
      renderList();
    },
    /**
     * Fires before the page's editors mount, so replay anything that could not
     * be written while the page was detached.
     */
    onEnter(): void {
      renderList();
      reqWriter.retry();
      respWriter.retry();
    },
  };
}

// ─── Command ──────────────────────────────────────────────────────────────────

type Candidate = { requestId: string; host: string; path: string };

type RequestLike = { host: string; path: string; query?: string };

/** Drafts have no id yet, so there is nothing stable to save. */
function toCandidate(req: RequestLike & { id?: string }): Candidate | undefined {
  if (req.id === undefined || req.id === "") return undefined;
  const query = req.query ?? "";
  return { requestId: req.id, host: req.host, path: req.path + (query ? `?${query}` : "") };
}

function candidatesFrom(context: CommandContext): Candidate[] {
  switch (context.type) {
    case "RequestRowContext":
      return context.requests.map(toCandidate).filter((c): c is Candidate => c !== undefined);
    case "RequestContext": {
      const req = context.request;
      const candidate = "id" in req ? toCandidate(req) : undefined;
      return candidate === undefined ? [] : [candidate];
    }
    case "ResponseContext": {
      const candidate = toCandidate(context.request);
      return candidate === undefined ? [] : [candidate];
    }
    default:
      return [];
  }
}

async function sendToInspector(
  sdk: Caido,
  storage: Storage,
  projectId: string | undefined,
  context: CommandContext
): Promise<void> {
  const candidates = candidatesFrom(context);
  if (candidates.length === 0) {
    sdk.window.showToast("Inspector: no saved request in this context.", { variant: "info" });
    return;
  }
  if (projectId === undefined) {
    sdk.window.showToast("Inspector: select a project first.", { variant: "warning" });
    return;
  }

  let added = 0;
  let duplicates = 0;

  try {
    // One read-modify-write for the whole selection, so saving many rows costs
    // a single mutation and a single re-render.
    await storage.mutate((store) => {
      const existing = store.projects[projectId] ?? [];
      const seen = new Set(existing.map((e) => e.requestId));
      const savedAt = new Date().toISOString();
      const fresh: Entry[] = [];

      for (const candidate of candidates) {
        if (seen.has(candidate.requestId)) {
          duplicates++;
          continue;
        }
        seen.add(candidate.requestId);
        fresh.push({ ...candidate, savedAt });
        added++;
      }

      if (fresh.length === 0) return undefined;
      return {
        ...store,
        projects: { ...store.projects, [projectId]: [...fresh.reverse(), ...existing] },
      };
    });
  } catch (err) {
    sdk.window.showToast(`Inspector error: ${describe(err)}`, { variant: "error" });
    return;
  }

  if (added === 0 && duplicates > 0) {
    sdk.window.showToast("Already in Inspector.", { variant: "info" });
  } else if (added === 1) {
    sdk.window.showToast("Sent to Inspector!", { variant: "success" });
  } else if (added > 1) {
    sdk.window.showToast(`Sent ${added} requests to Inspector!`, { variant: "success" });
  }
}

// ─── Plugin Entry Point ───────────────────────────────────────────────────────

export function init(sdk: Caido): void {
  const storage = createStorage(sdk);
  const page = buildPage(sdk, storage);

  let projectId: string | undefined;
  let projectKnown = false;

  /**
   * Entries written before storage was bucketed per project carry no project
   * information. Attribute them to the first project that becomes current, so
   * they stay reachable instead of leaking into every project.
   */
  const adoptUnassigned = (target: string): void => {
    void storage
      .mutate((store) => {
        if (store.unassigned.length === 0) return undefined;
        const existing = store.projects[target] ?? [];
        const seen = new Set(existing.map((e) => e.requestId));
        const adopted = store.unassigned.filter((e) => !seen.has(e.requestId));
        return {
          projects: {
            ...store.projects,
            [target]: [...existing, ...adopted].sort(newestFirst),
          },
          unassigned: [],
        };
      })
      .catch(() => {
        // Nothing to do: the entries stay under the legacy key for next time.
      });
  };

  const setProject = (nextProjectId: string | undefined): void => {
    projectKnown = true;
    projectId = nextProjectId;
    page.setProject(nextProjectId);
    if (nextProjectId !== undefined) adoptUnassigned(nextProjectId);
  };

  sdk.projects.onCurrentProjectChange((event) => setProject(event.projectId));

  // `onCurrentProjectChange` only reports changes, so seed the current project.
  void (async () => {
    try {
      const result = await sdk.graphql.currentProject();
      // A change event may have landed first; it wins.
      if (!projectKnown) setProject(result.currentProject?.project.id);
    } catch {
      if (!projectKnown) page.setProject(undefined);
    }
  })();

  sdk.navigation.addPage("/inspector", {
    body: page.root,
    onEnter: () => page.onEnter(),
  });

  sdk.sidebar.registerItem("Inspector", "/inspector", {
    icon: "fas fa-flask",
  });

  sdk.commands.register("send-to-inspector", {
    name: "Send to Inspector",
    run: (ctx) => sendToInspector(sdk, storage, projectId, ctx),
    group: "Inspector",
  });

  sdk.menu.registerItem({ type: "RequestRow", commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
  sdk.menu.registerItem({ type: "Request",    commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
  sdk.menu.registerItem({ type: "Response",   commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
}
