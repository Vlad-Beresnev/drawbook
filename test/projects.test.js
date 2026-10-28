import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjects, isSecretPath } from "../server/projects.js";

const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

async function write(file, text = "x") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

// projects/
//   app/              real repo
//     src/a.js        tracked
//     .env.e2e        tracked by mistake (a secret)
//     .env.example    tracked placeholder
//     certs/dev.txt   tracked, inside a secret folder
//     link.js         tracked symlink to a file outside root
//     .env            untracked
//     services/svc/   nested real repo (app does not track it)
//   app-copy/         worktree-like copy: .git is a file
//   notes/            plain folder, no git
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "drawbook-projects-"));
  const root = path.join(base, "projects");
  const app = path.join(root, "app");
  await write(path.join(base, "outside.txt"), "OUTSIDE");
  await write(path.join(app, "src/a.js"), "export const a = 1;");
  await write(path.join(app, ".env.e2e"), "TOKEN=real");
  await write(path.join(app, ".env.example"), "TOKEN=");
  await write(path.join(app, "certs/dev.txt"), "cert");
  await fs.symlink(path.join(base, "outside.txt"), path.join(app, "link.js"));
  git(root, "init", "-q", app);
  git(app, "add", "-A");
  git(app, "commit", "-qm", "init");
  await write(path.join(app, ".env"), "TOKEN=untracked");
  await write(path.join(app, ".gitignore"), "services/\n.env\n");
  const svc = path.join(app, "services/svc");
  await write(path.join(svc, "svc.js"), "export const svc = 1;");
  git(root, "init", "-q", svc);
  git(svc, "add", "-A");
  git(svc, "commit", "-qm", "init");
  await write(path.join(root, "app-copy/.git"), "gitdir: /somewhere/else");
  await write(path.join(root, "app-copy/src/a.js"));
  await write(path.join(root, "notes/todo.md"));
  const projects = createProjects({ root, mirrorsDir: path.join(base, "mirrors") });
  return { base, root, app, svc, projects };
}

async function mirrorFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await mirrorFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

test("the picker shows real repos, hides copies and plain folders", async () => {
  const { projects } = await fixture();
  assert.deepEqual(await projects.list(""), { root: "projects", path: "", folders: [{ name: "app", path: "app" }] });
});

test("inside a repo the picker shows tracked folders and nested repos, not secret folders", async () => {
  const { projects } = await fixture();
  const { folders } = await projects.list("app");
  assert.deepEqual(folders.map((f) => f.path), ["app/services", "app/src"]);
});

test("the mirror holds only tracked, non-secret, regular files, nested repos included", async () => {
  const { projects } = await fixture();
  const { mirror, files } = await projects.sync("app");
  assert.deepEqual(await mirrorFiles(mirror), [".env.example", "services/svc/svc.js", "src/a.js"]);
  assert.equal(files, 3);
});

test("a nested folder can be attached on its own", async () => {
  const { projects } = await fixture();
  const { mirror } = await projects.sync("app/services/svc");
  assert.deepEqual(await mirrorFiles(mirror), ["svc.js"]);
});

test("sync follows the project: changed files update, deleted and untracked files disappear", async () => {
  const { app, projects } = await fixture();
  const { mirror } = await projects.sync("app");
  await write(path.join(app, "src/b.js"), "export const b = 2;");
  git(app, "add", "src/b.js");
  await fs.writeFile(path.join(app, "src/a.js"), "export const a = 'changed';");
  git(app, "rm", "-q", "--cached", ".env.example"); // stop tracking, file stays on disk
  await projects.sync("app");
  assert.deepEqual(await mirrorFiles(mirror), ["services/svc/svc.js", "src/a.js", "src/b.js"]);
  assert.equal(await fs.readFile(path.join(mirror, "src/a.js"), "utf8"), "export const a = 'changed';");
  git(app, "rm", "-qf", "src/b.js"); // deleted from the project
  await projects.sync("app");
  assert.deepEqual(await mirrorFiles(mirror), ["services/svc/svc.js", "src/a.js"]);
});

test("paths outside the projects folder are refused", async () => {
  const { base, root, projects } = await fixture();
  await fs.symlink(base, path.join(root, "escape"));
  for (const rel of ["../", "app/../..", ".git", "app/.git", "escape"]) {
    await assert.rejects(projects.list(rel), { status: 400 }, rel);
  }
  await assert.rejects(projects.sync(""), { status: 400 });
  await assert.rejects(projects.sync("notes"), { status: 400 }); // nothing tracked
});

test("secret-looking files are recognised, examples are not", () => {
  for (const p of [".env", ".env.local", "config/.env.e2e", "keys/server.pem", "id_rsa", ".npmrc", "gcp/service-account-prod.json", "certs/ca.txt", "secrets.yaml"]) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of [".env.example", "src/env.ts", "docs/keys.md", "src/secretary.js", "package.json"]) {
    assert.equal(isSecretPath(p), false, p);
  }
});
