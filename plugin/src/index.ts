import type { Caido } from "@caido/sdk-frontend";
import type { CommandContext } from "@caido/sdk-frontend";

// ─── Types ────────────────────────────────────────────────────────────────────

type Entry = {
  requestId: string;
  host: string;
  path: string;
  savedAt: string;
};

// ─── Storage ──────────────────────────────────────────────────────────────────

function getEntries(sdk: Caido): Entry[] {
  const data = sdk.storage.get() as { entries?: Entry[] } | null;
  return data?.entries ?? [];
}

async function saveEntries(sdk: Caido, entries: Entry[]): Promise<void> {
  await sdk.storage.set({ entries });
}

async function addEntry(
  sdk: Caido,
  requestId: string,
  host: string,
  path: string
): Promise<"added" | "duplicate"> {
  const entries = getEntries(sdk);
  if (entries.some((e) => e.requestId === requestId)) return "duplicate";
  entries.unshift({ requestId, host, path, savedAt: new Date().toISOString() });
  await saveEntries(sdk, entries);
  return "added";
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function setEditorContent(editorView: unknown, content: string): void {
  const view = editorView as {
    dispatch: (spec: unknown) => void;
    state: { doc: { length: number } };
  };
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
}

function buildPage(sdk: Caido): HTMLElement {
  const reqEditor = sdk.ui.httpRequestEditor();
  const respEditor = sdk.ui.httpResponseEditor();
  let selectedId: string | null = null;

  // ── Root ────────────────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.style.cssText = "display:flex;height:100%;overflow:hidden;";

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
  clearBtn.addEventListener("click", async () => {
    await saveEntries(sdk, []);
    selectedId = null;
    renderList();
    setEditorContent(reqEditor.getEditorView(), "");
    setEditorContent(respEditor.getEditorView(), "");
  });

  toolbar.appendChild(toolbarTitle);
  toolbar.appendChild(clearBtn);

  const list = document.createElement("div");
  list.style.cssText = "flex:1;overflow-y:auto;";

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

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function renderList(): void {
    const entries = getEntries(sdk);
    list.innerHTML = "";

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No saved requests.";
      empty.style.cssText = "padding:16px 12px;color:#666;font-size:13px;";
      list.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const item = document.createElement("div");
      const active = entry.requestId === selectedId;
      item.style.cssText = `
        padding:8px 12px;cursor:pointer;
        border-bottom:1px solid var(--c-border-default,#222);
        background:${active ? "var(--c-bg-subtle,#2a2a3a)" : "transparent"};
        display:flex;align-items:flex-start;gap:8px;
      `;
      item.addEventListener("mouseenter", () => {
        if (!active) item.style.background = "var(--c-bg-subtle,#1e1e2a)";
      });
      item.addEventListener("mouseleave", () => {
        if (!active) item.style.background = "transparent";
      });

      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0;";

      const hostPath = document.createElement("div");
      hostPath.textContent = `${entry.host}${entry.path}`;
      hostPath.style.cssText =
        "font-size:12px;color:var(--c-fg-default,#ddd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

      const time = document.createElement("div");
      time.textContent = new Date(entry.savedAt).toLocaleTimeString();
      time.style.cssText = "font-size:11px;color:#666;margin-top:2px;";

      info.appendChild(hostPath);
      info.appendChild(time);

      const delBtn = document.createElement("button");
      delBtn.textContent = "×";
      delBtn.title = "Remove";
      delBtn.style.cssText =
        "background:none;border:none;color:#555;cursor:pointer;font-size:18px;padding:0;line-height:1;flex-shrink:0;";
      delBtn.addEventListener("mouseenter", () => (delBtn.style.color = "#ccc"));
      delBtn.addEventListener("mouseleave", () => (delBtn.style.color = "#555"));
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const updated = getEntries(sdk).filter((e2) => e2.requestId !== entry.requestId);
        await saveEntries(sdk, updated);
        if (selectedId === entry.requestId) {
          selectedId = null;
          setEditorContent(reqEditor.getEditorView(), "");
          setEditorContent(respEditor.getEditorView(), "");
        }
        renderList();
      });

      item.appendChild(info);
      item.appendChild(delBtn);
      item.addEventListener("click", () => loadEntry(entry.requestId));
      list.appendChild(item);
    }
  }

  async function loadEntry(requestId: string): Promise<void> {
    selectedId = requestId;
    renderList();
    try {
      const reqResult = await sdk.graphql.request({ id: requestId });
      const req = reqResult.request;
      if (!req) {
        setEditorContent(reqEditor.getEditorView(), "(request no longer available)");
        setEditorContent(respEditor.getEditorView(), "");
        return;
      }
      setEditorContent(reqEditor.getEditorView(), req.raw ?? "");
      if (req.response?.id) {
        const respResult = await sdk.graphql.response({ id: req.response.id });
        setEditorContent(
          respEditor.getEditorView(),
          respResult.response?.raw ?? "(no response body)"
        );
      } else {
        setEditorContent(respEditor.getEditorView(), "(no response captured)");
      }
    } catch (err) {
      setEditorContent(reqEditor.getEditorView(), `Error loading request: ${err}`);
    }
  }

  // Re-render the list whenever storage changes (e.g. item added via context menu)
  sdk.storage.onChange(() => renderList());

  renderList();
  return root;
}

// ─── Command ──────────────────────────────────────────────────────────────────

async function cmdSendToInspector(sdk: Caido, context: CommandContext): Promise<void> {
  try {
    let added = 0;
    let dupes = 0;

    if (context.type === "RequestRowContext") {
      for (const r of context.requests) {
        const path = r.path + (r.query ? `?${r.query}` : "");
        const result = await addEntry(sdk, r.id, r.host, path);
        result === "added" ? added++ : dupes++;
      }
    } else if (context.type === "RequestContext") {
      const req = context.request;
      if (!("id" in req) || !req.id) return;
      const path = req.path + (req.query ? `?${req.query}` : "");
      const result = await addEntry(sdk, req.id, req.host, path);
      result === "added" ? added++ : dupes++;
    } else if (context.type === "ResponseContext") {
      const req = context.request;
      const path = req.path + (req.query ? `?${req.query}` : "");
      const result = await addEntry(sdk, req.id, req.host, path);
      result === "added" ? added++ : dupes++;
    }

    if (added === 0 && dupes > 0) {
      sdk.window.showToast("Already in Inspector.", { variant: "info" });
    } else if (added === 1) {
      sdk.window.showToast("Sent to Inspector!", { variant: "success" });
    } else if (added > 1) {
      sdk.window.showToast(`Sent ${added} requests to Inspector!`, { variant: "success" });
    }
  } catch (err) {
    sdk.window.showToast(`Inspector error: ${err}`, { variant: "error" });
  }
}

// ─── Plugin Entry Point ───────────────────────────────────────────────────────

export function init(sdk: Caido): void {
  sdk.navigation.addPage("/inspector", { body: buildPage(sdk) });

  sdk.sidebar.registerItem("Inspector", "/inspector", {
    icon: "fas fa-flask",
  });

  sdk.commands.register("send-to-inspector", {
    name: "Send to Inspector",
    run: (ctx) => cmdSendToInspector(sdk, ctx),
    group: "Inspector",
  });

  sdk.menu.registerItem({ type: "RequestRow", commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
  sdk.menu.registerItem({ type: "Request",    commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
  sdk.menu.registerItem({ type: "Response",   commandId: "send-to-inspector", leadingIcon: "fas fa-flask" });
}
