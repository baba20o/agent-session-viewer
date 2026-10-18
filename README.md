# agent-session-viewer

Web-based viewer for AI coding agent session logs. Supports **OpenAI Codex** and **Claude Code** session formats with auto-detection.

![Screenshot](docs/screenshot.png)

## Features

- 📂 **Browse sessions** by date with folder navigation
- 🔍 **Filter events** by type (messages, tool calls, reasoning, etc.)
- 🎨 **Syntax highlighting** for code blocks
- ⚡ **Live reload** with auto-refresh
- 🌗 **Dark/Light mode** toggle
- 📊 **Session stats** (tokens, duration, event counts)

## Supported Formats

| Agent | Session Location | Format |
|-------|------------------|--------|
| Codex | `.codex/sessions/` under the project root (set `CODEX_SESSIONS_ROOT` for `~/.codex/sessions/`) | JSONL |
| Claude Code | `~/.claude/projects/` | JSONL |

## Installation

```bash
pip install agent-session-viewer
```

Or install from source:

```bash
git clone https://github.com/baba20o/agent-session-viewer
cd agent-session-viewer
pip install -e .
```

## Usage

### Quick Start

```bash
# Start the viewer (session formats are auto-detected per file)
agent-session-viewer

# Options: --host (default 127.0.0.1), --port/-p (default 8765), --reload
agent-session-viewer --port 9000

# Or with uvicorn directly
uvicorn agent_session_viewer.server:app --port 8765
```

Then open http://localhost:8765 in your browser.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_SESSIONS_ROOT` | `<project root>/.codex/sessions` | Codex session directory |
| `CLAUDE_SESSIONS_ROOT` | `~/.claude/projects` | Claude Code session directory |
| `PROJECT_ROOT` | Nearest parent of the working directory containing `.git` or `pyproject.toml` (otherwise the working directory) | Base for the default Codex directory and the `jvs/` directories used by the JVS Logs, Artifacts and Save Chat features |
| `JVS_LOG_DIR` | `<project root>/jvs/logs` | Directory listed in the JVS Logs tab (`*.log` files) |
| `LOG_VIEWER_TOKEN` | unset | When set, POST actions require this value in the `X-Log-Viewer-Token` header; when unset, they accept unauthenticated requests |

`CODEX_HOME` is not read. Codex keeps its sessions in `~/.codex/sessions` by default, so set `CODEX_SESSIONS_ROOT` to view them unless you start the viewer from a project that has its own `.codex/sessions` directory.

### Custom Session Directories

```bash
CODEX_SESSIONS_ROOT=~/.codex/sessions agent-session-viewer
```

The **Sessions...** button in the UI changes a root for the running server only (it is not saved): a path containing `.claude` replaces the Claude Code root, and any other path replaces the Codex root.

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run tests (no tests are tracked in the repository yet)
pytest

# Run in reload mode
uvicorn agent_session_viewer.server:app --reload --port 8765
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web UI |
| `GET /api/status` | Get current configuration (project root, session roots, whether a token is required) |
| `GET /api/sessions` | List all sessions (optional `format=codex`, `claude` or `all`) |
| `GET /api/session/{path}/meta` | Get session metadata (format, counters, models, last token usage) |
| `GET /api/session/{path}/events` | Get session events (paginated with `offset`/`limit`; `order`, `contains`) |
| `GET /api/session/{path}/conversation` | Get user/assistant messages only |
| `GET /api/session/{path}/tool-calls` | Get tool calls paired with their outputs |
| `GET /api/session/{path}/reasoning` | Get Codex reasoning or Claude Code thinking blocks |
| `POST /api/session/{path}/conversation/save` | Save the conversation as a text file in `<project root>/jvs/chathistory/` |
| `POST /api/settings/sessions-root` | Change a session root for the running server (JSON body `{"path": "..."}`) |
| `POST /api/kill-codex` | Force-kill Codex processes (`taskkill /F /IM codex.exe` on Windows; elsewhere `pkill -9 codex`, which matches any process name containing `codex`) |
| `GET /api/jvs-logs`, `GET /api/jvs-log/{name}` | List or tail `*.log` files in `JVS_LOG_DIR` |
| `GET /api/artifacts`, `GET /api/artifact/{root}/{path}` | List or download files in `<project root>/jvs/data` (`root=data`) or `jvs/reports` (`root=reports`) |

`{path}` is a session `id` from `/api/sessions` (relative to its session root). The `/api/session/{path}/...` endpoints accept `root=codex`, `claude` or `auto` (default; checks the Codex root first). POST endpoints check `LOG_VIEWER_TOKEN` as described above.

## License

MIT
