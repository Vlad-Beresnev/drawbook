# Drawbook

A local [Excalidraw](https://github.com/excalidraw/excalidraw) app. Your drawings are normal `.excalidraw`
files in a `Drawings` folder on your computer, and you browse them from a sidebar inside the app.
The **AI Drawer** is a chat next to the canvas: it explains and changes your drawing, and it can read a
code project and draw diagrams of it.

## Install (one command)

You do not need Node.js, npm or Git. The installer brings everything it needs.

**macOS and Linux** — open the Terminal and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/Vlad-Beresnev/drawbook/main/install.sh | sh
```

**Windows 10/11** — open PowerShell and paste:

```powershell
irm https://raw.githubusercontent.com/Vlad-Beresnev/drawbook/main/install.ps1 | iex
```

The installer:

1. downloads a private copy of Node.js (your own Node.js, if you have one, is not changed),
2. downloads the latest Drawbook release,
3. installs [opencode](https://opencode.ai) 2 for the AI Drawer (or uses your opencode 2 if you have it),
4. starts Drawbook in the background, now and every time you log in,
5. opens <http://127.0.0.1:4747> in your browser.

**Make it a real app:** in Chrome, open <http://127.0.0.1:4747> → `⋮` → **Cast, save and share → Install page
as app** (in Edge: `…` → **Apps → Install this site as an app**). Now Drawbook has its own window and icon,
and on a Mac you can open it from Spotlight: type **Drawbook**.

**Update:** run the same command again. Your drawings are never touched.

**Uninstall:** your drawings stay in your `Drawings` folder.

```sh
curl -fsSL https://raw.githubusercontent.com/Vlad-Beresnev/drawbook/main/install.sh | sh -s -- --uninstall
```

```powershell
$env:DRAWBOOK_UNINSTALL = "1"; irm https://raw.githubusercontent.com/Vlad-Beresnev/drawbook/main/install.ps1 | iex
```

| System | Status |
|---|---|
| macOS (Apple Silicon and Intel) | tested |
| Linux (x64, arm64) | tested on Ubuntu; start at login uses a systemd user service |
| Windows 10/11 | new: not yet tested on a real Windows PC. Please [report problems](https://github.com/Vlad-Beresnev/drawbook/issues). |

## Use

| Action | How |
|---|---|
| New drawing | `+ New` in the sidebar |
| Open | click a drawing in the sidebar |
| Rename | double-click a drawing |
| Delete | hover a drawing → `×` |
| Hide / show the sidebar | `⌘\` (`Ctrl+\` on Windows and Linux) |
| Undo / redo | `⌘Z` / `⌘⇧Z` |
| Save now | `⌘S` (it also saves by itself, 0.5 s after you stop drawing) |

Libraries: open **Library** (top right) → **Browse libraries**, and add any library. It is saved in
`Drawings/library.excalidrawlib`.

## AI Drawer

Click **✦ AI Drawer** (bottom right, next to `?`). It is a chat about the open drawing.

- **Models.** Connect your **ChatGPT plan** once (the installer prints the exact command):

  ```sh
  ~/.drawbook/opencode/opencode auth login openai
  ```

  The model list shows the free **OpenCode Zen** models, and OpenAI models when OpenAI is connected.
  **Known problem:** right now the free Zen models answer "Free usage limit reached" when Drawbook uses
  them, even on a new computer ([#4](https://github.com/Vlad-Beresnev/drawbook/issues/4)). Use OpenAI until
  this is solved.
- **Selection.** Select shapes before you ask: the AI gets them as text and as a picture.
- **Attachments.** `+`, drag and drop, or paste: images, PDF, text (up to 10 files, 10 MB each).
- **History.** Each drawing has its own chats: 🕘 lists them, ✎ starts a new one.
- **Changes.** Ask for a change ("mark all items done", "rename this box to Auth", "draw Client → API → DB").
  It is applied at once; `⌘Z` undoes the whole answer in one step.

### Attach a code project

Click **📁** in the chat box, open a folder in your projects folder (any depth, e.g. `my-app/services/api`)
and press **Attach**. Now you can ask about the code, and ask the AI to draw it.

- The project belongs to the **chat**: each chat can have its own project. `×` on the 📁 chip removes it.
- The AI reads **only files that git tracks**. Secret-looking files (`.env`, `*.pem`, `*.key`, `certs/`, …) are
  left out even if they were committed. Drawbook copies the allowed files into its own folder and updates
  the copy before every question, so deleted or untracked files disappear from the AI's view.
- The AI can only read and search that copy: it cannot run commands, change files, or read anything else.
- **Everything the AI reads is sent to the model provider** (OpenCode Zen or OpenAI). Attach only code you
  may share with them.
- Your projects folder is the first of these that exists: `~/Projects`, `~/Developer`, `~/Code`, `~/dev`,
  `~/src`, `~/repos`, `~/business`; otherwise your home folder.

### Safety rules for changes

The AI never writes raw Excalidraw data. It sends short orders, and Drawbook checks every order before
anything changes (`src/ai/changes.js`):

| Order | Allowed on |
|---|---|
| change text | a **selected** text, or the label of a **selected** box |
| change colour | a **selected** shape |
| delete | a **selected** shape |
| add | new boxes, ellipses, diamonds, texts and arrows |

Only the shapes that were selected **when you asked** can be changed or deleted. If one order is wrong,
nothing changes, and the answer says why.

## How it works

```
Browser / app window ──HTTP──▶ Drawbook server on 127.0.0.1:4747 ──▶ Drawings/*.excalidraw
(React + Excalidraw)           (Node.js, no npm packages)         └─▶ opencode serve (AI Drawer)
```

- The server listens only on `127.0.0.1` and rejects requests from other websites (Host and Origin checks).
- Saves are atomic (write a temporary file, then rename), so a crash never leaves a half-written drawing.
- Drawbook starts its own `opencode serve` with a random password and port. Every chat is an opencode
  session with all tools denied, except read/search in an attached project's copy. Your other opencode
  sessions are never shown or touched.

| | macOS | Linux | Windows |
|---|---|---|---|
| App files | `~/.drawbook` | `~/.drawbook` | `%LOCALAPPDATA%\Drawbook\app-home` |
| Drawings | `~/Drawings` | `~/Drawings` | `%USERPROFILE%\Drawings` |
| AI data | `~/Library/Application Support/Drawbook` | `~/.local/share/drawbook` | `%LOCALAPPDATA%\Drawbook` |
| Logs | `~/Library/Logs/drawbook.log` | `journalctl --user -u dev.drawbook.server` | — |

### Settings

| Environment variable | Default |
|---|---|
| `DRAWBOOK_PORT` | `4747` |
| `DRAWBOOK_DIR` | `~/Drawings` |
| `DRAWBOOK_PROJECTS_DIR` | see "Attach a code project" |

## Develop

Needs Node.js 22 and npm.

```sh
npm install
npm run dev           # server on :4747 + Vite on http://localhost:5173 with hot reload
npm test              # unit tests
npm run install-app   # macOS: build and run this checkout as the background app
```

If Drawbook is already running on port 4747, the dev server prints `EADDRINUSE` and Vite uses the running
server's API.

**Release:** push a version tag (`git tag v0.2.0 && git push --tags`). GitHub Actions tests, builds and
publishes `drawbook.tar.gz` and `drawbook.zip`, which the installers download.
