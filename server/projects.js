import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AiError } from "./opencode.js";

// Code projects the AI Drawer can read (#15). The AI never reads the project
// folder itself: Drawbook copies the git-tracked files into a private mirror,
// and the chat's opencode session may only read/grep/glob inside that mirror.
// Untracked files (.env, node_modules, local certs) are never copied.

const run = promisify(execFile);

// Folders that never hold code worth reading and can be huge.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", ".next", ".nuxt", ".venv", "venv", "__pycache__"]);
const MAX_SCAN_DEPTH = 6; // how deep to look for nested repos
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

// A second layer on top of "git-tracked only": files that look like secrets are
// skipped even when someone committed them (e.g. a .env.e2e with real values).
const SECRET_NAME = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.e2e …
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /credentials?\.json$/i,
  /service[-_]?account.*\.json$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt)$/i,
];
const SAFE_EXAMPLE = /\.(example|sample|template|dist)$/i; // .env.example only holds placeholders
const SECRET_DIRS = new Set(["certs", ".ssh", "secrets"]);

export function isSecretPath(relPath) {
  const parts = relPath.split("/");
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p.toLowerCase()))) return true;
  const name = parts.at(-1);
  return !SAFE_EXAMPLE.test(name) && SECRET_NAME.some((re) => re.test(name));
}

// A real repository has a .git directory; a worktree or copy has a .git file.
async function isRealRepo(dir) {
  const stat = await fs.lstat(path.join(dir, ".git")).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function subdirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)).map((e) => e.name);
}

// Real repos inside dir (not dir itself), up to maxDepth levels down.
async function nestedRepos(dir, maxDepth = MAX_SCAN_DEPTH, depth = 1) {
  if (depth > maxDepth) return [];
  const found = [];
  for (const name of await subdirs(dir)) {
    const child = path.join(dir, name);
    if (await isRealRepo(child)) found.push(child);
    found.push(...(await nestedRepos(child, maxDepth, depth + 1)));
  }
  return found;
}

// git ls-files run inside a folder lists the tracked files below it, relative
// to it. Outside a repository it fails: no files.
async function gitFiles(dir) {
  try {
    const { stdout } = await run("git", ["-C", dir, "ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

// Deletes everything in the mirror that is not wanted, then empty folders.
async function prune(mirror, dir, wanted) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(mirror, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      await prune(mirror, full, wanted);
      if ((await fs.readdir(full)).length === 0) await fs.rmdir(full);
    } else if (!wanted.has(rel)) {
      await fs.rm(full, { force: true });
    }
  }
}

export function createProjects({ root, mirrorsDir }) {
  // Turns "my-app/services/api" into an absolute folder inside root, refusing
  // "..", hidden segments and symlinks that lead outside root.
  async function resolve(rel = "") {
    if (typeof rel !== "string" || rel.length > 500) throw new AiError(400, "The folder is not valid");
    const parts = rel.split("/").filter(Boolean);
    if (parts.some((p) => p === ".." || p.startsWith(".") || p.includes("\\"))) throw new AiError(400, "The folder is not valid");
    const realRoot = await fs.realpath(root).catch(() => {
      throw new AiError(404, `The projects folder ${root} does not exist`);
    });
    const full = await fs.realpath(path.join(realRoot, ...parts)).catch(() => {
      throw new AiError(404, "Folder not found");
    });
    if (full !== realRoot && !full.startsWith(realRoot + path.sep)) throw new AiError(400, "The folder is not valid");
    if (!(await fs.stat(full)).isDirectory()) throw new AiError(404, "Folder not found");
    return { full, rel: parts.join("/") };
  }

  // Every git-tracked file below a folder, including the files of nested
  // repos (e.g. my-app/services/api can be a repo of its own).
  async function trackedFiles(full) {
    const files = new Set(await gitFiles(full));
    for (const repo of await nestedRepos(full)) {
      const prefix = path.relative(full, repo).split(path.sep).join("/");
      for (const file of await gitFiles(repo)) files.add(`${prefix}/${file}`);
    }
    return [...files].filter((f) => !f.split("/").includes(".git"));
  }

  const mirrorOf = (rel) => path.join(mirrorsDir, createHash("sha256").update(rel).digest("hex").slice(0, 16));

  return {
    mirrorOf,

    // Child folders worth showing: they hold tracked files or a real repo.
    // Copies and worktrees (.git file, nothing tracked) are left out.
    async list(rel = "") {
      const { full, rel: clean } = await resolve(rel);
      const trackedDirs = new Set((await gitFiles(full)).filter((f) => f.includes("/")).map((f) => f.split("/")[0]));
      const folders = [];
      for (const name of await subdirs(full)) {
        if (SECRET_DIRS.has(name.toLowerCase())) continue; // never copied, so nothing to read
        const child = path.join(full, name);
        if (trackedDirs.has(name) || (await isRealRepo(child)) || (await nestedRepos(child, 3)).length > 0) {
          folders.push({ name, path: clean ? `${clean}/${name}` : name });
        }
      }
      return { root: path.basename(root), path: clean, folders: folders.sort((a, b) => a.name.localeCompare(b.name)) };
    },

    // Makes the mirror equal to the tracked files: copies new and changed
    // files, and removes files that were deleted or are no longer tracked.
    async sync(rel) {
      const { full, rel: clean } = await resolve(rel);
      if (!clean) throw new AiError(400, "Choose a project folder");
      const mirror = mirrorOf(clean);
      const wanted = new Set();
      let skipped = 0;
      let total = 0;

      for (const file of (await trackedFiles(full)).sort()) {
        if (wanted.size >= MAX_FILES || isSecretPath(file)) {
          skipped++;
          continue;
        }
        const src = path.join(full, file);
        const stat = await fs.lstat(src).catch(() => null);
        // Only regular files: no symlinks (they could point anywhere), no
        // submodule folders, nothing deleted from the working tree.
        if (!stat?.isFile() || stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) {
          skipped++;
          continue;
        }
        total += stat.size;
        wanted.add(file);
        const dst = path.join(mirror, file);
        const old = await fs.stat(dst).catch(() => null);
        if (old && old.size === stat.size && Math.trunc(old.mtimeMs) === Math.trunc(stat.mtimeMs)) continue;
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
        await fs.utimes(dst, stat.atime, stat.mtime);
      }

      await prune(mirror, mirror, wanted);
      await fs.mkdir(mirror, { recursive: true });
      if (wanted.size === 0) throw new AiError(400, "This folder has no git-tracked files to read");
      return { rel: clean, mirror, files: wanted.size, skipped };
    },
  };
}
