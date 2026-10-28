import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, hashElementsVersion, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { api } from "./api";
import { useFileLibrary } from "./useFileLibrary";
import { AiDrawer } from "./ai/AiDrawer";
import "./App.css";

const SAVE_DELAY_MS = 500;
const EMPTY_SCENE = JSON.stringify({ type: "excalidraw", version: 2, source: "drawbook", elements: [], appState: {}, files: {} });
const STATUS_TEXT = { idle: "Saved", unsaved: "Editing…", saving: "Saving…", saved: "Saved", error: "Save failed" };
const THEME_KEY = "drawbook.theme";
const SIDEBAR_KEY = "drawbook.sidebarOpen";
const AI_DRAWER_KEY = "drawbook.aiDrawerOpen";
const TITLE_BAR_COLOR = { light: "#f8f9fa", dark: "#1b1b1f" }; // matches the sidebar background

// UI preferences are per browser, not per drawing, so they live in localStorage.
// Storage can be blocked (private window), so every access has a fallback.
function loadSetting(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not saved; the app still works with the in-memory value
  }
}

const systemTheme = () => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");

const SidebarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9 4v16" />
  </svg>
);

// What counts as "changed": element versions + background colour. Camera moves,
// selection and zoom do not change this, so they never trigger a save.
const signatureOf = (elements, appState) => `${hashElementsVersion(elements)}:${appState?.viewBackgroundColor ?? "#ffffff"}`;

function untitledName(drawings) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const base = `Untitled ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  const taken = new Set(drawings.map((x) => x.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
  return name;
}

function formatModified(ms) {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

export default function App() {
  const [drawings, setDrawings] = useState([]);
  const [current, setCurrent] = useState(null); // { name, scene }
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(() => loadSetting(THEME_KEY, systemTheme()));
  const [sidebarOpen, setSidebarOpen] = useState(() => loadSetting(SIDEBAR_KEY, "true") === "true");
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(() => loadSetting(AI_DRAWER_KEY, "false") === "true");
  const [selectionCount, setSelectionCount] = useState(0);

  useFileLibrary(excalidrawAPI);

  const currentRef = useRef(null); // { name, signature } of the open drawing
  const pending = useRef(null); // latest unsaved scene: { name, elements, appState, files }
  const timer = useRef(null);
  const saving = useRef(Promise.resolve()); // saves run one after another, never in parallel
  const started = useRef(false);

  const refreshList = useCallback(async () => {
    const list = await api.list();
    setDrawings(list);
    return list;
  }, []);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const job = pending.current;
    pending.current = null;
    if (!job) return saving.current;
    saving.current = saving.current.then(async () => {
      setStatus("saving");
      try {
        await api.save(job.name, serializeAsJSON(job.elements, job.appState, job.files, "local"));
        setStatus("saved");
        setError(null);
        await refreshList();
      } catch (err) {
        // Keep the scene so the next change (or Cmd+S) tries again.
        pending.current ??= job;
        setStatus("error");
        setError(err.message);
      }
    });
    return saving.current;
  }, [refreshList]);

  const open = useCallback(
    async (name) => {
      if (currentRef.current?.name === name) return;
      await flush();
      try {
        const scene = await api.read(name);
        const signature = signatureOf(restoreElements(scene.elements, null), scene.appState);
        currentRef.current = { name, signature };
        setCurrent({ name, scene });
        setStatus("idle");
        setError(null);
      } catch (err) {
        setError(err.message);
      }
    },
    [flush],
  );

  const createDrawing = useCallback(async () => {
    await flush();
    try {
      const name = untitledName(await refreshList());
      await api.create(name, EMPTY_SCENE);
      await refreshList();
      await open(name);
    } catch (err) {
      setError(err.message);
    }
  }, [flush, refreshList, open]);

  const renameDrawing = useCallback(
    async (name) => {
      const to = window.prompt("Rename drawing", name)?.trim();
      if (!to || to === name) return;
      await flush();
      try {
        await api.rename(name, to);
        await refreshList();
        if (currentRef.current?.name === name) {
          currentRef.current = null;
          await open(to);
        }
      } catch (err) {
        setError(err.message);
      }
    },
    [flush, refreshList, open],
  );

  const deleteDrawing = useCallback(
    async (name) => {
      if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
      if (pending.current?.name === name) pending.current = null;
      await flush();
      try {
        await api.remove(name);
        const list = await refreshList();
        if (currentRef.current?.name === name) {
          currentRef.current = null;
          setCurrent(null);
          if (list.length > 0) await open(list[0].name);
          else await createDrawing();
        }
      } catch (err) {
        setError(err.message);
      }
    },
    [flush, refreshList, open, createDrawing],
  );

  const onChange = useCallback(
    (elements, appState, files) => {
      // The theme toggle lives in Excalidraw's menu; mirror it so the sidebar follows.
      setTheme(appState.theme);
      setSelectionCount(Object.values(appState.selectedElementIds).filter(Boolean).length);
      const active = currentRef.current;
      if (!active) return;
      const signature = signatureOf(elements, appState);
      if (signature === active.signature) return;
      active.signature = signature;
      pending.current = { name: active.name, elements, appState, files };
      setStatus("unsaved");
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  // First start: open the most recent drawing, or create one in an empty folder.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    refreshList()
      .then((list) => (list.length > 0 ? open(list[0].name) : createDrawing()))
      .catch((err) => setError(`Cannot reach the Drawbook server: ${err.message}`));
  }, [refreshList, open, createDrawing]);

  useEffect(() => {
    saveSetting(THEME_KEY, theme);
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", TITLE_BAR_COLOR[theme]);
  }, [theme]);

  useEffect(() => {
    saveSetting(SIDEBAR_KEY, String(sidebarOpen));
  }, [sidebarOpen]);

  useEffect(() => {
    saveSetting(AI_DRAWER_KEY, String(aiDrawerOpen));
  }, [aiDrawerOpen]);

  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);

  // Save right away when the window is hidden or closed, and on Cmd+S.
  // Cmd+\ shows or hides the sidebar.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flush();
    const onKeyDown = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        flush();
      } else if (e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [flush, toggleSidebar]);

  const toggleLabel = `${sidebarOpen ? "Hide" : "Show"} sidebar (⌘\\)`;

  return (
    <div className="app" data-theme={theme}>
      <aside className={sidebarOpen ? "sidebar" : "sidebar collapsed"}>
        <header>
          <button className="icon" onClick={toggleSidebar} title={toggleLabel} aria-label={toggleLabel} aria-expanded={sidebarOpen}>
            <SidebarIcon />
            {!sidebarOpen && status === "error" && <span className="error-dot" />}
          </button>
          {sidebarOpen && <span className="logo">Drawbook</span>}
          <button className="new" onClick={createDrawing} title="New drawing" aria-label="New drawing">
            {sidebarOpen ? "+ New" : "+"}
          </button>
        </header>
        {sidebarOpen && (
          <>
            <ul className="drawings">
              {drawings.map((d) => (
                <li key={d.name} className={d.name === current?.name ? "active" : undefined}>
                  <button className="open" onClick={() => open(d.name)} onDoubleClick={() => renameDrawing(d.name)} title="Double-click to rename">
                    <span className="name">{d.name}</span>
                    <span className="modified">{formatModified(d.modified)}</span>
                  </button>
                  <button className="delete" onClick={() => deleteDrawing(d.name)} aria-label={`Delete ${d.name}`} title="Delete">
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <footer className={`status ${status}`}>{error ?? STATUS_TEXT[status]}</footer>
          </>
        )}
      </aside>
      <main className="canvas">
        {current && (
          <Excalidraw
            key={current.name}
            name={current.name}
            initialData={{ elements: current.scene.elements, appState: current.scene.appState, files: current.scene.files, scrollToContent: true }}
            excalidrawAPI={setExcalidrawAPI}
            theme={theme}
            onChange={onChange}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: true } }}
          />
        )}
      </main>
      {aiDrawerOpen && current && excalidrawAPI && (
        <AiDrawer drawing={current.name} excalidrawAPI={excalidrawAPI} selectionCount={selectionCount} onClose={() => setAiDrawerOpen(false)} />
      )}
      {/* Sits in Excalidraw's footer row, left of its "?" help button. */}
      {current && (
        <button className="ai-drawer-button" type="button" aria-pressed={aiDrawerOpen} title="AI Drawer" onClick={() => setAiDrawerOpen((open) => !open)}>
          <span aria-hidden="true">✦</span> AI Drawer
        </button>
      )}
    </div>
  );
}
