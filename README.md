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
| Codex | `~/.codex/sessions/` or `CODEX_HOME/sessions/` | JSONL |
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
# Start the viewer (auto-detects session directories)
agent-session-viewer

# Or with uvicorn directly
uvicorn agent_session_viewer.server:app --port 8765
```

Then open http://localhost:8765 in your browser.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_SESSIONS_ROOT` | `~/.codex/sessions` | Codex session directory |
| `CODEX_HOME` | `~/.codex` | Alternative: uses `$CODEX_HOME/sessions` |
| `CLAUDE_SESSIONS_ROOT` | `~/.claude/projects` | Claude Code session directory |

### Custom Session Directories

```bash
CODEX_SESSIONS_ROOT=/path/to/sessions agent-session-viewer
```

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run in reload mode
uvicorn agent_session_viewer.server:app --reload --port 8765
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web UI |
| `GET /api/sessions` | List all sessions |
| `GET /api/session/{path}` | Get session metadata |
| `GET /api/session/{path}/events` | Get session events (paginated) |
| `GET /api/config` | Get current configuration |

## License

MIT
