import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStorage, EMPTY_LIBRARY } from "../server/storage.js";

const scene = (elements = []) => JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} });
const library = (libraryItems = []) => JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems });

let dir;
let storage;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "drawbook-test-"));
  storage = createStorage(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test("list creates the folder and returns an empty list", async () => {
  const nested = createStorage(path.join(dir, "new-folder"));
  assert.deepEqual(await nested.list(), []);
});

test("write then read returns the same content", async () => {
  await storage.write("My sketch", scene([{ id: "a" }]));
  assert.equal(await storage.read("My sketch"), scene([{ id: "a" }]));
  assert.ok(await fs.stat(path.join(dir, "My sketch.excalidraw")));
});

test("list returns newest first and ignores other files", async () => {
  await storage.write("old", scene());
  await fs.utimes(path.join(dir, "old.excalidraw"), new Date(1000), new Date(1000));
  await storage.write("new", scene());
  await fs.writeFile(path.join(dir, "notes.txt"), "x");
  await fs.writeFile(path.join(dir, ".hidden.excalidraw"), scene());
  assert.deepEqual((await storage.list()).map((d) => d.name), ["new", "old"]);
});

test("names that could escape the folder are rejected", async () => {
  for (const bad of ["../evil", "a/b", "..", ".hidden", "", "x".repeat(101), "a\\b", "a:b"]) {
    await assert.rejects(storage.write(bad, scene()), { status: 400 }, `name ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

test("content that is not an Excalidraw scene is rejected", async () => {
  await assert.rejects(storage.write("x", "not json"), { status: 400 });
  await assert.rejects(storage.write("x", JSON.stringify({ type: "other", elements: [] })), { status: 400 });
});

test("write leaves no temp files behind", async () => {
  await storage.write("a", scene());
  await storage.write("a", scene([{ id: "b" }]));
  assert.deepEqual(await fs.readdir(dir), ["a.excalidraw"]);
});

test("create refuses to overwrite", async () => {
  await storage.create("a", scene());
  await assert.rejects(storage.create("a", scene()), { status: 409 });
});

test("rename moves the file and refuses to overwrite", async () => {
  await storage.write("a", scene());
  await storage.write("b", scene());
  await assert.rejects(storage.rename("a", "b"), { status: 409 });
  await storage.rename("a", "c");
  assert.deepEqual((await storage.list()).map((d) => d.name).sort(), ["b", "c"]);
});

test("library is empty before the first save", async () => {
  assert.equal(await storage.readLibrary(), EMPTY_LIBRARY);
});

test("library write then read returns the same content, atomically", async () => {
  await storage.writeLibrary(library([{ id: "item1", elements: [] }]));
  assert.equal(await storage.readLibrary(), library([{ id: "item1", elements: [] }]));
  assert.deepEqual(await fs.readdir(dir), ["library.excalidrawlib"]);
});

test("library file does not appear in the drawings list", async () => {
  await storage.writeLibrary(library());
  await storage.write("a", scene());
  assert.deepEqual((await storage.list()).map((d) => d.name), ["a"]);
});

test("content that is not an Excalidraw library is rejected", async () => {
  await assert.rejects(storage.writeLibrary("nope"), { status: 400 });
  await assert.rejects(storage.writeLibrary(scene()), { status: 400 });
  assert.deepEqual(await fs.readdir(dir), []);
});

test("missing drawings give 404", async () => {
  await assert.rejects(storage.read("nope"), { status: 404 });
  await assert.rejects(storage.remove("nope"), { status: 404 });
  await assert.rejects(storage.rename("nope", "x"), { status: 404 });
});
