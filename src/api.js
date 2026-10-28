const BASE = "/api/drawings";

async function request(path, options = {}, base = BASE) {
  const res = await fetch(base + path, options);
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error);
  }
  return res;
}

const url = (name) => "/" + encodeURIComponent(name);
const json = (body) => ({ headers: { "Content-Type": "application/json" }, body });

export const api = {
  list: async () => (await request("")).json(),
  read: async (name) => (await request(url(name))).json(),
  save: (name, content) => request(url(name), { method: "PUT", ...json(content) }),
  create: (name, content) => request(url(name), { method: "POST", ...json(content) }),
  rename: (from, to) => request(url(from) + "/rename", { method: "POST", ...json(JSON.stringify({ to })) }),
  remove: (name) => request(url(name), { method: "DELETE" }),
  // Returned as text, so callers can tell if the file changed by comparing strings.
  readLibrary: async () => (await request("", {}, "/api/library")).text(),
  saveLibrary: (content) => request("", { method: "PUT", ...json(content) }, "/api/library"),
};

const AI = "/api/ai";
const send = (body) => json(JSON.stringify(body));

export const aiApi = {
  models: async () => (await request("/models", {}, AI)).json(),
  chats: async (drawing) => (await request(`/chats?drawing=${encodeURIComponent(drawing)}`, {}, AI)).json(),
  createChat: async (drawing, model) => (await request("/chats", { method: "POST", ...send({ drawing, model }) }, AI)).json(),
  messages: async (chatId) => (await request(`/chats/${chatId}/messages`, {}, AI)).json(),
  send: async (chatId, message) => (await request(`/chats/${chatId}/messages`, { method: "POST", ...send(message) }, AI)).json(),
  setModel: (chatId, model) => request(`/chats/${chatId}/model`, { method: "PUT", ...send({ model }) }, AI),
  removeChat: (chatId) => request(`/chats/${chatId}`, { method: "DELETE" }, AI),
  // Code projects (#15): folders to pick from, and attach (path) / detach (null).
  projects: async (path = "") => (await request(`/projects?path=${encodeURIComponent(path)}`, {}, AI)).json(),
  setProject: async (chatId, path) => (await request(`/chats/${chatId}/project`, { method: "PUT", ...send({ path }) }, AI)).json(),
};
