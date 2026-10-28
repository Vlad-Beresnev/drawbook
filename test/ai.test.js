import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, createAi, DENY_ALL, READ_PROJECT, SELECTION_IMAGE, splitPrompt, toChatMessages } from "../server/ai.js";

// A fake opencode: records every call and answers from a routing function.
function fakeOpencode(routes) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const answer = routes(method, path, body);
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  };
  return { request, calls };
}

const drawbookSession = (id, drawing, title = "New chat") => ({ id, title, metadata: { app: "drawbook", drawing }, time: { created: 1, updated: 2 } });
const otherSession = { id: "ses_private", title: "My work session", metadata: null, time: { created: 1, updated: 3 } };

test("the hidden context is removed again when history is shown", () => {
  const text = buildPrompt({
    text: "What does this show?",
    drawing: "Arch",
    selection: { shapes: [{ id: "a" }, { id: "b" }], image: "data:image/png;base64,xx" },
  });
  assert.match(text, /<drawbook-context>/);
  assert.match(text, /Selected shapes \(2\)/);
  assert.deepEqual(splitPrompt(text), { text: "What does this show?", selectionCount: 2, selectionIds: ["a", "b"] });
});

test("a user message that only mentions the tag is left alone", () => {
  const text = "Explain <drawbook-context> please";
  assert.deepEqual(splitPrompt(text), { text, selectionCount: 0, selectionIds: [] });
});

test("history keeps only text, file names and errors", () => {
  const messages = toChatMessages([
    { id: "u1", type: "user", text: buildPrompt({ text: "Hi", drawing: "A", selection: null }), files: [{ data: "AAAA", name: "notes.md" }, { data: "BBBB", name: SELECTION_IMAGE }], time: { created: 5 } },
    { id: "a1", type: "assistant", content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "Hello" }], time: { created: 6 } },
    { id: "a2", type: "assistant", content: [], error: { message: "Free usage limit reached" }, time: { created: 7 } },
    { id: "i1", type: "idle", outcome: "succeeded" },
  ]);
  assert.deepEqual(messages, [
    { id: "u1", role: "user", text: "Hi", selectionCount: 0, selectionIds: [], files: [{ name: "notes.md", type: null }], createdAt: 5 },
    { id: "a1", role: "assistant", text: "Hello", error: null, createdAt: 6 },
    { id: "a2", role: "assistant", text: "", error: "Free usage limit reached", createdAt: 7 },
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /AAAA|BBBB/);
});

test("new chats deny every tool and are tagged with the drawing", async () => {
  const oc = fakeOpencode((method, path) => (method === "POST" && path === "/api/session" ? { data: drawbookSession("ses_1", "Arch") } : null));
  const ai = createAi({ request: oc.request, workspace: "/ws" });
  await ai.createChat({ drawing: "Arch", model: { id: "m", providerID: "openai", extra: "dropped" } });
  assert.deepEqual(oc.calls[0].body.permissions, DENY_ALL);
  assert.deepEqual(oc.calls[0].body.metadata, { app: "drawbook", drawing: "Arch" });
  assert.deepEqual(oc.calls[0].body.model, { id: "m", providerID: "openai" });
});

test("chat list shows only this drawing's Drawbook chats, newest first", async () => {
  const pages = {
    first: { data: [drawbookSession("ses_1", "Arch"), otherSession, drawbookSession("ses_2", "Other")], cursor: { next: "p2" } },
    p2: { data: [{ ...drawbookSession("ses_3", "Arch"), time: { updated: 9 } }], cursor: {} },
  };
  const oc = fakeOpencode((method, path) => pages[new URL(path, "http://x").searchParams.get("cursor") ?? "first"]);
  const ai = createAi({ request: oc.request, workspace: "/ws" });
  assert.deepEqual((await ai.listChats("Arch")).map((c) => c.id), ["ses_3", "ses_1"]);
  // No directory filter: chats with a project run in the project's mirror (#15).
  assert.equal(new URL(oc.calls[0].path, "http://x").searchParams.has("directory"), false);
});

test("sessions that are not Drawbook's can never be read or deleted", async () => {
  const oc = fakeOpencode((method, path) => (path === "/api/session/ses_private" ? { data: otherSession } : null));
  const ai = createAi({ request: oc.request, workspace: "/ws" });
  await assert.rejects(ai.messages("ses_private"), { status: 404 });
  await assert.rejects(ai.removeChat("ses_private"), { status: 404 });
  await assert.rejects(ai.messages("../config"), { status: 404 });
  assert.ok(oc.calls.every((c) => c.method === "GET"), "nothing but the ownership check was called");
});

test("send attaches files and the selection image, waits, and names a new chat", async () => {
  const oc = fakeOpencode((method, path) => {
    if (method === "GET" && path === "/api/session/ses_1") return { data: drawbookSession("ses_1", "Arch") };
    if (method === "GET" && path.startsWith("/api/session/ses_1/message")) return { data: [] };
    return null;
  });
  const ai = createAi({ request: oc.request, workspace: "/ws" });
  await ai.send("ses_1", {
    text: "Explain this flow\nsecond line",
    files: [{ name: "spec.pdf", dataUrl: "data:application/pdf;base64,AA" }],
    selection: { shapes: [{ id: "x" }], image: "data:image/png;base64,BB" },
  });
  const prompt = oc.calls.find((c) => c.path === "/api/session/ses_1/prompt");
  assert.deepEqual(prompt.body.files.map((f) => f.name), ["spec.pdf", SELECTION_IMAGE]);
  assert.match(prompt.body.text, /The user has the drawing "Arch" open/);
  assert.ok(oc.calls.some((c) => c.path === "/api/experimental/session/ses_1/wait"));
  assert.deepEqual(oc.calls.find((c) => c.method === "PATCH").body, { title: "Explain this flow" });
});

test("invalid messages are rejected before anything is sent", async () => {
  const oc = fakeOpencode(() => ({ data: drawbookSession("ses_1", "Arch") }));
  const ai = createAi({ request: oc.request, workspace: "/ws" });
  await assert.rejects(ai.send("ses_1", { text: "   " }), { status: 400 });
  await assert.rejects(ai.send("ses_1", { text: "hi", files: [{ name: "x", dataUrl: "https://evil" }] }), { status: 400 });
  assert.equal(oc.calls.length, 0);
});

test("renaming a drawing moves its chats", async () => {
  const oc = fakeOpencode((method) => (method === "GET" ? { data: [drawbookSession("ses_1", "Old"), drawbookSession("ses_2", "Keep")], cursor: {} } : null));
  const ai = createAi({ request: oc.request, workspace: "/ws" });
  await ai.renameDrawing("Old", "New");
  const patches = oc.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches, [{ method: "PATCH", path: "/api/session/ses_1", body: { metadata: { app: "drawbook", drawing: "New" } } }]);
});

// A fake projects module: records syncs, answers with a mirror path.
function fakeProjects() {
  const synced = [];
  return {
    synced,
    sync: async (rel) => {
      synced.push(rel);
      return { rel, mirror: `/ws/projects/${rel.replaceAll("/", "_")}`, files: 3, skipped: 0 };
    },
  };
}

test("attaching a project moves the chat into the mirror and allows only read tools", async () => {
  const oc = fakeOpencode((method) => {
    if (method === "GET") return { data: drawbookSession("ses_1", "Arch") };
    return null; // like opencode: move and PATCH answer without a body
  });
  const projects = fakeProjects();
  const ai = createAi({ request: oc.request, workspace: "/ws", projects });
  const chat = await ai.setProject("ses_1", "my-app/services/api");
  assert.deepEqual(projects.synced, ["my-app/services/api"]);
  assert.deepEqual(oc.calls[1], { method: "POST", path: "/api/session/ses_1/move", body: { directory: "/ws/projects/my-app_services_api" } });
  assert.deepEqual(oc.calls[2].body.permissions, READ_PROJECT);
  assert.deepEqual(oc.calls[2].body.metadata, { app: "drawbook", drawing: "Arch", project: "my-app/services/api" });
  assert.equal(chat.project, "my-app/services/api");
  // read, grep and glob are allowed; everything else stays denied
  assert.deepEqual(READ_PROJECT[0], DENY_ALL[0]);
  assert.deepEqual(READ_PROJECT.slice(1).map((r) => [r.action, r.effect]), [["read", "allow"], ["grep", "allow"], ["glob", "allow"]]);
});

test("detaching a project moves the chat back and denies every tool again", async () => {
  const session = { ...drawbookSession("ses_1", "Arch"), metadata: { app: "drawbook", drawing: "Arch", project: "app" } };
  const oc = fakeOpencode((method) => (method === "GET" ? { data: session } : null));
  const projects = fakeProjects();
  const ai = createAi({ request: oc.request, workspace: "/ws", projects });
  const chat = await ai.setProject("ses_1", null);
  assert.deepEqual(projects.synced, []);
  assert.deepEqual(oc.calls[1].body, { directory: "/ws" });
  assert.deepEqual(oc.calls[2].body.permissions, DENY_ALL);
  assert.equal(chat.project, null);
});

test("a chat with a project syncs the mirror before every question and tells the model", async () => {
  const session = { ...drawbookSession("ses_1", "Arch", "Old title"), metadata: { app: "drawbook", drawing: "Arch", project: "app" } };
  const oc = fakeOpencode((method, path) => {
    if (method === "GET" && path === "/api/session/ses_1") return { data: session };
    if (method === "GET") return { data: [] };
    return null;
  });
  const projects = fakeProjects();
  const ai = createAi({ request: oc.request, workspace: "/ws", projects });
  await ai.send("ses_1", { text: "How does upload work?" });
  assert.deepEqual(projects.synced, ["app"]);
  const prompt = oc.calls.find((c) => c.path.endsWith("/prompt"));
  assert.match(prompt.body.text, /The code project "app" is attached/);
});

test("without a project the model is told it cannot read files", () => {
  assert.match(buildPrompt({ text: "Hi", drawing: "A", selection: null }), /No code project is attached/);
});

test("the model is told where the drawing is, so new diagrams go below it", () => {
  const text = buildPrompt({ text: "Draw it", drawing: "A", selection: null, occupied: { x: 100, y: 50, width: 400, height: 300 } });
  assert.match(text, /Existing shapes cover x 100\.\.500, y 50\.\.350/);
  assert.match(text, /start a new diagram at x 100, y 470/);
  assert.doesNotMatch(buildPrompt({ text: "Hi", drawing: "A", selection: null }), /Existing shapes/);
});

const model = (providerID, id, cost) => ({ id, providerID, name: id, enabled: true, status: "active", capabilities: { input: ["text"], output: ["text"] }, cost });
const FREE = [{ input: 0, output: 0 }];
const PAID = [{ input: 1, output: 2 }];

test("the model list shows free Zen models and connected OpenAI only", async () => {
  const all = [model("opencode", "zen-free", FREE), model("opencode", "zen-paid", PAID), model("openai", "gpt", []), model("vercel", "v", FREE)];
  const routes = (connected) => (method, path) =>
    path === "/api/model" ? { data: all } : path === "/api/model/default" ? { data: { id: "zen-paid", providerID: "opencode" } } : { data: connected.map((id) => ({ id })) };

  const withOpenai = await createAi({ request: fakeOpencode(routes(["opencode", "openai", "vercel"])).request, workspace: "/ws" }).models();
  assert.deepEqual(withOpenai.models.map((m) => m.id), ["zen-free", "gpt"]);
  // the default (a paid Zen model) is not shown, so a connected provider's model is used
  assert.deepEqual(withOpenai.default, { id: "gpt", providerID: "openai" });

  const zenOnly = await createAi({ request: fakeOpencode(routes(["opencode"])).request, workspace: "/ws" }).models();
  assert.deepEqual(zenOnly.models.map((m) => m.id), ["zen-free"]);
  assert.deepEqual(zenOnly.default, { id: "zen-free", providerID: "opencode" });
});
