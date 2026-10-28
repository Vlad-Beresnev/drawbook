import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStorage, StorageError } from "./storage.js";
import { AiError, createOpencode } from "./opencode.js";
import { createAi } from "./ai.js";
import { createProjects } from "./projects.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.DRAWBOOK_PORT ?? 4747);
const DRAWINGS_DIR = process.env.DRAWBOOK_DIR ?? path.join(os.homedir(), "Drawings");
const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
const MAX_BODY_BYTES = 50 * 1024 * 1024; // drawings with embedded images can be big

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
// The Vite dev server proxies /api here and keeps its own origin.
ALLOWED_ORIGINS.add("http://localhost:5173").add("http://127.0.0.1:5173");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

// Where app data lives on each system (the AI workspace and project copies).
function appDataDir() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Drawbook");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Drawbook");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "drawbook");
}

const AI_WORKSPACE = process.env.DRAWBOOK_AI_WORKSPACE ?? path.join(appDataDir(), "ai-workspace");

const storage = createStorage(DRAWINGS_DIR);
const opencode = createOpencode({ bin: process.env.OPENCODE_BIN ?? "opencode", workspace: AI_WORKSPACE });
// The usual places people keep code; the first one that exists, else home.
function defaultProjectsDir() {
  const home = os.homedir();
  const names = ["Projects", "projects", "Developer", "Code", "code", "dev", "src", "repos", "business"];
  return names.map((name) => path.join(home, name)).find((dir) => existsSync(dir)) ?? home;
}

// Code projects the AI Drawer can read (#15); copies of their git-tracked files live in the workspace.
const projects = createProjects({
  root: process.env.DRAWBOOK_PROJECTS_DIR ?? defaultProjectsDir(),
  mirrorsDir: path.join(AI_WORKSPACE, "projects"),
});
const ai = createAi({ request: opencode.request, workspace: AI_WORKSPACE, projects });

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new StorageError(413, "Drawing is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The server listens only on 127.0.0.1, but any website open in the browser can
// still send requests to it. The Host check blocks DNS rebinding; the Origin check
// blocks other sites from changing or deleting drawings.
function isTrusted(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return origin === undefined || ALLOWED_ORIGINS.has(origin);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").slice(3).filter(Boolean).map(decodeURIComponent); // after /api/drawings
  const [name, action] = parts;

  if (req.method === "GET" && parts.length === 0) {
    return send(res, 200, await storage.list());
  }
  if (req.method === "GET" && parts.length === 1) {
    return send(res, 200, await storage.read(name));
  }
  if (req.method === "PUT" && parts.length === 1) {
    await storage.write(name, await readBody(req));
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && parts.length === 1) {
    await storage.create(name, await readBody(req));
    return send(res, 201, { ok: true });
  }
  if (req.method === "POST" && parts.length === 2 && action === "rename") {
    const { to } = JSON.parse(await readBody(req));
    await storage.rename(name, to);
    // The drawing is renamed even if its chats cannot be moved (e.g. opencode is missing).
    await ai.renameDrawing(name, to).catch((err) => console.error(`Could not move chats of "${name}":`, err.message));
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && parts.length === 1) {
    await storage.remove(name);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Unknown API route" });
}

async function handleLibrary(req, res) {
  if (req.method === "GET") {
    return send(res, 200, await storage.readLibrary());
  }
  if (req.method === "PUT") {
    await storage.writeLibrary(await readBody(req));
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: "Method not allowed" });
}

async function handleAi(req, res, url) {
  const [chatId, sub] = url.pathname.split("/").slice(4).filter(Boolean); // after /api/ai/chats
  const resource = url.pathname.split("/")[3];
  const body = async () => JSON.parse(await readBody(req));

  if (resource === "models" && req.method === "GET") {
    return send(res, 200, await ai.models());
  }
  if (resource === "projects" && req.method === "GET") {
    return send(res, 200, await projects.list(url.searchParams.get("path") ?? ""));
  }
  if (resource !== "chats") return send(res, 404, { error: "Unknown AI route" });

  if (!chatId && req.method === "GET") {
    return send(res, 200, await ai.listChats(url.searchParams.get("drawing")));
  }
  if (!chatId && req.method === "POST") {
    return send(res, 201, await ai.createChat(await body()));
  }
  if (chatId && !sub && req.method === "DELETE") {
    await ai.removeChat(chatId);
    return send(res, 200, { ok: true });
  }
  if (sub === "messages" && req.method === "GET") {
    return send(res, 200, await ai.messages(chatId));
  }
  if (sub === "messages" && req.method === "POST") {
    return send(res, 200, await ai.send(chatId, await body()));
  }
  if (sub === "project" && req.method === "PUT") {
    return send(res, 200, await ai.setProject(chatId, (await body()).path ?? null));
  }
  if (sub === "model" && req.method === "PUT") {
    await ai.setModel(chatId, (await body()).model);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Unknown AI route" });
}

async function serveStatic(res, url) {
  const requested = path.normalize(path.join(DIST_DIR, decodeURIComponent(url.pathname)));
  // Paths without an extension are app routes, so they get index.html.
  const file = requested.startsWith(DIST_DIR) && path.extname(requested) ? requested : path.join(DIST_DIR, "index.html");
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    send(res, 404, "Not found. Did you run `npm run build`?", "text/plain; charset=utf-8");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isTrusted(req)) return send(res, 403, { error: "Forbidden" });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/drawings" || url.pathname.startsWith("/api/drawings/")) {
      return await handleApi(req, res, url);
    }
    if (url.pathname === "/api/library") {
      return await handleLibrary(req, res);
    }
    if (url.pathname.startsWith("/api/ai/")) {
      return await handleAi(req, res, url);
    }
    if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
    return await serveStatic(res, url);
  } catch (err) {
    const isBadInput = err instanceof SyntaxError || err instanceof URIError;
    const status = err instanceof StorageError || err instanceof AiError ? err.status : isBadInput ? 400 : 500;
    if (status === 500) console.error(err);
    send(res, status, { error: err.message });
  }
});

// Stop the opencode child together with the server (launchd sends SIGTERM).
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    opencode.stop();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Drawbook running at http://${HOST}:${PORT} — drawings in ${storage.dir}`);
});
