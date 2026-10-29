import type { Caido, CommandContext } from "@caido/sdk-frontend";

import type { API, BackendEvents } from "../../backend/src/index";
import {
  type Candidate,
  type Collection,
  type Entry,
  type ProjectData,
  type Result,
  emptyProject,
} from "../../backend/src/model";

type FrontendSDK = Caido<API, BackendEvents>;

/** Giving up beats hanging forever when the API connection is down. */
const QUERY_TIMEOUT_MS = 15_000;

/** Frames to keep retrying an editor write while the page is being mounted. */
const EDITOR_FLUSH_ATTEMPTS = 30;

const FINDING_REPORTER = "Inspector";

/** Sentinel for the bucket of entries that are in no collection. */
const UNCATEGORISED = "__none__";

// ─── Backend ──────────────────────────────────────────────────────────────────

/**
 * Saved requests are owned by the backend plugin (see backend/src/index.ts).
 * This wraps a call: an error becomes a toast, the caller gets the value or
 * `undefined`.
 */
async function call<T>(
  sdk: FrontendSDK,
  request: Promise<Result<T>>,
  failure: string
): Promise<T | undefined> {
  try {
    const result = await withTimeout(request, failure);
    if (result.kind === "Ok") return result.value;
    sdk.window.showToast(`${failure}: ${result.error}`, { variant: "error" });
  } catch (err) {
    sdk.window.showToast(`${failure}: ${describe(err)}`, { variant: "error" });
  }
  return undefined;
}

// ─── Editors ──────────────────────────────────────────────────────────────────

type EditorViewLike = {
  dispatch: (spec: unknown) => void;
  state: {
    doc: { length: number };
    selection: { main: { from: number; to: number } };
    sliceDoc: (from: number, to: number) => string;
  };
};

type EditorHandle = { getElement: () => HTMLElement; getEditorView: () => unknown };

/**
 * Caido's editors are Vue custom elements, and plugin pages are not kept
 * alive: leaving the page detaches them, entering it again re-attaches them.
 * Vue (3.5, as shipped with Caido 0.59) only cleans up properly the first
 * time. From the second re-attach on, the element keeps showing its old view
 * but loses track of its component, so `getEditorView()` returns `undefined`
 * for good and every write is lost.
 *
 * The slot therefore swaps in a brand-new editor each time the page is
 * entered and replays the last content into it. Writes that hit an editor
 * that is not mounted yet are retried for a few frames.
 */
function createEditorSlot(create: () => EditorHandle) {
  let editor = create();
  /** Last content written, so a new editor can show it again. */
  let content = "";
  let pending: string | undefined;
  let scheduled = false;
  let attempts = 0;

  const view = (): EditorViewLike | undefined =>
    editor.getEditorView() as EditorViewLike | undefined;

  const apply = (text: string): boolean => {
    const current = view();
    if (current === undefined) return false;
    try {
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } });
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

  const defer = (text: string): void => {
    pending = text;
    attempts = EDITOR_FLUSH_ATTEMPTS;
    schedule();
  };

  return {
    element(): HTMLElement {
      return editor.getElement();
    },
    /** Text currently selected in the editor, if it is mounted. */
    selection(): string {
      const current = view();
      if (current === undefined) return "";
      try {
        const { from, to } = current.state.selection.main;
        return from === to ? "" : current.state.sliceDoc(from, to);
      } catch {
        return "";
      }
    },
    set(text: string): void {
      content = text;
      if (apply(text)) {
        pending = undefined;
        return;
      }
      defer(text);
    },
    /**
     * Called when the page is entered, before the editors mount. Returns the
     * new editor's element, which replaces the old one in the page.
     */
    renew(): HTMLElement {
      editor = create();
      defer(content);
      return editor.getElement();
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

/** Caido binds its own shortcuts to Cmd on macOS and Ctrl everywhere else. */
function primaryModifier(): string {
  try {
    const platform = `${navigator.platform} ${navigator.userAgent}`;
    return /mac/i.test(platform) ? "Meta" : "Control";
  } catch {
    return "Control";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDefaultPort(entry: Entry): boolean {
  if (entry.port === undefined) return true;
  return entry.isTls === false ? entry.port === 80 : entry.port === 443;
}

function authorityOf(entry: Entry): string {
  return isDefaultPort(entry) ? entry.host : `${entry.host}:${String(entry.port)}`;
}

/** Entries saved before `isTls` was recorded fall back to https. */
function urlFor(entry: Entry): string {
  const scheme = entry.isTls === false ? "http" : "https";
  return `${scheme}://${authorityOf(entry)}${entry.path}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatRelativeTime(savedAt: string): string {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return savedAt;

  const elapsed = Date.now() - date.getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))}m ago`;
  if (elapsed < DAY) return `${String(Math.floor(elapsed / HOUR))}h ago`;
  if (elapsed < 7 * DAY) return `${String(Math.floor(elapsed / DAY))}d ago`;
  return date.toLocaleDateString();
}

function absoluteTime(savedAt: string): string {
  const date = new Date(savedAt);
  return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString();
}

// ─── Styles ───────────────────────────────────────────────────────────────────

/**
 * Caido defines its design tokens on `:root`, so using them keeps the page in
 * step with the rest of the app instead of hardcoding greys.
 */
const STYLES = `
.insp-root { display:flex; height:100%; overflow:hidden;
  font-family:var(--c-font-family-base, sans-serif); color:var(--c-fg-default,#fff); }

.insp-sidebar { width:19rem; min-width:14rem; flex-shrink:0; display:flex; flex-direction:column;
  overflow:hidden; border-right:1px solid var(--c-border-default,#333);
  background:var(--c-bg-default,#1a1a1a); }

.insp-header { display:flex; align-items:center; gap:var(--c-space-2,.5rem);
  padding:var(--c-space-2,.5rem) var(--c-space-3,.75rem);
  border-bottom:1px solid var(--c-border-default,#333); flex-shrink:0; }
.insp-header__title { font-size:var(--c-font-size-100,.875rem);
  font-weight:var(--c-font-weight-500,500); letter-spacing:.01em; }
.insp-header__count { font-size:var(--c-font-size-75,.75rem); color:var(--c-fg-subtle,#999);
  background:var(--c-bg-subtle,#262626); border-radius:var(--c-border-radius-1,.25rem);
  padding:0 var(--c-space-1,.25rem); min-width:1.25rem; text-align:center; }
.insp-header__spacer { flex:1; }

.insp-list { flex:1; overflow-y:auto; overflow-x:hidden; }

.insp-header__icon { background:none; border:none; padding:var(--c-space-1,.25rem); cursor:pointer;
  color:var(--c-fg-subtle,#8b8b8b); border-radius:var(--c-border-radius-1,.25rem);
  font-size:var(--c-font-size-75,.75rem); }
.insp-header__icon:hover { color:var(--c-fg-default,#fff); background:var(--c-bg-subtle,#262626); }

.insp-group { border-bottom:1px solid var(--c-border-default,#2a2a2a); }
.insp-group[data-dropping="true"] { background:var(--c-bg-subtle,#262626);
  box-shadow:inset 0 0 0 1px var(--c-border-secondary,#e9c46a); }
.insp-group__header { display:flex; align-items:center; gap:var(--c-space-2,.5rem);
  padding:var(--c-space-1,.25rem) var(--c-space-2,.5rem); cursor:pointer;
  color:var(--c-fg-subtle,#8b8b8b); font-size:var(--c-font-size-75,.75rem);
  font-weight:var(--c-font-weight-500,500); user-select:none; }
.insp-group__header:hover { background:var(--c-bg-subtle,#262626); color:var(--c-fg-default,#eee); }
.insp-group__chevron { width:.75rem; text-align:center; flex-shrink:0; opacity:.7;
  font-size:.625rem; }
.insp-group__name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; }
.insp-group__count { opacity:.7; }
.insp-group__menu { background:none; border:none; padding:0; cursor:pointer; opacity:0;
  color:inherit; width:1.25rem; flex-shrink:0; font-size:var(--c-font-size-75,.75rem); }
.insp-group__header:hover .insp-group__menu { opacity:1; }
.insp-group__body .insp-row { padding-left:var(--c-space-4,1rem); }
.insp-group__body .insp-row:last-child { border-bottom:none; }
.insp-group__hint { padding:var(--c-space-2,.5rem) var(--c-space-4,1rem);
  color:var(--c-fg-subtle,#8b8b8b); opacity:.6; font-size:var(--c-font-size-75,.75rem);
  font-style:italic; }

.insp-row { position:relative; display:flex; align-items:center; gap:var(--c-space-2,.5rem);
  padding:var(--c-space-2,.5rem) var(--c-space-2,.5rem) var(--c-space-2,.5rem) var(--c-space-3,.75rem);
  cursor:pointer; border-bottom:1px solid var(--c-border-default,#2a2a2a); }
.insp-row:hover { background:var(--c-bg-subtle,#262626); }
.insp-row[data-active="true"] { background:var(--c-bg-subtle,#262626); }
.insp-row[data-active="true"]::before { content:""; position:absolute; left:0; top:0; bottom:0;
  width:2px; background:var(--c-bg-secondary,#e9c46a); }

.insp-row__main { flex:1; min-width:0; }
.insp-row__path { font-family:var(--c-font-family-mono,monospace);
  font-size:var(--c-font-size-75,.75rem); color:var(--c-fg-default,#eee);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; direction:ltr; }
.insp-row__meta { display:flex; align-items:center; gap:var(--c-space-1,.25rem);
  margin-top:2px; font-size:var(--c-font-size-75,.75rem); color:var(--c-fg-subtle,#8b8b8b); }
.insp-row__host { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.insp-row__sep { opacity:.5; }
.insp-row__time { flex-shrink:0; }

.insp-row__menu { flex-shrink:0; width:1.5rem; height:1.5rem; display:flex;
  align-items:center; justify-content:center; background:none; border:none; padding:0;
  cursor:pointer; color:var(--c-fg-subtle,#7a7a7a); opacity:0;
  border-radius:var(--c-border-radius-1,.25rem); font-size:var(--c-font-size-75,.75rem); }
.insp-row:hover .insp-row__menu, .insp-row[data-active="true"] .insp-row__menu { opacity:1; }
.insp-row__menu:hover { color:var(--c-fg-default,#fff); background:var(--c-bg-inset,#333); }

.insp-empty { display:flex; flex-direction:column; align-items:center; gap:var(--c-space-2,.5rem);
  padding:var(--c-space-8,2rem) var(--c-space-4,1rem); text-align:center;
  color:var(--c-fg-subtle,#8b8b8b); font-size:var(--c-font-size-75,.75rem); }
.insp-empty__icon { font-size:var(--c-font-size-200,1rem); opacity:.4; }
.insp-empty__hint { opacity:.75; line-height:1.4; }

.insp-detail { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }
.insp-pane { flex:1; display:flex; flex-direction:column; overflow:hidden; min-height:0;
  border-bottom:1px solid var(--c-border-default,#333); }
.insp-pane__body { flex:1; overflow:auto; min-height:0; }

/* Floating panels live on document.body so the page's overflow cannot clip them. */
.insp-pop { position:fixed; z-index:9000; min-width:12rem;
  background:var(--c-bg-default,#1f1f1f); border:1px solid var(--c-border-default,#3a3a3a);
  border-radius:var(--c-border-radius-2,.5rem); box-shadow:var(--c-box-shadow-large,0 8px 24px #000a);
  padding:var(--c-space-1,.25rem) 0; font-family:var(--c-font-family-base,sans-serif);
  font-size:var(--c-font-size-100,.875rem); color:var(--c-fg-default,#eee); outline:none; }
.insp-pop__item { display:flex; align-items:center; gap:var(--c-space-2,.5rem); width:100%;
  background:none; border:none; text-align:left; cursor:pointer; color:inherit;
  font:inherit; padding:var(--c-space-1,.25rem) var(--c-space-3,.75rem); }
.insp-pop__item:hover, .insp-pop__item[data-focused="true"] { background:var(--c-bg-subtle,#2c2c2c); }
.insp-pop__item[data-variant="danger"] { color:var(--c-fg-danger,#f58e97); }
.insp-pop__icon { width:1rem; text-align:center; flex-shrink:0; opacity:.8;
  font-size:var(--c-font-size-75,.75rem); }
.insp-pop__sep { height:1px; margin:var(--c-space-1,.25rem) 0;
  background:var(--c-border-default,#3a3a3a); }

.insp-prompt { padding:var(--c-space-3,.75rem); display:flex; flex-direction:column;
  gap:var(--c-space-2,.5rem); min-width:17rem; }
.insp-prompt__label { font-size:var(--c-font-size-75,.75rem); color:var(--c-fg-subtle,#8b8b8b); }
.insp-prompt__input { background:var(--c-bg-inset,#333);
  border:1px solid var(--c-border-default,#3a3a3a); border-radius:var(--c-border-radius-1,.25rem);
  color:var(--c-fg-default,#eee); font:inherit;
  padding:var(--c-space-1,.25rem) var(--c-space-2,.5rem); outline:none; }
.insp-prompt__input:focus { border-color:var(--c-border-secondary,#e9c46a); }
.insp-prompt__actions { display:flex; justify-content:flex-end; gap:var(--c-space-2,.5rem); }
.insp-prompt__btn { background:var(--c-bg-inset,#333); border:1px solid var(--c-border-default,#3a3a3a);
  border-radius:var(--c-border-radius-1,.25rem); color:var(--c-fg-default,#eee); font:inherit;
  font-size:var(--c-font-size-75,.75rem); padding:var(--c-space-1,.25rem) var(--c-space-2,.5rem);
  cursor:pointer; }
.insp-prompt__btn:hover { background:var(--c-bg-subtle,#2c2c2c); }
.insp-prompt__btn[data-variant="primary"] { border-color:var(--c-border-secondary,#e9c46a);
  color:var(--c-fg-secondary,#e9c46a); }
`;

function installStyles(): void {
  // Attached to <head> rather than the page root: the root is detached whenever
  // the page is not the active route, which would deactivate its rules.
  const id = "caido-inspector-styles";
  if (document.getElementById(id) !== null) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// ─── Floating panels ──────────────────────────────────────────────────────────

type MenuItem =
  | { kind: "separator" }
  | { kind: "action"; label: string; icon: string; variant?: "danger"; run: () => void };

/**
 * A single floating layer shared by the row menu and the finding prompt. Panels
 * are appended to `document.body` with `position:fixed`, because the plugin page
 * sits inside `overflow:hidden` containers that would clip them.
 */
function createFloatingLayer() {
  let panel: HTMLElement | undefined;
  let onKeyDown: ((event: KeyboardEvent) => void) | undefined;

  const close = (): void => {
    if (panel === undefined) return;
    panel.remove();
    panel = undefined;
    if (onKeyDown !== undefined) {
      document.removeEventListener("keydown", onKeyDown, true);
      onKeyDown = undefined;
    }
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    document.removeEventListener("scroll", close, true);
  };

  function onPointerDown(event: Event): void {
    const target = event.target;
    if (panel !== undefined && target instanceof Node && panel.contains(target)) return;
    close();
  }

  /** Keeps the panel inside the viewport. */
  const place = (element: HTMLElement, x: number, y: number): void => {
    element.style.left = `${String(x)}px`;
    element.style.top = `${String(y)}px`;
    const rect = element.getBoundingClientRect?.();
    if (rect === undefined) return;
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    element.style.left = `${String(Math.max(8, Math.min(x, maxX)))}px`;
    element.style.top = `${String(Math.max(8, Math.min(y, maxY)))}px`;
  };

  const open = (
    content: HTMLElement,
    x: number,
    y: number,
    keyHandler?: (event: KeyboardEvent) => void
  ): void => {
    close();
    panel = content;
    document.body.appendChild(content);
    place(content, x, y);
    content.focus?.();

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    if (keyHandler !== undefined) {
      onKeyDown = keyHandler;
      document.addEventListener("keydown", keyHandler, true);
    }
  };

  return { open, close, isOpen: () => panel !== undefined };
}

type FloatingLayer = ReturnType<typeof createFloatingLayer>;

function openMenu(layer: FloatingLayer, items: MenuItem[], x: number, y: number): void {
  const panel = document.createElement("div");
  panel.className = "insp-pop";
  panel.tabIndex = -1;

  const buttons: HTMLElement[] = [];
  for (const item of items) {
    if (item.kind === "separator") {
      const sep = document.createElement("div");
      sep.className = "insp-pop__sep";
      panel.appendChild(sep);
      continue;
    }

    const button = document.createElement("button");
    button.className = "insp-pop__item";
    button.type = "button";
    if (item.variant !== undefined) button.dataset.variant = item.variant;

    const icon = document.createElement("i");
    icon.className = `insp-pop__icon ${item.icon}`;
    const label = document.createElement("span");
    label.textContent = item.label;

    button.appendChild(icon);
    button.appendChild(label);
    button.addEventListener("click", () => {
      layer.close();
      item.run();
    });
    panel.appendChild(button);
    buttons.push(button);
  }

  let focused = -1;
  const focus = (index: number): void => {
    if (buttons.length === 0) return;
    const next = (index + buttons.length) % buttons.length;
    buttons.forEach((b, i) => {
      if (i === next) b.dataset.focused = "true";
      else delete b.dataset.focused;
    });
    focused = next;
  };

  const keyHandler = (event: KeyboardEvent): void => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        layer.close();
        return;
      case "ArrowDown":
        event.preventDefault();
        focus(focused + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focus(focused - 1);
        return;
      case "Home":
        event.preventDefault();
        focus(0);
        return;
      case "End":
        event.preventDefault();
        focus(buttons.length - 1);
        return;
      case "Enter":
      case " ":
        if (focused < 0) return;
        event.preventDefault();
        buttons[focused]?.click();
        return;
      default:
        return;
    }
  };

  layer.open(panel, x, y, keyHandler);
}

/** Small inline prompt; Electron blocks `window.prompt`, and `showDialog` needs Vue. */
function openPrompt(
  layer: FloatingLayer,
  options: { label: string; value: string; confirmLabel: string },
  onConfirm: (value: string) => void,
  x: number,
  y: number
): void {
  const panel = document.createElement("div");
  panel.className = "insp-pop";

  const form = document.createElement("div");
  form.className = "insp-prompt";

  const label = document.createElement("label");
  label.className = "insp-prompt__label";
  label.textContent = options.label;

  const input = document.createElement("input");
  input.className = "insp-prompt__input";
  input.type = "text";
  input.value = options.value;

  const actions = document.createElement("div");
  actions.className = "insp-prompt__actions";

  const cancel = document.createElement("button");
  cancel.className = "insp-prompt__btn";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => layer.close());

  const confirm = document.createElement("button");
  confirm.className = "insp-prompt__btn";
  confirm.dataset.variant = "primary";
  confirm.type = "button";
  confirm.textContent = options.confirmLabel;

  const submit = (): void => {
    const value = input.value.trim();
    if (value === "") return;
    layer.close();
    onConfirm(value);
  };
  confirm.addEventListener("click", submit);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      layer.close();
    }
  });

  actions.appendChild(cancel);
  actions.appendChild(confirm);
  form.appendChild(label);
  form.appendChild(input);
  form.appendChild(actions);
  panel.appendChild(form);

  layer.open(panel, x, y);
  input.focus?.();
  input.select?.();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function buildPage(sdk: FrontendSDK) {
  installStyles();

  const reqWriter = createEditorSlot(() => sdk.ui.httpRequestEditor());
  const respWriter = createEditorSlot(() => sdk.ui.httpResponseEditor());
  const layer = createFloatingLayer();

  let projectId: string | undefined;
  /** The current project's saved requests, as last returned by the backend. */
  let data: ProjectData = emptyProject();
  let selectedId: string | undefined;
  /** Invalidates in-flight loads when the selection or the project changes. */
  let generation = 0;
  /** Where the last menu opened, so the finding prompt can reuse the spot. */
  let lastMenuX = 0;
  let lastMenuY = 0;
  /** The catch-all bucket has no stored collection, so its state lives here. */
  let uncategorisedCollapsed = false;
  let draggingId: string | undefined;
  let dropTarget: HTMLElement | undefined;

  // ── Root ────────────────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "insp-root";

  // ── Sidebar ─────────────────────────────────────────────────────────────────
  const sidebar = document.createElement("div");
  sidebar.className = "insp-sidebar";

  const header = document.createElement("div");
  header.className = "insp-header";

  const headerTitle = document.createElement("span");
  headerTitle.className = "insp-header__title";
  headerTitle.textContent = "Saved Requests";

  const headerCount = document.createElement("span");
  headerCount.className = "insp-header__count";

  const headerSpacer = document.createElement("div");
  headerSpacer.className = "insp-header__spacer";

  const clearBtn = sdk.ui.button({ variant: "tertiary", label: "Clear All", size: "small" });
  clearBtn.addEventListener("click", () => {
    void clearAll();
  });

  const newCollectionBtn = document.createElement("button");
  newCollectionBtn.className = "insp-header__icon";
  newCollectionBtn.type = "button";
  newCollectionBtn.title = "New collection";
  const newCollectionIcon = document.createElement("i");
  newCollectionIcon.className = "fas fa-folder-plus";
  newCollectionBtn.appendChild(newCollectionIcon);
  newCollectionBtn.addEventListener("click", () => {
    if (projectId === undefined) return;
    const rect = newCollectionBtn.getBoundingClientRect?.();
    promptNewCollection(rect?.left ?? 0, rect?.bottom ?? 0);
  });

  header.appendChild(headerTitle);
  header.appendChild(headerCount);
  header.appendChild(headerSpacer);
  header.appendChild(newCollectionBtn);
  header.appendChild(clearBtn);

  const list = document.createElement("div");
  list.className = "insp-list";

  const entryFromEvent = (event: Event): Entry | undefined => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const requestId = target?.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
    if (requestId === undefined) return undefined;
    return data.entries.find((e) => e.requestId === requestId);
  };

  const dropGroupFromEvent = (event: Event): HTMLElement | undefined => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    return target?.closest<HTMLElement>(".insp-group") ?? undefined;
  };

  const clearDropTarget = (): void => {
    if (dropTarget === undefined) return;
    delete dropTarget.dataset.dropping;
    dropTarget = undefined;
  };

  const collectionFromEvent = (event: Event): Collection | undefined => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const id = target?.closest<HTMLElement>("[data-collection-id]")?.dataset.collectionId;
    if (id === undefined || id === UNCATEGORISED) return undefined;
    return collectionsNow().find((c) => c.id === id);
  };

  list.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target === null) return;

    if (target.closest("[data-action='collection-menu']") !== null) {
      event.stopPropagation();
      const collection = collectionFromEvent(event);
      if (collection === undefined) return;
      const rect = target
        .closest<HTMLElement>("[data-action='collection-menu']")
        ?.getBoundingClientRect?.();
      openCollectionMenu(collection, rect?.left ?? 0, rect?.bottom ?? 0);
      return;
    }

    if (target.closest("[data-action='toggle-collection']") !== null) {
      const id = target.closest<HTMLElement>("[data-collection-id]")?.dataset.collectionId;
      if (id !== undefined) toggleCollection(id);
      return;
    }

    const entry = entryFromEvent(event);
    if (entry === undefined) return;

    if (target.closest("[data-action='menu']") !== null) {
      event.stopPropagation();
      const rect = target.closest<HTMLElement>("[data-action='menu']")?.getBoundingClientRect?.();
      openRowMenu(entry, rect?.left ?? 0, rect?.bottom ?? 0);
      return;
    }
    void loadEntry(entry.requestId);
  });

  // Drag a row onto a group header or body to file it, like Replay's collections.
  list.addEventListener("dragstart", (event) => {
    const entry = entryFromEvent(event);
    if (entry === undefined) return;
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer === null || transfer === undefined) return;
    transfer.effectAllowed = "move";
    transfer.setData("text/plain", entry.requestId);
    draggingId = entry.requestId;
  });

  list.addEventListener("dragend", () => {
    draggingId = undefined;
    clearDropTarget();
  });

  list.addEventListener("dragover", (event) => {
    if (draggingId === undefined) return;
    const group = dropGroupFromEvent(event);
    if (group === undefined) return;
    event.preventDefault();
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer !== null && transfer !== undefined) transfer.dropEffect = "move";
    if (dropTarget !== group) {
      clearDropTarget();
      dropTarget = group;
      group.dataset.dropping = "true";
    }
  });

  list.addEventListener("dragleave", (event) => {
    const group = dropGroupFromEvent(event);
    if (group !== undefined && group === dropTarget) clearDropTarget();
  });

  list.addEventListener("drop", (event) => {
    const group = dropGroupFromEvent(event);
    clearDropTarget();
    if (group === undefined) return;
    event.preventDefault();
    const transfer = (event as DragEvent).dataTransfer;
    // getData() yields "" rather than undefined when nothing was set.
    const requestId = transfer?.getData("text/plain") || draggingId;
    draggingId = undefined;
    if (requestId === undefined || requestId === "") return;
    const target = group.dataset.collectionId;
    moveEntry(requestId, target === UNCATEGORISED ? undefined : target);
  });

  list.addEventListener("dblclick", (event) => {
    const entry = entryFromEvent(event);
    if (entry === undefined) return;
    event.preventDefault();
    void showInHistory(entry);
  });

  list.addEventListener("contextmenu", (event) => {
    const entry = entryFromEvent(event);
    if (entry === undefined) return;
    event.preventDefault();
    openRowMenu(entry, event.clientX, event.clientY);
  });

  sidebar.appendChild(header);
  sidebar.appendChild(list);

  // ── Detail ──────────────────────────────────────────────────────────────────
  const detail = document.createElement("div");
  detail.className = "insp-detail";

  // The SDK editors render their own "Request" / "Response" header, so the pane
  // adds none of its own.
  const mountEditor = (pane: HTMLElement, editorEl: HTMLElement): void => {
    editorEl.className = "insp-pane__body";
    pane.replaceChildren(editorEl);
  };

  const makePane = (which: "request" | "response", editorEl: HTMLElement) => {
    const pane = document.createElement("div");
    pane.className = "insp-pane";
    mountEditor(pane, editorEl);
    pane.addEventListener("contextmenu", (event) => {
      const entry = selectedEntry();
      if (entry === undefined) return; // nothing loaded: leave the default menu alone
      event.preventDefault();
      openEditorMenu(entry, which, event.clientX, event.clientY);
    });
    return pane;
  };

  const reqPane = makePane("request", reqWriter.element());
  const respPane = makePane("response", respWriter.element());
  detail.appendChild(reqPane);
  detail.appendChild(respPane);

  root.appendChild(sidebar);
  root.appendChild(detail);

  // ── Rendering ────────────────────────────────────────────────────────────────

  function showEmpty(message: string, hint?: string): void {
    const empty = document.createElement("div");
    empty.className = "insp-empty";

    const icon = document.createElement("i");
    icon.className = "insp-empty__icon fas fa-flask";

    const text = document.createElement("div");
    text.textContent = message;

    empty.appendChild(icon);
    empty.appendChild(text);

    if (hint !== undefined) {
      const hintEl = document.createElement("div");
      hintEl.className = "insp-empty__hint";
      hintEl.textContent = hint;
      empty.appendChild(hintEl);
    }
    list.appendChild(empty);
  }

  function renderRow(entry: Entry): HTMLElement {
    const row = document.createElement("div");
    row.className = "insp-row";
    row.dataset.entryId = entry.requestId;
    row.draggable = true;
    if (entry.requestId === selectedId) row.dataset.active = "true";

    const main = document.createElement("div");
    main.className = "insp-row__main";

    const path = document.createElement("div");
    path.className = "insp-row__path";
    path.textContent = entry.path;

    const meta = document.createElement("div");
    meta.className = "insp-row__meta";

    const host = document.createElement("span");
    host.className = "insp-row__host";
    host.textContent = authorityOf(entry);

    const sep = document.createElement("span");
    sep.className = "insp-row__sep";
    sep.textContent = "·";

    const time = document.createElement("span");
    time.className = "insp-row__time";
    time.textContent = formatRelativeTime(entry.savedAt);
    time.title = absoluteTime(entry.savedAt);

    meta.appendChild(host);
    meta.appendChild(sep);
    meta.appendChild(time);
    main.appendChild(path);
    main.appendChild(meta);

    const menuBtn = document.createElement("button");
    menuBtn.className = "insp-row__menu";
    menuBtn.dataset.action = "menu";
    menuBtn.type = "button";
    menuBtn.title = "Options";
    const menuIcon = document.createElement("i");
    menuIcon.className = "fas fa-ellipsis-vertical";
    menuBtn.appendChild(menuIcon);

    row.title = `${urlFor(entry)}\nDouble-click to show in HTTP History`;
    row.appendChild(main);
    row.appendChild(menuBtn);
    return row;
  }

  /** One collection, or the catch-all bucket when `collection` is undefined. */
  function renderGroup(collection: Collection | undefined, entries: Entry[]): HTMLElement {
    const group = document.createElement("div");
    group.className = "insp-group";
    group.dataset.collectionId = collection?.id ?? UNCATEGORISED;

    const collapsed =
      collection === undefined ? uncategorisedCollapsed : collection.collapsed === true;

    const groupHeader = document.createElement("div");
    groupHeader.className = "insp-group__header";
    groupHeader.dataset.action = "toggle-collection";

    const chevron = document.createElement("i");
    chevron.className = `insp-group__chevron fas ${collapsed ? "fa-chevron-right" : "fa-chevron-down"}`;

    const name = document.createElement("span");
    name.className = "insp-group__name";
    name.textContent = collection?.name ?? "Uncategorized";

    const count = document.createElement("span");
    count.className = "insp-group__count";
    count.textContent = String(entries.length);

    groupHeader.appendChild(chevron);
    groupHeader.appendChild(name);
    groupHeader.appendChild(count);

    if (collection !== undefined) {
      const groupMenu = document.createElement("button");
      groupMenu.className = "insp-group__menu";
      groupMenu.dataset.action = "collection-menu";
      groupMenu.type = "button";
      groupMenu.title = "Collection options";
      const icon = document.createElement("i");
      icon.className = "fas fa-ellipsis-vertical";
      groupMenu.appendChild(icon);
      groupHeader.appendChild(groupMenu);
    }

    group.appendChild(groupHeader);

    if (!collapsed) {
      const body = document.createElement("div");
      body.className = "insp-group__body";
      if (entries.length === 0) {
        const hint = document.createElement("div");
        hint.className = "insp-group__hint";
        hint.textContent = "Drop requests here";
        body.appendChild(hint);
      } else {
        for (const entry of entries) body.appendChild(renderRow(entry));
      }
      group.appendChild(body);
    }
    return group;
  }

  function renderList(): void {
    list.innerHTML = "";

    if (projectId === undefined) {
      headerCount.textContent = "";
      showEmpty("No project selected.", "Open a project to see its saved requests.");
      return;
    }

    const { entries, collections } = data;
    headerCount.textContent = entries.length === 0 ? "" : String(entries.length);

    if (entries.length === 0 && collections.length === 0) {
      showEmpty(
        "No saved requests in this project.",
        "Right-click a request anywhere in Caido and choose \u201cSend to Inspector\u201d. " +
          "Double-click a saved row to jump to it in HTTP History."
      );
      return;
    }

    const fragment = document.createDocumentFragment();

    // Without collections the list stays flat, exactly as before.
    if (collections.length === 0) {
      for (const entry of entries) fragment.appendChild(renderRow(entry));
      list.appendChild(fragment);
      return;
    }

    const known = new Set(collections.map((c) => c.id));
    for (const collection of collections) {
      fragment.appendChild(
        renderGroup(
          collection,
          entries.filter((e) => e.collectionId === collection.id)
        )
      );
    }
    // Entries with no collection, plus any orphaned by a deleted one.
    fragment.appendChild(
      renderGroup(
        undefined,
        entries.filter((e) => e.collectionId === undefined || !known.has(e.collectionId))
      )
    );
    list.appendChild(fragment);
  }

  function clearEditors(): void {
    reqWriter.set("");
    respWriter.set("");
  }

  // ── Menus ────────────────────────────────────────────────────────────────────

  function selectedEntry(): Entry | undefined {
    if (selectedId === undefined) return undefined;
    return data.entries.find((e) => e.requestId === selectedId);
  }

  /** Actions shared by the row menu and the editor panes. */
  function sendItems(entry: Entry): MenuItem[] {
    return [
      {
        kind: "action",
        label: "Show in HTTP History",
        icon: "fas fa-clock-rotate-left",
        run: () => void showInHistory(entry),
      },
      {
        kind: "action",
        label: "Send to Replay",
        icon: "fas fa-paper-plane",
        run: () => void openInReplay(entry),
      },
      {
        kind: "action",
        label: "Add to Findings…",
        icon: "fas fa-bug",
        run: () => promptForFinding(entry, lastMenuX, lastMenuY),
      },
    ];
  }

  function copyItems(entry: Entry): MenuItem[] {
    return [
      {
        kind: "action",
        label: "Copy URL",
        icon: "fas fa-link",
        run: () => void copy(urlFor(entry), "URL"),
      },
      {
        kind: "action",
        label: "Copy raw request",
        icon: "fas fa-copy",
        run: () => void copyRaw(entry, "request"),
      },
      {
        kind: "action",
        label: "Copy raw response",
        icon: "fas fa-copy",
        run: () => void copyRaw(entry, "response"),
      },
    ];
  }

  /**
   * Caido wires the editor context menu in its own container components, which
   * `sdk.ui.httpRequestEditor()` does not include — so the panes get the same
   * send-to actions here.
   */
  function openEditorMenu(
    entry: Entry,
    which: "request" | "response",
    x: number,
    y: number
  ): void {
    lastMenuX = x;
    lastMenuY = y;

    const writer = which === "request" ? reqWriter : respWriter;
    const selection = writer.selection();
    const items: MenuItem[] = [];

    if (selection !== "") {
      items.push({
        kind: "action",
        label: "Copy selection",
        icon: "fas fa-clipboard",
        run: () => void copy(selection, "Selection"),
      });
      items.push({ kind: "separator" });
    }

    items.push(...sendItems(entry), { kind: "separator" }, ...copyItems(entry));
    openMenu(layer, items, x, y);
  }

  // ── Collections ──────────────────────────────────────────────────────────────

  function collectionsNow(): Collection[] {
    return data.collections;
  }

  /**
   * Shows what the backend returned, unless the user switched projects in the
   * meantime. Other clients pick the change up through `inspector:changed`.
   */
  function show(project: string, next: ProjectData): void {
    if (project !== projectId) return;
    data = next;
    renderList();
  }

  /** Runs one backend change on the current project; resolves to success. */
  async function withProject(
    change: (project: string) => Promise<Result<ProjectData>>,
    failure: string
  ): Promise<boolean> {
    const project = projectId;
    if (project === undefined) return false;
    const next = await call(sdk, change(project), failure);
    if (next === undefined) return false;
    show(project, next);
    return true;
  }

  function promptNewCollection(x: number, y: number, moveEntryId?: string): void {
    openPrompt(
      layer,
      { label: "New collection", value: "", confirmLabel: "Create" },
      (name) => {
        void withProject(
          (project) => sdk.backend.createCollection(project, name, moveEntryId),
          "Could not create the collection"
        );
      },
      x,
      y
    );
  }

  function promptRenameCollection(collection: Collection, x: number, y: number): void {
    openPrompt(
      layer,
      { label: "Rename collection", value: collection.name, confirmLabel: "Rename" },
      (name) => {
        void withProject(
          (project) => sdk.backend.renameCollection(project, collection.id, name),
          "Could not rename the collection"
        );
      },
      x,
      y
    );
  }

  /** Deleting a collection keeps its requests; they fall back to uncategorised. */
  function deleteCollection(collection: Collection): void {
    const affected = data.entries.filter((e) => e.collectionId === collection.id).length;

    void withProject(
      (project) => sdk.backend.deleteCollection(project, collection.id),
      "Could not delete the collection"
    ).then((ok) => {
      if (!ok) return;
      sdk.window.showToast(
        affected === 0
          ? `Collection “${collection.name}” deleted.`
          : `Collection “${collection.name}” deleted, ${affected} request${affected === 1 ? "" : "s"} moved to Uncategorized.`,
        { variant: "info" }
      );
    });
  }

  function moveEntry(requestId: string, collectionId: string | undefined): void {
    void withProject(
      (project) => sdk.backend.moveEntry(project, requestId, collectionId),
      "Could not move the request"
    );
  }

  function toggleCollection(id: string): void {
    if (id === UNCATEGORISED) {
      uncategorisedCollapsed = !uncategorisedCollapsed;
      renderList();
      return;
    }
    void withProject(
      (project) => sdk.backend.toggleCollection(project, id),
      "Could not update the collection"
    );
  }

  function openMoveMenu(entry: Entry, x: number, y: number): void {
    const items: MenuItem[] = collectionsNow().map((collection) => ({
      kind: "action",
      label: collection.name,
      icon: entry.collectionId === collection.id ? "fas fa-check" : "far fa-folder",
      run: () => moveEntry(entry.requestId, collection.id),
    }));

    if (entry.collectionId !== undefined) {
      items.push({
        kind: "action",
        label: "Uncategorized",
        icon: "far fa-circle",
        run: () => moveEntry(entry.requestId, undefined),
      });
    }
    if (items.length > 0) items.push({ kind: "separator" });
    items.push({
      kind: "action",
      label: "New collection…",
      icon: "fas fa-folder-plus",
      run: () => promptNewCollection(x, y, entry.requestId),
    });

    openMenu(layer, items, x, y);
  }

  function openCollectionMenu(collection: Collection, x: number, y: number): void {
    openMenu(
      layer,
      [
        {
          kind: "action",
          label: "Rename…",
          icon: "fas fa-pen",
          run: () => promptRenameCollection(collection, x, y),
        },
        {
          kind: "action",
          label: "New collection…",
          icon: "fas fa-folder-plus",
          run: () => promptNewCollection(x, y),
        },
        { kind: "separator" },
        {
          kind: "action",
          label: "Delete collection",
          icon: "fas fa-trash",
          variant: "danger",
          run: () => deleteCollection(collection),
        },
      ],
      x,
      y
    );
  }

  // ── Row menu ─────────────────────────────────────────────────────────────────

  function openRowMenu(entry: Entry, x: number, y: number): void {
    lastMenuX = x;
    lastMenuY = y;
    openMenu(
      layer,
      [
        ...sendItems(entry),
        { kind: "separator" },
        ...copyItems(entry),
        { kind: "separator" },
        {
          kind: "action",
          label: "Move to…",
          icon: "far fa-folder",
          run: () => openMoveMenu(entry, x, y),
        },
        {
          kind: "action",
          label: "Remove from Inspector",
          icon: "fas fa-trash",
          variant: "danger",
          run: () => void removeEntry(entry.requestId),
        },
      ],
      x,
      y
    );
  }

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      sdk.window.showToast(`${what} copied.`, { variant: "success" });
    } catch (err) {
      sdk.window.showToast(`Could not copy ${what}: ${describe(err)}`, { variant: "error" });
    }
  }

  async function copyRaw(entry: Entry, which: "request" | "response"): Promise<void> {
    try {
      const result = await withTimeout(
        sdk.graphql.request({ id: entry.requestId }),
        "Loading request"
      );
      const req = result.request;
      if (req === null || req === undefined) {
        sdk.window.showToast("Request is no longer available in this project.", {
          variant: "warning",
        });
        return;
      }

      if (which === "request") {
        await copy(req.raw ?? "", "Raw request");
        return;
      }

      const responseId = req.response?.id;
      if (responseId === undefined) {
        sdk.window.showToast("No response was captured for this request.", { variant: "info" });
        return;
      }
      const respResult = await withTimeout(
        sdk.graphql.response({ id: responseId }),
        "Loading response"
      );
      const raw = respResult.response?.raw;
      if (raw === undefined || raw === null) {
        sdk.window.showToast("No response body to copy.", { variant: "info" });
        return;
      }
      await copy(raw, "Raw response");
    } catch (err) {
      sdk.window.showToast(`Inspector: ${describe(err)}`, { variant: "error" });
    }
  }

  async function openInReplay(entry: Entry): Promise<void> {
    try {
      await sdk.replay.createSession({ type: "ID", id: entry.requestId });
    } catch (err) {
      sdk.window.showToast(`Could not open in Replay: ${describe(err)}`, { variant: "error" });
    }
  }

  /**
   * The bridge to Caido's own request menu: jump to HTTP History and scroll the
   * row into view, where a right-click gives the full native context menu.
   */
  async function showInHistory(entry: Entry): Promise<void> {
    let filterHint = "";
    try {
      // A query or scope can hide the row; scrollTo then silently does nothing.
      const query = sdk.httpHistory.getQuery();
      const scoped = sdk.httpHistory.getScopeId() !== undefined;
      if (query !== "" || scoped) {
        filterHint = scoped
          ? "HTTP History has an active filter and scope."
          : "HTTP History has an active filter.";
      }
    } catch {
      // Reading the query is best-effort.
    }

    try {
      sdk.navigation.goTo({ id: "HTTPHistory" });
    } catch (err) {
      sdk.window.showToast(`Could not open HTTP History: ${describe(err)}`, { variant: "error" });
      return;
    }

    // The table mounts after the route change.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    try {
      // Declared as `void`, but the implementation is async and rejects on error.
      await (sdk.httpHistory.scrollTo(entry.requestId) as unknown as Promise<void> | undefined);
      if (filterHint !== "") {
        sdk.window.showToast(`${filterHint} Clear it if the request is not shown.`, {
          variant: "info",
        });
      }
    } catch (err) {
      sdk.window.showToast(`Could not jump to the request: ${describe(err)}`, { variant: "error" });
    }
  }

  function promptForFinding(entry: Entry, x: number, y: number): void {
    openPrompt(
      layer,
      { label: "Finding title", value: entry.path, confirmLabel: "Create" },
      (title) => void createFinding(entry, title),
      x,
      y
    );
  }

  async function createFinding(entry: Entry, title: string): Promise<void> {
    try {
      const finding = await sdk.findings.createFinding(entry.requestId, {
        title,
        description: `Flagged in Inspector: ${urlFor(entry)}`,
        reporter: FINDING_REPORTER,
        dedupeKey: `inspector:${entry.requestId}:${title}`,
      });
      if (finding === undefined) {
        sdk.window.showToast("Finding already exists.", { variant: "info" });
        return;
      }
      sdk.window.showToast("Finding created.", { variant: "success" });
    } catch (err) {
      sdk.window.showToast(`Could not create finding: ${describe(err)}`, { variant: "error" });
    }
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
    if (selectedId === requestId) {
      selectedId = undefined;
      generation++;
      clearEditors();
    }
    await withProject(
      (project) => sdk.backend.removeEntry(project, requestId),
      "Inspector: could not remove the request"
    );
  }

  async function clearAll(): Promise<void> {
    const count = data.entries.length;
    if (projectId === undefined || count === 0) return;
    const noun = count === 1 ? "request" : "requests";
    if (!window.confirm(`Remove all ${count} saved ${noun} from this project? This cannot be undone.`)) {
      return;
    }

    selectedId = undefined;
    generation++;
    clearEditors();
    await withProject(
      (project) => sdk.backend.clearEntries(project),
      "Inspector: could not clear the saved requests"
    );
  }

  /** Reloads the current project's saved requests from the backend. */
  async function refresh(): Promise<void> {
    const project = projectId;
    if (project === undefined) return;
    const next = await call(
      sdk,
      sdk.backend.getProject(project),
      "Inspector: could not load the saved requests"
    );
    if (next !== undefined) show(project, next);
  }

  // Another client (window, browser tab) or a context-menu save changed a project.
  sdk.backend.onEvent("inspector:changed", (changed) => {
    if (changed === projectId) void refresh();
  });

  renderList();

  return {
    root,
    show,
    /** Switching projects invalidates the selection, the list and the editors. */
    setProject(nextProjectId: string | undefined): void {
      if (nextProjectId === projectId) return;
      layer.close();
      projectId = nextProjectId;
      data = emptyProject();
      selectedId = undefined;
      generation++;
      clearEditors();
      renderList();
      void refresh();
    },
    /**
     * Fires before the page is attached again. Swaps in fresh editors (see
     * `createEditorSlot`), which then get the last content replayed.
     */
    onEnter(): void {
      layer.close();
      mountEditor(reqPane, reqWriter.renew());
      mountEditor(respPane, respWriter.renew());
      renderList();
      void refresh();
    },
  };
}

type Page = ReturnType<typeof buildPage>;

// ─── Command ──────────────────────────────────────────────────────────────────

type RequestLike = { host: string; path: string; query?: string; port?: number; isTls?: boolean };

/** Drafts have no id yet, so there is nothing stable to save. */
function toCandidate(req: RequestLike & { id?: string }): Candidate | undefined {
  if (req.id === undefined || req.id === "") return undefined;
  const query = req.query ?? "";
  return {
    requestId: req.id,
    host: req.host,
    path: req.path + (query ? `?${query}` : ""),
    port: req.port,
    isTls: req.isTls,
  };
}

/**
 * Request ids selected on the current page. Keyboard shortcuts run commands
 * with a bare `BaseContext`, so the selection has to be recovered from the
 * global page context instead.
 */
function selectedIdsFromPage(sdk: FrontendSDK): string[] {
  let page;
  try {
    page = sdk.window.getContext().page;
  } catch {
    return [];
  }
  if (page === undefined) return [];

  const selection =
    page.kind === "HTTPHistory"
      ? page.selection
      : page.kind === "Sitemap"
        ? page.requestSelection
        : undefined;

  if (selection === undefined || selection.kind !== "Selected") return [];
  return [selection.main, ...selection.secondary];
}

/** Turns bare ids into entries by fetching the metadata the context lacks. */
async function candidatesFromIds(sdk: FrontendSDK, ids: string[]): Promise<Candidate[]> {
  const found = await Promise.all(
    ids.map(async (id) => {
      try {
        const result = await withTimeout(sdk.graphql.request({ id }), "Loading request");
        const req = result.request;
        if (req === null || req === undefined) return undefined;
        return toCandidate({
          id,
          host: req.host,
          path: req.path,
          query: req.query,
          port: req.port,
          isTls: req.isTls,
        });
      } catch {
        return undefined;
      }
    })
  );
  return found.filter((c): c is Candidate => c !== undefined);
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
  sdk: FrontendSDK,
  page: Page,
  projectId: string | undefined,
  context: CommandContext
): Promise<void> {
  let candidates = candidatesFrom(context);
  if (candidates.length === 0 && context.type === "BaseContext") {
    candidates = await candidatesFromIds(sdk, selectedIdsFromPage(sdk));
  }
  if (candidates.length === 0) {
    sdk.window.showToast("Inspector: select a request first.", { variant: "info" });
    return;
  }
  if (projectId === undefined) {
    sdk.window.showToast("Inspector: select a project first.", { variant: "warning" });
    return;
  }

  // One backend call for the whole selection, so saving many rows costs a
  // single write and a single re-render.
  const result = await call(
    sdk,
    sdk.backend.addEntries(projectId, candidates),
    "Inspector: could not save"
  );
  if (result === undefined) return;
  page.show(projectId, result.data);

  const { added } = result;
  if (added === 0) {
    sdk.window.showToast("Already in Inspector.", { variant: "info" });
  } else if (added === 1) {
    sdk.window.showToast("Sent to Inspector!", { variant: "success" });
  } else {
    sdk.window.showToast(`Sent ${added} requests to Inspector!`, { variant: "success" });
  }
}

// ─── Plugin Entry Point ───────────────────────────────────────────────────────

export function init(sdk: FrontendSDK): void {
  const page = buildPage(sdk);

  let projectId: string | undefined;
  let projectKnown = false;

  const setProject = (nextProjectId: string | undefined): void => {
    projectKnown = true;
    projectId = nextProjectId;
    page.setProject(nextProjectId);
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
    run: (ctx) => sendToInspector(sdk, page, projectId, ctx),
    group: "Inspector",
  });

  // Registered after the command: Caido ignores a shortcut for an unknown
  // command id. It only sets a default — an existing user binding is kept.
  sdk.shortcuts.register("send-to-inspector", [primaryModifier(), "Shift", "I"]);

  sdk.menu.registerItem({ type: "RequestRow", commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
  sdk.menu.registerItem({ type: "Request",    commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
  sdk.menu.registerItem({ type: "Response",   commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
}
