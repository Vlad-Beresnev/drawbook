# Drawbook

A local [Excalidraw](https://github.com/excalidraw/excalidraw) app for macOS. Drawings are saved as normal
`.excalidraw` files in `~/Drawings`, and you browse them from the sidebar inside the app.
Local AI (Ollama / `opencode serve`) comes in Phase 2.

## How it works

```
Chrome app window  ──HTTP──▶  Node server on 127.0.0.1:4747  ──▶  ~/Drawings/*.excalidraw
(React + Excalidraw)          (server/index.js, started by launchd)
```

- The browser cannot read a folder on your Mac, so a small local server does it.
- The server listens only on `127.0.0.1` and rejects requests from other websites (Host + Origin checks).
- Saves are atomic: write a temp file, then rename. A crash never leaves a half-written drawing.
- Autosave runs 0.5 s after you stop drawing, when the window is hidden, and on `Cmd+S`.
- Undo/redo: `Cmd+Z` / `Cmd+Shift+Z` (Excalidraw built-in, lives in memory until you reload).
- Fonts are served locally, so the app works offline.

## Install (one time)

```bash
npm install
npm run install-app      # builds, then installs a LaunchAgent that starts the server at login
```

Then open <http://127.0.0.1:4747> in Chrome → `⋮` → **Cast, save and share → Install page as app**.
After that, type **Drawbook** in Spotlight.

## Use

| Action | How |
|---|---|
| New drawing | `+ New` in the sidebar |
| Open | click a drawing in the sidebar |
| Rename | double-click a drawing |
| Delete | hover a drawing → `×` |

## AI Drawer

Click **✦ AI Drawer** next to **Library**. It is a chat about the open drawing:

- **Selection:** selected shapes are sent as short JSON plus a PNG (toggle the `◇ N selected shapes` chip).
- **Attachments:** `+`, drag-and-drop or paste (images, PDF, text; up to 10 files, 10 MB each).
- **History:** each drawing has its own chats (🕘 list, ✎ new chat). Renaming a drawing moves its chats.
- **Models:** any OpenAI model on your ChatGPT plan, or opencode's free models (they have a usage limit).

- **Changes:** ask for a change ("mark all items done", "rename this box to Auth", "add Client → API → DB").
  The changes are applied **at once**, and the answer lists what changed. `Cmd+Z` undoes the whole answer in one step.

### Attach a code project

Click **📁** in the AI Drawer, open a folder of your projects folder (any depth, e.g.
`my-app/services/api`) and press **Attach**. The chat shows a 📁 chip; `×` removes it.
The AI can then read the code, answer questions about it and draw diagrams that explain it.

- The attachment belongs to the **chat**. Each chat of a drawing can have its own project.
- The AI reads **only git-tracked files**, nested repos included. Secret-looking files (`.env*`, `*.pem`,
  `*.key`, `certs/`, …) are left out even when they are committed. `.env.example` stays.
- Drawbook copies those files into `~/Library/Application Support/Drawbook/ai-workspace/projects/` and
  updates the copy before every question (changed files update, deleted or untracked files disappear).
  The chat may only `read`, `grep` and `glob` inside that copy. No shell, no editing, nothing outside it.
- Copies and worktrees (`*-worktrees`, folders whose `.git` is a file) are hidden from the picker.
- Removing the project stops new reading; what the AI already read stays in that chat's history.
- Everything the AI reads is sent to the chosen model provider (e.g. OpenAI).

### Canvas changes: the rules

The AI never writes Excalidraw elements. It writes short orders (`src/ai/changes.js`):

| Order | Allowed on |
|---|---|
| `setText {id, text}` | a **selected** text, or the label of a **selected** box |
| `setColor {id, stroke?, background?}` | a **selected** shape |
| `delete {id}` | a **selected** shape (its label goes with it) |
| `add {shape}` | new rectangle / ellipse / diamond / text / arrow (no selection needed) |

- Only the shapes that were selected **when you asked** can be changed or deleted.
- All or nothing: if one order is wrong (unknown id, not selected, bad colour), nothing changes and the card says why.
- In this version an arrow can connect only shapes added in the same answer.

How it works: the Drawbook server starts `opencode serve` itself (random password and port, empty
workspace in `~/Library/Application Support/Drawbook/ai-workspace`). Every chat is an opencode session
with **all tools denied**: the AI cannot run commands or edit files. It can only answer, and propose
canvas changes that your browser checks before you apply them. Your other opencode sessions are never
shown or touched.

Requires `opencode` to be installed and logged in.

## Update after code changes

```bash
npm run install-app      # rebuilds and restarts the server
```

## Develop

```bash
npm run dev              # server on :4747 + Vite on http://localhost:5173 with hot reload
npm test                 # storage, AI and canvas-change tests
```

If the LaunchAgent is installed, port 4747 is already taken: the dev server prints `EADDRINUSE`
and Vite simply uses the installed server's API. Server code changes then need `npm run install-app`.

## Settings

| Env var | Default |
|---|---|
| `DRAWBOOK_PORT` | `4747` |
| `DRAWBOOK_DIR` | `~/Drawings` |
| `DRAWBOOK_PROJECTS_DIR` | the first that exists of `~/Projects`, `~/Developer`, `~/Code`, `~/dev`, `~/src`, `~/repos`, `~/business`, else your home folder |

## Uninstall

```bash
npm run uninstall-app    # stops the server; your drawings stay in ~/Drawings
```

Logs: `~/Library/Logs/drawbook.log`
