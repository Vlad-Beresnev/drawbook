import { useCallback, useEffect, useRef, useState } from "react";
import { getCommonBounds } from "@excalidraw/excalidraw";
import { aiApi } from "../api";
import { describeSelection, readFileAsAttachment } from "./selection";
import { extractChanges, planChanges } from "./changes";
import { applyChanges } from "./applyChanges";
import "./AiDrawer.css";

// The AI Drawer: a chat about the open drawing. Chats are opencode sessions,
// one drawing can have many.

const MODEL_KEY = "drawbook.aiModel";
const APPLIED_KEY = "drawbook.aiApplied";
const MAX_REMEMBERED_APPLIED = 500;
const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPT = "image/*,application/pdf,text/*,.md,.json,.csv,.excalidraw";

const modelKey = (m) => (m ? `${m.providerID}/${m.id}` : "");

function loadModelKey() {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}

function saveModelKey(key) {
  try {
    localStorage.setItem(MODEL_KEY, key);
  } catch {
    // not remembered; the default model is used next time
  }
}

// Which answers were already applied, so a reload does not offer Apply twice.
function loadApplied() {
  try {
    return new Set(JSON.parse(localStorage.getItem(APPLIED_KEY)) ?? []);
  } catch {
    return new Set();
  }
}

function saveApplied(ids) {
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify([...ids].slice(-MAX_REMEMBERED_APPLIED)));
  } catch {
    // not remembered; Apply shows again after a reload
  }
}

// The part of the canvas on screen, in canvas coordinates, so the AI can
// place new shapes where the user can see them.
function visibleArea(api) {
  const { scrollX, scrollY, zoom, width, height } = api.getAppState();
  const round = (n) => Math.round(n);
  return { x: round(-scrollX), y: round(-scrollY), width: round(width / zoom.value), height: round(height / zoom.value) };
}

// Where shapes already are, so the AI puts new diagrams in free space instead
// of on top of the drawing. Null for an empty canvas.
function occupiedArea(api) {
  const elements = api.getSceneElements();
  if (elements.length === 0) return null;
  const [x1, y1, x2, y2] = getCommonBounds(elements);
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
}

function autoGrowComposer(element) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function formatRelativeTime(ms) {
  if (!ms) return "";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
  const seconds = Math.round((ms - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.trunc(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.trunc(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.trunc(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  const months = Math.trunc(days / 30);
  if (Math.abs(months) < 12) return formatter.format(months, "month");
  return formatter.format(Math.trunc(months / 12), "year");
}

const shapesLabel = (n) => `${n} selected shape${n === 1 ? "" : "s"}`;

function ChangesCard({ changes, allowedIds, applied, excalidrawAPI, onApplied }) {
  const [error, setError] = useState("");
  if (changes.error) return <p className="changes changes-error">The AI sent changes that cannot be read: {changes.error}.</p>;

  // Checked again on every render and on Apply: the canvas may have changed
  // since the answer arrived.
  const plan = planChanges(changes.orders, { elements: excalidrawAPI.getSceneElements(), allowedIds });

  function apply() {
    const fresh = planChanges(changes.orders, { elements: excalidrawAPI.getSceneElements(), allowedIds });
    if (!fresh.ok) return;
    try {
      applyChanges(excalidrawAPI, fresh.steps);
      onApplied();
    } catch (err) {
      setError(`The changes could not be applied: ${err.message}`);
    }
  }

  return (
    <section className="changes" aria-label="Changes to the canvas">
      {plan.ok ? (
        <ul>
          {plan.steps.map((step, i) => (
            <li key={i}>{step.label}</li>
          ))}
        </ul>
      ) : (
        <ul className="changes-error">
          {plan.errors.map((why, i) => (
            <li key={i}>{why}</li>
          ))}
        </ul>
      )}
      {applied ? (
        <p className="applied">Applied · ⌘Z to undo</p>
      ) : (
        <button type="button" className="apply" disabled={!plan.ok} onClick={apply}>
          {plan.ok ? `Apply ${plan.steps.length} change${plan.steps.length === 1 ? "" : "s"}` : "Nothing will change"}
        </button>
      )}
      {error && <p className="changes-error">{error}</p>}
    </section>
  );
}

function MessageBubble({ message, changes, children }) {
  const text = changes ? changes.text : message.text;
  const hasChips = message.selectionCount > 0 || message.files?.length > 0;
  return (
    <article className="message" data-role={message.role}>
      {text && <p>{text}</p>}
      {message.error && <p className="message-error">{message.error}</p>}
      {hasChips && (
        <ul className="chips">
          {message.selectionCount > 0 && <li data-kind="selection">◇ {shapesLabel(message.selectionCount)}</li>}
          {message.files?.map((f, i) => (
            <li key={i} title={f.name}>
              {f.name}
            </li>
          ))}
        </ul>
      )}
      {children}
    </article>
  );
}

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
);

// SVG, not "+" and "↑" characters: font glyphs sit below the middle of the
// line, so they never line up with the text next to them.
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const ArrowUpIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

const lastPart = (path) => path.split("/").at(-1);

// Folders of the projects folder (e.g. ~/Projects) that hold git-tracked code (copies and worktrees are
// hidden by the server). Click a folder to open it, attach the open one.
function ProjectPicker({ current, onAttach, onClose }) {
  const [path, setPath] = useState("");
  const [folders, setFolders] = useState(null);
  const [root, setRoot] = useState("projects");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setFolders(null);
    setError("");
    aiApi
      .projects(path)
      .then((result) => {
        if (!active) return;
        setRoot(result.root);
        setFolders(result.folders);
      })
      .catch((err) => active && setError(err.message));
    return () => {
      active = false;
    };
  }, [path]);

  const up = () => setPath(path.split("/").slice(0, -1).join("/"));

  return (
    <div className="project-picker" role="dialog" aria-label="Attach a project">
      <header>
        <button className="icon" type="button" onClick={up} disabled={!path} aria-label="Back" title="Back">
          ‹
        </button>
        <p title={path ? `${root}/${path}` : root}>{path ? `${root}/${path}` : root}</p>
        <button className="icon" type="button" onClick={onClose} aria-label="Close" title="Close">
          ×
        </button>
      </header>
      {error && <p className="empty error">{error}</p>}
      {!error && folders === null && <p className="empty">Loading…</p>}
      {folders?.length === 0 && <p className="empty">No code folders here</p>}
      {folders?.length > 0 && (
        <ul>
          {folders.map((folder) => (
            <li key={folder.path}>
              <button type="button" onClick={() => setPath(folder.path)} data-active={folder.path === current || undefined}>
                <FolderIcon />
                <span>{folder.name}</span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <footer>
        <button className="apply" type="button" disabled={!path} onClick={() => onAttach(path)}>
          {path ? `Attach “${lastPart(path)}”` : "Open a project folder"}
        </button>
        <p className="note">The AI reads only git-tracked files. Secret files like .env are left out.</p>
      </footer>
    </div>
  );
}

const PencilIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);

export function AiDrawer({ drawing, excalidrawAPI, selectionCount, onClose }) {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(null);
  const [chats, setChats] = useState([]);
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [includeSelection, setIncludeSelection] = useState(true);
  const [pending, setPending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(loadApplied);
  // The attached code project (#15): of the open chat, or chosen for the next new chat.
  const [project, setProject] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);

  const composerRef = useRef(null);
  const fileInputRef = useRef(null);
  const messagesRef = useRef(null);
  const lastPinnedMessageId = useRef(null);
  const activeDrawing = useRef(drawing);

  useEffect(() => {
    aiApi
      .models()
      .then(({ models, default: fallback }) => {
        setModels(models);
        const stored = models.find((m) => modelKey(m) === loadModelKey());
        setModel(stored ?? models.find((m) => modelKey(m) === modelKey(fallback)) ?? models[0] ?? null);
      })
      .catch((err) => setError(`AI is not available: ${err.message}`));
  }, []);

  const loadMessages = useCallback(async (id) => {
    setChatId(id);
    setMessages([]);
    if (!id) return;
    setPending(true);
    try {
      setMessages(await aiApi.messages(id));
    } catch (err) {
      setError(`This chat could not be loaded: ${err.message}`);
    } finally {
      setPending(false);
    }
  }, []);

  // Each drawing has its own chats. Open the newest one when the drawing changes.
  useEffect(() => {
    activeDrawing.current = drawing;
    setError("");
    setHistoryOpen(false);
    setChats([]);
    loadMessages(null);
    aiApi
      .chats(drawing)
      .then((list) => {
        if (activeDrawing.current !== drawing) return;
        setChats(list);
        setProject(list[0]?.project ?? null);
        if (list.length > 0) loadMessages(list[0].id);
      })
      .catch((err) => setError(`Chats could not be loaded: ${err.message}`));
  }, [drawing, loadMessages]);

  // Keep the newest question in view.
  useEffect(() => {
    const list = messagesRef.current;
    const last = messages.at(-1);
    if (!list || !last || last.id === lastPinnedMessageId.current) return;
    lastPinnedMessageId.current = last.id;
    const users = list.querySelectorAll('.message[data-role="user"]');
    const lastUser = users.item(users.length - 1);
    if (!(lastUser instanceof HTMLElement) || last.role === "user") {
      list.scrollTop = list.scrollHeight;
      return;
    }
    const top = lastUser.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo({ top, behavior: "smooth" });
  }, [messages, pending]);

  useEffect(() => {
    if (draft === "") autoGrowComposer(composerRef.current);
  }, [draft]);

  async function addFiles(fileList) {
    const files = [...fileList];
    const tooBig = files.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      setError(`"${tooBig.name}" is larger than 10 MB`);
      return;
    }
    const added = await Promise.all(files.map(readFileAsAttachment));
    setAttachments((current) => {
      const next = [...current, ...added.filter((a) => !current.some((c) => c.id === a.id))];
      if (next.length > MAX_ATTACHMENTS) setError(`You can attach up to ${MAX_ATTACHMENTS} files`);
      return next.slice(0, MAX_ATTACHMENTS);
    });
  }

  function newChat() {
    setError("");
    setHistoryOpen(false);
    setProject(null);
    loadMessages(null);
    composerRef.current?.focus();
  }

  function selectChat(id) {
    if (id === chatId || pending) return;
    setError("");
    setHistoryOpen(false);
    setProject(chats.find((c) => c.id === id)?.project ?? null);
    loadMessages(id);
  }

  async function deleteChat(chat) {
    if (!window.confirm(`Delete the chat "${chat.title}"?`)) return;
    try {
      await aiApi.removeChat(chat.id);
      setChats((current) => current.filter((c) => c.id !== chat.id));
      if (chat.id === chatId) {
        setProject(null);
        loadMessages(null);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  // Attach (a folder path) or detach (null). A new chat gets it when it is created.
  async function changeProject(path) {
    setPickerOpen(false);
    setError("");
    if (!chatId) {
      setProject(path);
      return;
    }
    setProjectBusy(true);
    try {
      const chat = await aiApi.setProject(chatId, path);
      setProject(chat.project);
      setChats((current) => current.map((c) => (c.id === chat.id ? { ...c, project: chat.project } : c)));
    } catch (err) {
      setError(`The project could not be ${path ? "attached" : "removed"}: ${err.message}`);
    } finally {
      setProjectBusy(false);
    }
  }

  async function changeModel(key) {
    const next = models.find((m) => modelKey(m) === key);
    if (!next) return;
    setModel(next);
    saveModelKey(key);
    if (chatId) await aiApi.setModel(chatId, next).catch((err) => setError(err.message));
  }

  async function submit() {
    const text = draft.trim();
    if (!text || pending || !model) return;
    setError("");
    setPending(true);

    const sentAttachments = attachments;
    const withSelection = includeSelection && selectionCount > 0;
    const optimistic = {
      id: `temp-${Date.now()}`,
      role: "user",
      text,
      selectionCount: withSelection ? selectionCount : 0,
      files: sentAttachments.map((a) => ({ name: a.name, type: a.type })),
    };
    setDraft("");
    setAttachments([]);
    setMessages((current) => [...current, optimistic]);

    try {
      const selection = withSelection ? await describeSelection(excalidrawAPI) : null;
      // A text-only model gets the shapes as text but not the picture of them.
      if (selection && !model.image) delete selection.image;
      let id = chatId;
      if (!id) {
        const chat = await aiApi.createChat(drawing, model);
        id = chat.id;
        setChatId(id);
        if (project) await aiApi.setProject(id, project);
      }
      const files = sentAttachments.map(({ name, dataUrl }) => ({ name, dataUrl }));
      const result = await aiApi.send(id, { text, files, selection, view: visibleArea(excalidrawAPI), occupied: occupiedArea(excalidrawAPI) });
      if (activeDrawing.current !== drawing) return;
      autoApply(result);
      setMessages(result);
      setChats(await aiApi.chats(drawing));
    } catch (err) {
      setError(err.message);
      setDraft(text);
      setAttachments(sentAttachments);
      setMessages((current) => current.filter((m) => m.id !== optimistic.id));
    } finally {
      setPending(false);
    }
  }

  // A new answer with changes is applied at once; Cmd+Z undoes it. Only the
  // answer to this question: old answers in the history are never re-applied.
  function autoApply(result) {
    const answer = result.at(-1);
    const question = result.at(-2);
    if (answer?.role !== "assistant" || question?.role !== "user") return;
    const { orders } = extractChanges(answer.text ?? "");
    if (!orders) return;
    const plan = planChanges(orders, { elements: excalidrawAPI.getSceneElements(), allowedIds: question.selectionIds ?? [] });
    if (!plan.ok) return; // the card shows why nothing changed
    try {
      applyChanges(excalidrawAPI, plan.steps);
      markApplied(answer.id);
    } catch (err) {
      setError(`The changes could not be applied: ${err.message}`);
    }
  }

  function markApplied(id) {
    setApplied((current) => {
      const next = new Set(current).add(id);
      saveApplied(next);
      return next;
    });
  }

  // An answer may change only the shapes that were selected with its question.
  let allowedIds = [];
  const rendered = messages.map((message) => {
    if (message.role === "user") {
      allowedIds = message.selectionIds ?? [];
      return <MessageBubble key={message.id} message={message} />;
    }
    const changes = extractChanges(message.text ?? "");
    const hasChanges = changes.orders !== null || changes.error !== null;
    return (
      <MessageBubble key={message.id} message={message} changes={changes}>
        {hasChanges && (
          <ChangesCard
            changes={changes}
            allowedIds={allowedIds}
            applied={applied.has(message.id)}
            excalidrawAPI={excalidrawAPI}
            onApplied={() => markApplied(message.id)}
          />
        )}
      </MessageBubble>
    );
  });

  const imageWarning = model && !model.image && attachments.some((a) => a.type.startsWith("image/"));

  return (
    <aside
      className="ai-drawer"
      aria-label="AI Drawer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      <header>
        <button className="icon" type="button" aria-label="Close AI Drawer" title="Close" onClick={onClose}>
          ×
        </button>
        <p>AI Drawer</p>
        <div className="actions">
          <button
            className="icon"
            type="button"
            aria-expanded={historyOpen}
            aria-controls="ai-drawer-history"
            aria-label="Chats of this drawing"
            title="Chats of this drawing"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <ClockIcon />
          </button>
          <button className="new" type="button" aria-label="New chat" title="New chat" onClick={newChat}>
            <PencilIcon />
          </button>
        </div>

        {historyOpen && (
          <div className="history" id="ai-drawer-history" role="dialog" aria-label="Chats of this drawing">
            {chats.length === 0 ? (
              <p className="empty">No chats for this drawing yet</p>
            ) : (
              <ul>
                {chats.map((chat) => (
                  <li key={chat.id}>
                    <button type="button" data-active={chat.id === chatId || undefined} aria-current={chat.id === chatId ? "true" : undefined} onClick={() => selectChat(chat.id)}>
                      <span title={chat.title}>{chat.title}</span>
                      <time>{formatRelativeTime(chat.updatedAt)}</time>
                    </button>
                    <button className="delete" type="button" aria-label={`Delete ${chat.title}`} title="Delete chat" onClick={() => deleteChat(chat)}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </header>

      <label className="model">
        <span>Model</span>
        <select value={modelKey(model)} onChange={(e) => changeModel(e.target.value)} disabled={models.length === 0}>
          {/* Only connected providers have models; an empty group is not shown. */}
          {["openai", "opencode"].filter((provider) => models.some((m) => m.providerID === provider)).map((provider) => (
            <optgroup key={provider} label={provider === "openai" ? "OpenAI (your plan)" : "OpenCode Zen (free, limited)"}>
              {models
                .filter((m) => m.providerID === provider)
                .map((m) => (
                  <option key={modelKey(m)} value={modelKey(m)}>
                    {m.name}
                    {m.image ? "" : " · text only"}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>

      <div className="messages" aria-live="polite" ref={messagesRef}>
        {messages.length === 0 && !pending && <p className="empty">Ask about “{drawing}”. Select shapes to talk about them or change them.</p>}
        {rendered}
        {pending && <p className="status">Thinking…</p>}
      </div>

      {pickerOpen && <ProjectPicker current={project} onAttach={changeProject} onClose={() => setPickerOpen(false)} />}

      {(attachments.length > 0 || selectionCount > 0 || project) && (
        <ul className="chips attached" aria-label="Sent with the next message">
          {project && (
            <li data-kind="project" title={`${project}: the AI can read its git-tracked files`}>
              <FolderIcon />
              <span>{projectBusy ? "Copying…" : lastPart(project)}</span>
              <button type="button" aria-label="Remove the project" title="Remove the project" disabled={projectBusy || pending} onClick={() => changeProject(null)}>
                ×
              </button>
            </li>
          )}
          {selectionCount > 0 && (
            <li data-kind="selection" data-off={!includeSelection || undefined}>
              <span>◇ {shapesLabel(selectionCount)}</span>
              <button
                type="button"
                aria-label={includeSelection ? "Do not send the selection" : "Send the selection"}
                title={includeSelection ? "Do not send the selection" : "Send the selection"}
                onClick={() => setIncludeSelection((on) => !on)}
              >
                {includeSelection ? "×" : "+"}
              </button>
            </li>
          )}
          {attachments.map((a) => (
            <li key={a.id}>
              <span title={a.name}>{a.name}</span>
              <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((current) => current.filter((c) => c.id !== a.id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button className="attach" type="button" aria-label="Attach files" title="Attach files or images" onClick={() => fileInputRef.current?.click()}>
          <PlusIcon />
        </button>
        <button
          className="attach"
          type="button"
          aria-label="Attach project"
          aria-expanded={pickerOpen}
          title="Attach a code project"
          disabled={projectBusy || pending}
          onClick={() => setPickerOpen((open) => !open)}
        >
          <FolderIcon />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <label className="question">
          <span className="sr-only">Your message</span>
          <textarea
            ref={composerRef}
            value={draft}
            maxLength={20000}
            rows={1}
            placeholder="Ask or ask for a change…"
            onKeyDown={(e) => {
              // Excalidraw listens to keys on the whole page; typing here must not draw.
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
                return;
              }
              // Insert the text from the event ourselves. Chrome's default
              // paste reads the system clipboard a second time, and dictation
              // apps (Spokenly "smart paste") restore the old clipboard right
              // after Cmd+V, so on a busy page Chrome sometimes inserted
              // nothing (#11). The event's own copy is always correct.
              const text = e.clipboardData.getData("text/plain");
              if (!text) return;
              e.preventDefault();
              const box = e.currentTarget;
              // insertText keeps native undo and fires "input" (-> onChange).
              if (!document.execCommand("insertText", false, text)) {
                box.setRangeText(text, box.selectionStart, box.selectionEnd, "end");
                setDraft(box.value);
                autoGrowComposer(box);
              }
            }}
            onChange={(e) => {
              setDraft(e.target.value);
              autoGrowComposer(e.currentTarget);
            }}
          />
        </label>
        <button className="send" type="submit" aria-label="Send" disabled={pending || !model || draft.trim().length === 0} data-loading={pending || undefined}>
          <ArrowUpIcon />
        </button>
      </form>

      {imageWarning && <p className="note">{model.name} cannot see images. Choose a model without “text only”.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
