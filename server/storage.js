import { promises as fs } from "node:fs";
import path from "node:path";

export const EXTENSION = ".excalidraw";
export const LIBRARY_FILE = "library.excalidrawlib";
export const EMPTY_LIBRARY = JSON.stringify({ type: "excalidrawlib", version: 2, source: "drawbook", libraryItems: [] });

// Letters, digits, spaces, dot, dash, underscore, brackets. No slashes, so a name
// can never point outside the drawings folder. A leading dot is rejected separately.
const NAME_PATTERN = /^[\p{L}\p{N} _.()-]{1,100}$/u;

export class StorageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createStorage(dir) {
  const root = path.resolve(dir);

  function fileFor(name) {
    if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.startsWith(".")) {
      throw new StorageError(400, `Invalid drawing name: ${JSON.stringify(name)}`);
    }
    const file = path.join(root, name + EXTENSION);
    if (path.dirname(file) !== root) {
      throw new StorageError(400, `Invalid drawing name: ${JSON.stringify(name)}`);
    }
    return file;
  }

  function parseJson(content, what) {
    try {
      return JSON.parse(content);
    } catch {
      throw new StorageError(400, `${what} is not valid JSON`);
    }
  }

  function validateScene(content) {
    const scene = parseJson(content, "Drawing");
    if (scene?.type !== "excalidraw" || !Array.isArray(scene.elements)) {
      throw new StorageError(400, "Drawing is not an Excalidraw scene");
    }
  }

  function validateLibrary(content) {
    const library = parseJson(content, "Library");
    if (library?.type !== "excalidrawlib" || !Array.isArray(library.libraryItems)) {
      throw new StorageError(400, "Library is not an Excalidraw library");
    }
  }

  // Write to a temp file first, then rename. Rename is atomic on the same disk,
  // so a crash in the middle never leaves a half-written file.
  async function writeAtomic(file, content) {
    await fs.mkdir(root, { recursive: true });
    const tmp = path.join(root, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, content, "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  async function exists(file) {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  return {
    dir: root,

    async list() {
      await fs.mkdir(root, { recursive: true });
      const entries = await fs.readdir(root, { withFileTypes: true });
      const drawings = await Promise.all(
        entries
          .filter((e) => e.isFile() && e.name.endsWith(EXTENSION) && !e.name.startsWith("."))
          .map(async (e) => {
            const stat = await fs.stat(path.join(root, e.name));
            return {
              name: e.name.slice(0, -EXTENSION.length),
              modified: stat.mtimeMs,
              size: stat.size,
            };
          }),
      );
      return drawings.sort((a, b) => b.modified - a.modified);
    },

    async read(name) {
      try {
        return await fs.readFile(fileFor(name), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") throw new StorageError(404, `Drawing not found: ${name}`);
        throw err;
      }
    },

    async write(name, content) {
      const file = fileFor(name);
      validateScene(content);
      await writeAtomic(file, content);
    },

    async create(name, content) {
      if (await exists(fileFor(name))) {
        throw new StorageError(409, `Drawing already exists: ${name}`);
      }
      await this.write(name, content);
    },

    async rename(from, to) {
      const source = fileFor(from);
      const target = fileFor(to);
      if (!(await exists(source))) throw new StorageError(404, `Drawing not found: ${from}`);
      if (await exists(target)) throw new StorageError(409, `Drawing already exists: ${to}`);
      await fs.rename(source, target);
    },

    async remove(name) {
      try {
        await fs.unlink(fileFor(name));
      } catch (err) {
        if (err.code === "ENOENT") throw new StorageError(404, `Drawing not found: ${name}`);
        throw err;
      }
    },

    // The shape library lives next to the drawings. Its extension is not
    // `.excalidraw`, so it never shows up in list().
    async readLibrary() {
      try {
        return await fs.readFile(path.join(root, LIBRARY_FILE), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return EMPTY_LIBRARY;
        throw err;
      }
    },

    async writeLibrary(content) {
      validateLibrary(content);
      await writeAtomic(path.join(root, LIBRARY_FILE), content);
    },
  };
}
