import { AiError } from "./opencode.js";

const APP = "drawbook";
const NEW_CHAT_TITLE = "New chat";
const CONTEXT_START = "<drawbook-context>";
const CONTEXT_END = "</drawbook-context>";
export const SELECTION_IMAGE = "drawbook-selection.png";

// Every Drawbook session denies every tool: no shell, no file edits, no MCP
// tools. The AI Drawer only talks.
export const DENY_ALL = [{ action: "*", resource: "*", effect: "deny" }];

// A chat with an attached project (#15) may also read, search and list files,
// but only in its working directory: the mirror of the project's git-tracked
// files. Reading outside it is an "external directory" and stays denied.
export const READ_PROJECT = [...DENY_ALL, ...["read", "grep", "glob"].map((action) => ({ action, resource: "*", effect: "allow" }))];

// The model list shows only what the user can really use (#17): OpenCode Zen's
// free models, and OpenAI when it is connected. Other connected providers
// (Vercel, GitHub Copilot) are left out for now.
const ZEN = "opencode";
const SHOWN_PROVIDERS = new Set([ZEN, "openai"]);
const MAX_TEXT_LENGTH = 20_000;
const MAX_FILES = 10;
const MAX_LIST_PAGES = 20;
const MAX_MESSAGES = 200; // opencode's page limit

// How the AI changes the canvas. It never writes Excalidraw elements: it writes
// short orders, and the browser checks each one before the user can apply it
// (src/ai/changes.js). Only selected shapes may be changed or deleted.
const CHANGES_GUIDE = [
  "You can change the canvas. To do it, end your answer with ONE fenced block named drawbook-changes that holds a JSON list of orders:",
  "```drawbook-changes",
  '[{"op":"setText","id":"<selected id>","text":"new text"}]',
  "```",
  "Orders:",
  '- {"op":"setText","id":"<selected id>","text":"..."}: replaces the text of a text shape, or the label of a box.',
  '- {"op":"setColor","id":"<selected id>","stroke":"#1e1e1e","background":"#a5d8ff"}: either key; background may be "transparent".',
  '- {"op":"delete","id":"<selected id>"}',
  '- {"op":"add","shape":{"type":"rectangle","id":"n1","x":0,"y":0,"width":180,"height":80,"text":"label","stroke":"#1e1e1e","background":"#a5d8ff"}}: type is rectangle, ellipse, diamond, text or arrow. Only type, x and y are required.',
  '- An arrow between two new shapes: {"op":"add","shape":{"type":"arrow","from":"n1","to":"n2","text":"optional"}}. from and to must be ids of shapes added earlier in the same list.',
  "Rules:",
  "- setText, setColor and delete may only use ids of the selected shapes listed below. Other shapes cannot be changed; if the user asks for that, say they must select those shapes first.",
  "- Keep the whole text when you change text: the order replaces it.",
  "- The user reviews your orders and presses Apply. Add the block only when the user asks for a change, and say in one short sentence what it does.",
  "- Place new shapes in free space: next to the selection, or inside the visible area.",
];

// The model needs to know where it is and what is selected, but the user should
// not see that in the chat history. So it goes in a tagged block at the end of
// the message, and splitPrompt() removes it again when history is shown.
export function buildPrompt({ text, drawing, selection, view, occupied = null, project = null }) {
  const lines = ["You are the AI Drawer inside Drawbook, a drawing app built on Excalidraw.", `The user has the drawing ${JSON.stringify(drawing)} open.`, ...CHANGES_GUIDE];
  if (project) {
    lines.push(
      `The code project ${JSON.stringify(project)} is attached. Its git-tracked files are in your working directory: explore them with glob, grep and read (relative paths). Secret files such as .env are left out on purpose. You cannot change the project.`,
      "Answer questions about the code from the files, and name the files you used. When a picture helps, draw a diagram of the code with add orders.",
    );
  } else {
    lines.push("No code project is attached, so you cannot read any files.");
  }
  if (view) lines.push(`Visible area of the canvas: x ${view.x}..${view.x + view.width}, y ${view.y}..${view.y + view.height}.`);
  if (occupied) {
    const below = occupied.y + occupied.height + 120;
    lines.push(
      `Existing shapes cover x ${occupied.x}..${occupied.x + occupied.width}, y ${occupied.y}..${occupied.y + occupied.height}. Never place new shapes on top of them: start a new diagram at x ${occupied.x}, y ${below} (below the drawing), unless the user asks for another place or you are adding next to the selection.`,
    );
  }
  if (selection?.shapes?.length) {
    lines.push(`Selected shapes (${selection.shapes.length}), as JSON:`, JSON.stringify(selection.shapes));
    if (selection.image) lines.push(`The attached image "${SELECTION_IMAGE}" shows the selection.`);
  } else {
    lines.push("Nothing is selected on the canvas, so you can only add new shapes.");
  }
  return `${text}\n\n${CONTEXT_START}\n${lines.join("\n")}\n${CONTEXT_END}`;
}

// Returns the user's own text, plus the ids of the shapes that were selected:
// the browser allows changes only to those.
export function splitPrompt(fullText) {
  const start = fullText.lastIndexOf(`\n\n${CONTEXT_START}`);
  if (start < 0 || !fullText.trimEnd().endsWith(CONTEXT_END)) return { text: fullText, selectionCount: 0, selectionIds: [] };
  const context = fullText.slice(start).split("\n");
  const header = context.findIndex((line) => /^Selected shapes \(\d+\), as JSON:$/.test(line));
  let selectionIds = [];
  if (header >= 0) {
    try {
      selectionIds = JSON.parse(context[header + 1]).map((shape) => shape.id).filter((id) => typeof id === "string");
    } catch {
      // an old or damaged message: nothing can be changed from it
    }
  }
  return { text: fullText.slice(0, start), selectionCount: selectionIds.length, selectionIds };
}

// opencode messages -> the small shape the AI Drawer shows. Attachment data is
// never sent back to the browser, only names.
export function toChatMessages(raw) {
  const messages = [];
  for (const m of raw) {
    if (m.type === "user") {
      const { text, selectionCount, selectionIds } = splitPrompt(m.text ?? "");
      const files = (m.files ?? [])
        .filter((f) => f.name !== SELECTION_IMAGE)
        .map((f) => ({ name: f.name ?? "attachment", type: f.mime ?? f.mediaType ?? null }));
      messages.push({ id: m.id, role: "user", text, selectionCount, selectionIds, files, createdAt: m.time?.created ?? null });
    } else if (m.type === "assistant") {
      const text = (m.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n");
      const error = m.error?.message ?? null;
      if (text || error) messages.push({ id: m.id, role: "assistant", text, error, createdAt: m.time?.created ?? null });
    }
  }
  return messages;
}

const toChat = (session) => ({
  id: session.id,
  title: session.title,
  project: session.metadata?.project ?? null,
  updatedAt: session.time?.updated ?? session.time?.created ?? null,
});

function chatTitle(text) {
  const firstLine = text.trim().split("\n")[0];
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function validateDrawing(drawing) {
  if (typeof drawing !== "string" || drawing.length === 0 || drawing.length > 100) {
    throw new AiError(400, "A drawing name is required");
  }
}

function validateModel(model) {
  if (typeof model?.id !== "string" || typeof model?.providerID !== "string") {
    throw new AiError(400, "A model is required");
  }
  return { id: model.id, providerID: model.providerID };
}

const isNumber = (n) => typeof n === "number" && Number.isFinite(n);

const isArea = (area) => ["x", "y", "width", "height"].every((key) => isNumber(area?.[key]));

function validateMessage({ text, files = [], selection = null, view = null, occupied = null }) {
  if (typeof text !== "string" || text.trim().length === 0) throw new AiError(400, "The message is empty");
  if (text.length > MAX_TEXT_LENGTH) throw new AiError(400, "The message is too long");
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new AiError(400, `At most ${MAX_FILES} attachments`);
  for (const file of files) {
    if (typeof file?.dataUrl !== "string" || !file.dataUrl.startsWith("data:") || typeof file.name !== "string") {
      throw new AiError(400, "An attachment is not valid");
    }
  }
  if (selection !== null && !Array.isArray(selection?.shapes)) throw new AiError(400, "The selection is not valid");
  if (view !== null && !isArea(view)) throw new AiError(400, "The view is not valid");
  if (occupied !== null && !isArea(occupied)) throw new AiError(400, "The drawing area is not valid");
}

export function createAi({ request, workspace, projects }) {
  // Sessions in opencode are global: the list also contains the user's other
  // opencode work. Only sessions tagged as Drawbook's are ever touched.
  async function ownSession(id) {
    if (typeof id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(id)) throw new AiError(404, "Chat not found");
    const { data } = await request("GET", `/api/session/${id}`);
    if (data?.metadata?.app !== APP) throw new AiError(404, "Chat not found");
    return data;
  }

  async function sessionsOf(drawing) {
    const found = [];
    let cursor = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      // No directory filter: chats with a project run in that project's mirror.
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const res = await request("GET", `/api/session?${query}`);
      found.push(...res.data.filter((s) => s.metadata?.app === APP && s.metadata?.drawing === drawing));
      cursor = res.cursor?.next;
      if (!cursor || res.data.length === 0) break;
    }
    return found;
  }

  async function messages(id) {
    await ownSession(id);
    const res = await request("GET", `/api/session/${id}/message?order=asc&limit=${MAX_MESSAGES}`);
    return toChatMessages(res.data);
  }

  return {
    async models() {
      const [{ data: all }, { data: fallback }, { data: providers }] = await Promise.all([
        request("GET", "/api/model"),
        request("GET", "/api/model/default"),
        request("GET", "/api/provider"), // only providers that have credentials
      ]);
      const connected = new Set(providers.map((p) => p.id).filter((id) => SHOWN_PROVIDERS.has(id)));
      const models = all
        .filter((m) => connected.has(m.providerID) && m.enabled !== false && m.status !== "deprecated")
        .filter((m) => m.capabilities?.input?.includes("text") && m.capabilities?.output?.includes("text"))
        .map((m) => ({
          id: m.id,
          providerID: m.providerID,
          name: m.name ?? m.id,
          image: m.capabilities.input.includes("image"),
          // No price data means it runs on a subscription (e.g. a ChatGPT plan), which is not "free".
          pricing: !m.cost?.length ? "plan" : m.cost.every((c) => !c.input && !c.output) ? "free" : "paid",
        }))
        // Paid Zen models need a paid OpenCode account; show the free ones.
        .filter((m) => m.providerID !== ZEN || m.pricing === "free");
      // opencode's default may be a model that is not shown (e.g. a paid one).
      const shown = models.find((m) => m.id === fallback?.id && m.providerID === fallback?.providerID) ?? models.find((m) => m.providerID !== ZEN) ?? models[0];
      return { models, default: shown ? { id: shown.id, providerID: shown.providerID } : null };
    },

    async listChats(drawing) {
      validateDrawing(drawing);
      const sessions = await sessionsOf(drawing);
      return sessions.map(toChat).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },

    async createChat({ drawing, model }) {
      validateDrawing(drawing);
      const { data } = await request("POST", "/api/session", {
        title: NEW_CHAT_TITLE,
        metadata: { app: APP, drawing },
        permissions: DENY_ALL,
        model: validateModel(model),
      });
      return toChat(data);
    },

    messages,

    async send(id, message) {
      validateMessage(message);
      const session = await ownSession(id);
      const files = (message.files ?? []).map((f) => ({ uri: f.dataUrl, name: f.name }));
      if (message.selection?.image) files.push({ uri: message.selection.image, name: SELECTION_IMAGE });

      // The project may have changed since the last question: update the mirror first.
      const project = session.metadata.project ?? null;
      if (project) await projects.sync(project);
      const text = buildPrompt({ text: message.text, drawing: session.metadata.drawing, selection: message.selection, view: message.view ?? null, occupied: message.occupied ?? null, project });
      await request("POST", `/api/session/${id}/prompt`, { text, files });
      await request("POST", `/api/experimental/session/${id}/wait`);

      if (session.title === NEW_CHAT_TITLE) {
        await request("PATCH", `/api/session/${id}`, { title: chatTitle(message.text) });
      }
      return messages(id);
    },

    // Attaches a project folder (relative to the projects root) or, with null,
    // detaches it. The session moves into the mirror and may read there.
    async setProject(id, rel) {
      const session = await ownSession(id);
      const synced = rel ? await projects.sync(rel) : null;
      await request("POST", `/api/session/${id}/move`, { directory: synced ? synced.mirror : workspace });
      const metadata = { ...session.metadata, project: synced ? synced.rel : null };
      // opencode answers this PATCH without a body.
      await request("PATCH", `/api/session/${id}`, { metadata, permissions: synced ? READ_PROJECT : DENY_ALL });
      return toChat({ ...session, metadata });
    },

    async setModel(id, model) {
      await ownSession(id);
      await request("POST", `/api/session/${id}/model`, { model: validateModel(model) });
    },

    async removeChat(id) {
      await ownSession(id);
      await request("DELETE", `/api/session/${id}`);
    },

    // Chats belong to a drawing by name, so they move when the drawing is renamed.
    async renameDrawing(from, to) {
      for (const session of await sessionsOf(from)) {
        await request("PATCH", `/api/session/${session.id}`, { metadata: { ...session.metadata, drawing: to } });
      }
    },
  };
}
