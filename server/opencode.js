import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const READY_TIMEOUT_MS = 30_000;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs `opencode serve` as a child process that only Drawbook talks to.
//
// - A new random password on every start, so the browser and other programs
//   cannot use it; only this server knows it.
// - A free port on every start, so a leftover process can never block us.
// - Started lazily on the first AI request, and again if it exits.
// - Runs in its own empty workspace folder. Sessions also deny every tool (see
//   ai.js), so even a confused model cannot touch files or run commands.
export function createOpencode({ bin = "opencode", workspace }) {
  let child = null;
  let baseUrl = null;
  let auth = null;
  let starting = null;

  const pidFile = path.join(workspace, ".opencode.pid");

  // If Drawbook was killed hard, its opencode child may still be running.
  // macOS reuses process ids, so only stop it if it really is `opencode serve`.
  async function stopLeftover() {
    try {
      const pid = Number(await fs.readFile(pidFile, "utf8"));
      if (!(pid > 0)) return;
      const { stdout } = await execFileAsync("ps", ["-o", "args=", "-p", String(pid)]);
      if (stdout.includes("opencode") && stdout.includes(" serve ")) process.kill(pid, "SIGTERM");
    } catch {
      // no pid file, or the process is already gone
    }
  }

  async function start() {
    await fs.mkdir(workspace, { recursive: true });
    await stopLeftover();
    const port = await freePort();
    const password = randomBytes(24).toString("base64url");

    const proc = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: workspace,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr.on("data", (chunk) => process.stderr.write(`[opencode] ${chunk}`));

    const exited = new Promise((resolve) => proc.once("exit", resolve));
    const spawnError = new Promise((resolve) => proc.once("error", resolve));
    proc.once("exit", () => {
      if (child === proc) child = null;
    });
    await fs.writeFile(pidFile, String(proc.pid ?? ""));

    // opencode accepts connections a moment before it accepts the password,
    // so "ready" means an authenticated request succeeds.
    const url = `http://127.0.0.1:${port}`;
    const header = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const failed = await Promise.race([spawnError, exited.then(() => "exited"), sleep(250).then(() => null)]);
      if (failed) {
        const reason = failed === "exited" ? "it exited" : failed.code === "ENOENT" ? `"${bin}" was not found` : failed.message;
        throw new AiError(503, `Could not start opencode: ${reason}`);
      }
      try {
        const res = await fetch(`${url}/api/model/default`, { headers: { Authorization: header } });
        if (res.ok) {
          child = proc;
          baseUrl = url;
          auth = header;
          return;
        }
      } catch {
        // not listening yet
      }
    }
    proc.kill();
    throw new AiError(503, "opencode did not become ready in time");
  }

  async function ensureStarted() {
    if (child) return;
    starting ??= start().finally(() => {
      starting = null;
    });
    await starting;
  }

  async function request(method, urlPath, body) {
    await ensureStarted();
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new AiError(res.status === 404 ? 404 : 502, data?.message ?? `opencode answered ${res.status}`);
    }
    return data;
  }

  function stop() {
    child?.kill();
    child = null;
  }

  return { request, stop, isRunning: () => child !== null };
}
