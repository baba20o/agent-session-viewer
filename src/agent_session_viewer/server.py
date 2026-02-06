"""
Unified Session Log Viewer - FastAPI server for browsing AI session JSONL files.

Supports both Codex and Claude Code session formats with auto-detection.

Usage:
    uvicorn jvs.tools.log_viewer.server:app --reload --port 8765

Or run directly:
    python -m jvs.tools.log_viewer.server
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Header, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

# ==============================================================================
# Configuration
# ==============================================================================

def _find_project_root() -> Path:
    """Walk up from cwd looking for .git or pyproject.toml."""
    p = Path.cwd().resolve()
    for parent in [p, *p.parents]:
        if (parent / ".git").exists() or (parent / "pyproject.toml").exists():
            return parent
    return p


PROJECT_ROOT = Path(os.getenv("PROJECT_ROOT", str(_find_project_root()))).resolve()

# Default session roots for each format
CODEX_SESSIONS_ROOT = Path(
    os.getenv("CODEX_SESSIONS_ROOT", str(PROJECT_ROOT / ".codex" / "sessions"))
).resolve()

CLAUDE_SESSIONS_ROOT = Path(
    os.getenv("CLAUDE_SESSIONS_ROOT", str(Path.home() / ".claude" / "projects"))
).resolve()

JVS_LOG_DIR = Path(os.getenv("JVS_LOG_DIR", str(PROJECT_ROOT / "jvs" / "logs"))).resolve()
JVS_DATA_DIR = PROJECT_ROOT / "jvs" / "data"
JVS_REPORTS_DIR = PROJECT_ROOT / "jvs" / "reports"
CHAT_HISTORY_DIR = PROJECT_ROOT / "jvs" / "chathistory"

LOG_VIEWER_TOKEN = os.getenv("LOG_VIEWER_TOKEN", "").strip()

# ==============================================================================
# Format Detection
# ==============================================================================

SessionFormat = Literal["codex", "claude", "unknown"]


def detect_format(file_path: Path) -> SessionFormat:
    """Auto-detect session format from file content."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    # Claude format indicators
                    if data.get("type") in ("user", "assistant", "progress", "file-history-snapshot", "system", "queue-operation"):
                        return "claude"
                    # Codex format indicators
                    if data.get("type") in ("event_msg", "response_item", "turn_context", "compacted"):
                        return "codex"
                    if "payload" in data:
                        return "codex"
                    if isinstance(data.get("message"), dict) and "role" in data.get("message", {}):
                        return "claude"
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return "unknown"


# ==============================================================================
# FastAPI App
# ==============================================================================

app = FastAPI(title="Unified Session Log Viewer", version="2.0.0")

# Mount static files
STATIC_DIR = Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ==============================================================================
# Helpers
# ==============================================================================

def _normalize_path(raw: str) -> Path:
    """Normalize WSL/Windows paths."""
    if raw.startswith("/mnt/") and len(raw) > 6:
        drive = raw[5].upper()
        rest = raw[6:].replace("/", "\\")
        return Path(f"{drive}:{rest}")
    return Path(raw)


def _require_token(x_log_viewer_token: Optional[str]) -> None:
    """Check token for mutation endpoints."""
    if LOG_VIEWER_TOKEN and x_log_viewer_token != LOG_VIEWER_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid or missing LOG_VIEWER_TOKEN")


def _human_size(size_bytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(size_bytes) < 1024.0:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f} TB"


def _list_sessions(root: Path, format_hint: SessionFormat = "unknown") -> list[dict]:
    """List session files under a root directory."""
    sessions = []
    if not root.exists():
        return sessions

    patterns = ["**/*.jsonl"]
    for pattern in patterns:
        for fp in root.glob(pattern):
            if not fp.is_file():
                continue
            try:
                stat = fp.stat()
                rel = fp.relative_to(root)

                # Detect format if not hinted
                fmt = format_hint if format_hint != "unknown" else detect_format(fp)

                sessions.append({
                    "id": str(rel).replace("\\", "/"),
                    "path": str(fp),
                    "format": fmt,
                    "size": stat.st_size,
                    "size_human": _human_size(stat.st_size),
                    "modified": stat.st_mtime,
                    "modified_iso": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                })
            except Exception:
                continue

    sessions.sort(key=lambda x: x["modified"], reverse=True)
    return sessions


# ==============================================================================
# Codex-specific parsing
# ==============================================================================

def _extract_codex_event(line_num: int, data: dict) -> dict:
    """Extract event info from a Codex JSONL entry."""
    entry_type = data.get("type", "")
    payload = data.get("payload", {})
    timestamp = data.get("timestamp", "")

    result = {
        "line": line_num,
        "type": entry_type,
        "subtype": None,
        "timestamp": timestamp,
        "summary": None,
        "text_block": None,
        "data": data,
    }

    if entry_type == "event_msg":
        result["subtype"] = payload.get("type", "")
        if payload.get("type") == "user_message":
            result["summary"] = payload.get("message", "")[:500]
        elif payload.get("type") == "agent_message":
            result["summary"] = payload.get("message", "")[:500]
        elif payload.get("type") == "agent_reasoning":
            result["summary"] = payload.get("text", "")[:500]

    elif entry_type == "response_item":
        payload_type = payload.get("type", "")
        result["subtype"] = payload_type
        if payload_type == "function_call":
            result["summary"] = f"{payload.get('name', '')}()"
        elif payload_type == "function_call_output":
            output = payload.get("output", "")
            result["summary"] = f"Output: {len(output)} chars"
        elif payload_type == "message":
            role = payload.get("role", "")
            result["summary"] = f"[{role}]"

    elif entry_type == "turn_context":
        result["summary"] = f"model={payload.get('model', '')} effort={payload.get('effort', '')}"

    elif entry_type == "compacted":
        result["summary"] = "Session compacted"

    return result


def _extract_codex_conversation(data: dict) -> Optional[dict]:
    """Extract conversation event from Codex entry."""
    entry_type = data.get("type", "")
    payload = data.get("payload", {})
    timestamp = data.get("timestamp", "")

    if entry_type == "event_msg":
        msg_type = payload.get("type", "")
        if msg_type == "user_message":
            return {"role": "user", "text": payload.get("message", ""), "timestamp": timestamp}
        elif msg_type == "agent_message":
            return {"role": "assistant", "text": payload.get("message", ""), "timestamp": timestamp}

    elif entry_type == "response_item":
        if payload.get("type") == "message":
            role = payload.get("role", "assistant")
            content = payload.get("content", [])
            text = ""
            for item in content:
                if isinstance(item, dict):
                    if item.get("type") == "output_text":
                        text = item.get("text", "")
                        break
                    elif item.get("type") == "input_text":
                        text = item.get("text", "")
                        break
            if text:
                return {"role": role, "text": text, "timestamp": timestamp}

    return None


def _extract_codex_tool_call(data: dict, line_num: int) -> Optional[dict]:
    """Extract tool call from Codex entry."""
    if data.get("type") != "response_item":
        return None
    payload = data.get("payload", {})
    if payload.get("type") != "function_call":
        return None

    return {
        "call_id": payload.get("call_id", ""),
        "name": payload.get("name", ""),
        "arguments": payload.get("arguments", ""),
        "call_line": line_num,
        "call_timestamp": data.get("timestamp", ""),
    }


def _extract_codex_tool_output(data: dict, line_num: int) -> Optional[dict]:
    """Extract tool output from Codex entry."""
    if data.get("type") != "response_item":
        return None
    payload = data.get("payload", {})
    if payload.get("type") != "function_call_output":
        return None

    output = payload.get("output", "")
    return {
        "call_id": payload.get("call_id", ""),
        "output_preview": output[:500] if len(output) > 500 else output,
        "output_line": line_num,
        "output_meta": {
            "exit_code": payload.get("exit_code"),
            "duration_seconds": payload.get("duration_seconds"),
        },
    }


def _extract_codex_reasoning(data: dict, line_num: int) -> Optional[dict]:
    """Extract reasoning from Codex entry."""
    if data.get("type") != "event_msg":
        return None
    payload = data.get("payload", {})
    if payload.get("type") != "agent_reasoning":
        return None

    return {
        "text": payload.get("text", ""),
        "line": line_num,
        "timestamp": data.get("timestamp", ""),
    }


# ==============================================================================
# Claude-specific parsing
# ==============================================================================

def _extract_claude_event(line_num: int, data: dict) -> dict:
    """Extract event info from a Claude JSONL entry."""
    entry_type = data.get("type", "")
    message = data.get("message", {})
    uuid = data.get("uuid", "")

    result = {
        "line": line_num,
        "type": entry_type,
        "subtype": None,
        "timestamp": "",
        "uuid": uuid,
        "summary": None,
        "text_block": None,
        "data": data,
    }

    if entry_type == "user":
        content = message.get("content", [])
        text_parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif isinstance(block, str):
                text_parts.append(block)
        result["summary"] = "\n".join(text_parts)[:500]
        result["subtype"] = "user_message"

    elif entry_type == "assistant":
        content = message.get("content", [])
        text_parts = []
        tool_names = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    tool_names.append(block.get("name", ""))

        if text_parts:
            result["summary"] = "\n".join(text_parts)[:500]
            result["subtype"] = "agent_message"
        if tool_names:
            result["summary"] = (result["summary"] or "") + f" [tools: {', '.join(tool_names)}]"

    elif entry_type == "progress":
        result["summary"] = str(data.get("content", ""))[:200]
        result["subtype"] = "progress"

    elif entry_type == "system":
        result["summary"] = str(data.get("message", ""))[:200]
        result["subtype"] = "system"

    elif entry_type == "file-history-snapshot":
        snapshot = data.get("snapshot", {})
        result["summary"] = f"File snapshot: {len(snapshot)} files"
        result["subtype"] = "snapshot"

    return result


def _extract_claude_conversation(data: dict) -> list[dict]:
    """Extract conversation events from Claude entry."""
    entry_type = data.get("type", "")
    message = data.get("message", {})
    timestamp = data.get("timestamp", "")
    results = []

    if entry_type == "user":
        content = message.get("content", "")
        text_parts = []

        # Content can be a string (regular user message) or a list (tool results)
        if isinstance(content, str):
            if content.strip():
                text_parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    text_parts.append(block)

        if text_parts:
            results.append({"role": "user", "text": "\n".join(text_parts), "timestamp": timestamp})

    elif entry_type == "assistant":
        content = message.get("content", [])
        text_parts = []

        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    text_parts.append(block)
        elif isinstance(content, str):
            if content.strip():
                text_parts.append(content)

        if text_parts:
            results.append({"role": "assistant", "text": "\n".join(text_parts), "timestamp": timestamp})

    return results


def _extract_claude_tool_calls(data: dict, line_num: int) -> list[dict]:
    """Extract tool calls from Claude entry."""
    if data.get("type") != "assistant":
        return []

    message = data.get("message", {})
    content = message.get("content", [])
    results = []

    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            results.append({
                "call_id": block.get("id", ""),
                "name": block.get("name", ""),
                "arguments": json.dumps(block.get("input", {})) if isinstance(block.get("input"), dict) else str(block.get("input", "")),
                "call_line": line_num,
                "call_timestamp": "",
            })

    return results


def _extract_claude_tool_results(data: dict, line_num: int) -> list[dict]:
    """Extract tool results from Claude user entry."""
    if data.get("type") != "user":
        return []

    message = data.get("message", {})
    content = message.get("content", [])
    results = []

    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_result":
            result_content = block.get("content", "")
            result_str = str(result_content)
            results.append({
                "call_id": block.get("tool_use_id", ""),
                "output_preview": result_str[:500] if len(result_str) > 500 else result_str,
                "output_line": line_num,
                "output_meta": {
                    "is_error": block.get("is_error", False),
                    "content_length": len(result_str),
                },
            })

    return results


def _extract_claude_thinking(data: dict, line_num: int) -> list[dict]:
    """Extract thinking/reasoning blocks from Claude assistant entry."""
    if data.get("type") != "assistant":
        return []

    message = data.get("message", {})
    content = message.get("content", [])
    results = []

    for block in content:
        if isinstance(block, dict) and block.get("type") == "thinking":
            thinking_text = block.get("thinking", "")
            results.append({
                "text": thinking_text,
                "line": line_num,
                "timestamp": "",
            })

    return results


# ==============================================================================
# API Endpoints
# ==============================================================================

@app.get("/")
async def index():
    """Serve the main HTML page."""
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return PlainTextResponse("Static files not found. Run from correct directory.")


@app.get("/api/status")
async def get_status():
    """Get server status and configuration."""
    return {
        "project_root": str(PROJECT_ROOT),
        "codex_sessions_root": str(CODEX_SESSIONS_ROOT),
        "claude_sessions_root": str(CLAUDE_SESSIONS_ROOT),
        "token_required_for_mutations": bool(LOG_VIEWER_TOKEN),
        "supported_formats": ["codex", "claude"],
    }


@app.get("/api/sessions")
async def list_all_sessions(
    format: Optional[str] = Query(None, description="Filter by format: codex, claude, or all"),
):
    """List all available sessions from both Codex and Claude roots."""
    sessions = []

    if format in (None, "all", "codex"):
        codex_sessions = _list_sessions(CODEX_SESSIONS_ROOT, "codex")
        sessions.extend(codex_sessions)

    if format in (None, "all", "claude"):
        claude_sessions = _list_sessions(CLAUDE_SESSIONS_ROOT, "claude")
        sessions.extend(claude_sessions)

    sessions.sort(key=lambda x: x["modified"], reverse=True)

    return {
        "sessions": sessions,
        "codex_root": str(CODEX_SESSIONS_ROOT),
        "claude_root": str(CLAUDE_SESSIONS_ROOT),
    }


@app.get("/api/session/{session_path:path}/meta")
async def get_session_meta(session_path: str, root: str = Query("auto")):
    """Get session metadata."""
    if root == "codex":
        file_path = CODEX_SESSIONS_ROOT / session_path
    elif root == "claude":
        file_path = CLAUDE_SESSIONS_ROOT / session_path
    else:
        codex_path = CODEX_SESSIONS_ROOT / session_path
        claude_path = CLAUDE_SESSIONS_ROOT / session_path
        file_path = codex_path if codex_path.exists() else claude_path

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    fmt = detect_format(file_path)

    counters = {
        "lines": 0,
        "response_items": 0,
        "event_msgs": 0,
        "compactions": 0,
        "user_messages": 0,
        "assistant_messages": 0,
        "tool_calls": 0,
    }

    last_turn_context = {}
    last_token_count = {}
    models_used = set()

    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            counters["lines"] += 1
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            if fmt == "codex":
                entry_type = data.get("type", "")
                payload = data.get("payload", {})

                if entry_type == "response_item":
                    counters["response_items"] += 1
                    if payload.get("type") == "function_call":
                        counters["tool_calls"] += 1
                elif entry_type == "event_msg":
                    counters["event_msgs"] += 1
                    if payload.get("type") == "user_message":
                        counters["user_messages"] += 1
                    elif payload.get("type") == "agent_message":
                        counters["assistant_messages"] += 1
                    elif payload.get("type") == "token_count":
                        last_token_count = payload.get("info", {})
                elif entry_type == "turn_context":
                    last_turn_context = payload
                    if payload.get("model"):
                        models_used.add(payload["model"])
                elif entry_type == "compacted":
                    counters["compactions"] += 1

            elif fmt == "claude":
                entry_type = data.get("type", "")
                message = data.get("message", {})

                if entry_type == "user":
                    counters["user_messages"] += 1
                elif entry_type == "assistant":
                    counters["assistant_messages"] += 1
                    content = message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            counters["tool_calls"] += 1
                    usage = message.get("usage", {})
                    if usage:
                        last_token_count = usage
                    model = message.get("model", "")
                    if model:
                        models_used.add(model)

    return {
        "format": fmt,
        "counters": counters,
        "last_turn_context": last_turn_context,
        "last_token_count": last_token_count,
        "models_used": list(models_used),
    }


@app.get("/api/session/{session_path:path}/events")
async def get_session_events(
    session_path: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
    contains: Optional[str] = Query(None),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    root: str = Query("auto", description="Session root: codex, claude, or auto"),
):
    """Get paginated events from a session file."""
    if root == "codex":
        file_path = CODEX_SESSIONS_ROOT / session_path
    elif root == "claude":
        file_path = CLAUDE_SESSIONS_ROOT / session_path
    else:
        codex_path = CODEX_SESSIONS_ROOT / session_path
        claude_path = CLAUDE_SESSIONS_ROOT / session_path
        if codex_path.exists():
            file_path = codex_path
        elif claude_path.exists():
            file_path = claude_path
        else:
            raise HTTPException(status_code=404, detail=f"Session not found: {session_path}")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Session not found: {session_path}")

    fmt = detect_format(file_path)

    events = []
    total_lines = 0
    matching_count = 0
    contains_lower = contains.lower() if contains else None

    with open(file_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            total_lines = line_num
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            if fmt == "codex":
                event = _extract_codex_event(line_num, data)
            elif fmt == "claude":
                event = _extract_claude_event(line_num, data)
            else:
                event = {"line": line_num, "type": "unknown", "data": data}

            if contains_lower:
                searchable = json.dumps(data).lower()
                if contains_lower not in searchable:
                    continue

            matching_count += 1
            events.append(event)

    if order == "desc":
        events.reverse()

    total_events = len(events)
    paginated = events[offset:offset + limit]
    next_offset = offset + limit if offset + limit < total_events else None
    last_offset = max(0, total_events - limit) if total_events > limit else 0

    return {
        "format": fmt,
        "events": paginated,
        "offset": offset,
        "limit": limit,
        "total_lines": total_lines,
        "matching_events": matching_count,
        "next_offset": next_offset,
        "last_offset": last_offset,
    }


@app.get("/api/session/{session_path:path}/conversation")
async def get_conversation(
    session_path: str,
    limit: int = Query(300, ge=1, le=2000),
    root: str = Query("auto"),
):
    """Get conversation (user/assistant messages only)."""
    if root == "codex":
        file_path = CODEX_SESSIONS_ROOT / session_path
    elif root == "claude":
        file_path = CLAUDE_SESSIONS_ROOT / session_path
    else:
        codex_path = CODEX_SESSIONS_ROOT / session_path
        claude_path = CLAUDE_SESSIONS_ROOT / session_path
        file_path = codex_path if codex_path.exists() else claude_path

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    fmt = detect_format(file_path)
    events = []

    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            if fmt == "codex":
                conv = _extract_codex_conversation(data)
                if conv:
                    events.append(conv)
            elif fmt == "claude":
                convs = _extract_claude_conversation(data)
                events.extend(convs)

    events = events[-limit:]
    events.reverse()

    return {"format": fmt, "events": events}


@app.get("/api/session/{session_path:path}/tool-calls")
async def get_tool_calls(
    session_path: str,
    limit: int = Query(200, ge=1, le=2000),
    order: str = Query("desc"),
    contains: Optional[str] = Query(None),
    root: str = Query("auto"),
):
    """Get tool calls with their outputs paired."""
    if root == "codex":
        file_path = CODEX_SESSIONS_ROOT / session_path
    elif root == "claude":
        file_path = CLAUDE_SESSIONS_ROOT / session_path
    else:
        codex_path = CODEX_SESSIONS_ROOT / session_path
        claude_path = CLAUDE_SESSIONS_ROOT / session_path
        file_path = codex_path if codex_path.exists() else claude_path

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    fmt = detect_format(file_path)

    calls = {}
    outputs = {}
    lines_scanned = 0
    contains_lower = contains.lower() if contains else None

    with open(file_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            lines_scanned = line_num
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            if fmt == "codex":
                call = _extract_codex_tool_call(data, line_num)
                if call:
                    calls[call["call_id"]] = call

                output = _extract_codex_tool_output(data, line_num)
                if output:
                    outputs[output["call_id"]] = output

            elif fmt == "claude":
                # Extract tool calls from assistant messages
                tool_calls = _extract_claude_tool_calls(data, line_num)
                for call in tool_calls:
                    calls[call["call_id"]] = call

                # Extract tool results from user messages
                tool_results = _extract_claude_tool_results(data, line_num)
                for result in tool_results:
                    outputs[result["call_id"]] = result

    items = []
    for call_id, call in calls.items():
        item = {**call}
        if call_id in outputs:
            item.update(outputs[call_id])

        if contains_lower:
            searchable = f"{item.get('name', '')} {item.get('arguments', '')} {item.get('call_id', '')}".lower()
            if contains_lower not in searchable:
                continue

        items.append(item)

    items.sort(key=lambda x: x.get("call_line", 0), reverse=(order == "desc"))
    items = items[:limit]

    return {
        "format": fmt,
        "items": items,
        "counters": {
            "lines_scanned": lines_scanned,
            "total_calls": len(calls),
            "paired": len([i for i in items if "output_line" in i]),
        },
    }


@app.get("/api/session/{session_path:path}/reasoning")
async def get_reasoning(
    session_path: str,
    limit: int = Query(200, ge=1, le=2000),
    order: str = Query("desc"),
    contains: Optional[str] = Query(None),
    root: str = Query("auto"),
):
    """Get reasoning/thinking entries (Codex agent_reasoning or Claude thinking blocks)."""
    if root == "codex":
        file_path = CODEX_SESSIONS_ROOT / session_path
    elif root == "claude":
        file_path = CLAUDE_SESSIONS_ROOT / session_path
    else:
        codex_path = CODEX_SESSIONS_ROOT / session_path
        claude_path = CLAUDE_SESSIONS_ROOT / session_path
        file_path = codex_path if codex_path.exists() else claude_path

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    fmt = detect_format(file_path)
    items = []
    lines_scanned = 0
    contains_lower = contains.lower() if contains else None

    with open(file_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            lines_scanned = line_num
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            if fmt == "codex":
                reasoning = _extract_codex_reasoning(data, line_num)
                if reasoning:
                    if contains_lower and contains_lower not in reasoning["text"].lower():
                        continue
                    items.append(reasoning)

            elif fmt == "claude":
                # Extract thinking blocks from Claude
                thinking_blocks = _extract_claude_thinking(data, line_num)
                for thinking in thinking_blocks:
                    if contains_lower and contains_lower not in thinking["text"].lower():
                        continue
                    items.append(thinking)

    items.sort(key=lambda x: x.get("line", 0), reverse=(order == "desc"))
    items = items[:limit]

    return {
        "format": fmt,
        "items": items,
        "counters": {
            "lines_scanned": lines_scanned,
            "matched": len(items),
        },
    }


@app.post("/api/session/{session_path:path}/conversation/save")
async def save_conversation(
    session_path: str,
    limit: int = Query(1000, ge=1),
    root: str = Query("auto"),
    x_log_viewer_token: Optional[str] = Header(None),
):
    """Save conversation to disk."""
    _require_token(x_log_viewer_token)

    if root == "codex":
        file_path = CODEX_SESSIONS_ROOT / session_path
    elif root == "claude":
        file_path = CLAUDE_SESSIONS_ROOT / session_path
    else:
        codex_path = CODEX_SESSIONS_ROOT / session_path
        claude_path = CLAUDE_SESSIONS_ROOT / session_path
        file_path = codex_path if codex_path.exists() else claude_path

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    fmt = detect_format(file_path)
    events = []

    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            if fmt == "codex":
                conv = _extract_codex_conversation(data)
                if conv:
                    events.append(conv)
            elif fmt == "claude":
                convs = _extract_claude_conversation(data)
                events.extend(convs)

    events = events[-limit:]

    CHAT_HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = re.sub(r"[^\w\-_.]", "_", session_path.replace("/", "_"))
    output_path = CHAT_HISTORY_DIR / f"{timestamp}_{safe_name}.txt"

    with open(output_path, "w", encoding="utf-8") as f:
        for event in events:
            role = event.get("role", "unknown").upper()
            text = event.get("text", "")
            f.write(f"[{role}]\n{text}\n\n{'='*60}\n\n")

    return {"saved_path": str(output_path), "count": len(events)}


@app.get("/api/jvs-logs")
async def list_jvs_logs():
    """List JVS log files."""
    logs = []
    if JVS_LOG_DIR.exists():
        for fp in JVS_LOG_DIR.glob("*.log"):
            if fp.is_file():
                stat = fp.stat()
                logs.append({
                    "id": fp.name,
                    "path": str(fp),
                    "size": stat.st_size,
                    "size_human": _human_size(stat.st_size),
                    "modified": stat.st_mtime,
                    "modified_iso": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                })
    logs.sort(key=lambda x: x["modified"], reverse=True)
    return {"logs": logs}


@app.get("/api/jvs-log/{log_path:path}")
async def get_jvs_log(log_path: str, lines: int = Query(2000, ge=10, le=20000)):
    """Get content of a JVS log file."""
    file_path = JVS_LOG_DIR / log_path
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Log not found")

    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
            tail = all_lines[-lines:] if len(all_lines) > lines else all_lines
            content = "".join(tail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"path": str(file_path), "content": content}


@app.get("/api/artifacts")
async def list_artifacts(root: str = Query("data")):
    """List artifact files."""
    if root == "data":
        artifact_dir = JVS_DATA_DIR
    elif root == "reports":
        artifact_dir = JVS_REPORTS_DIR
    else:
        raise HTTPException(status_code=400, detail="Invalid root")

    artifacts = []
    if artifact_dir.exists():
        for fp in artifact_dir.rglob("*"):
            if fp.is_file():
                try:
                    stat = fp.stat()
                    rel = fp.relative_to(artifact_dir)
                    artifacts.append({
                        "id": str(rel).replace("\\", "/"),
                        "path": str(fp),
                        "size": stat.st_size,
                        "size_human": _human_size(stat.st_size),
                        "modified": stat.st_mtime,
                        "modified_iso": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                    })
                except Exception:
                    continue
    artifacts.sort(key=lambda x: x["modified"], reverse=True)
    return {"artifacts": artifacts}


@app.get("/api/artifact/{root}/{artifact_path:path}")
async def get_artifact(root: str, artifact_path: str):
    """Download an artifact file."""
    if root == "data":
        file_path = JVS_DATA_DIR / artifact_path
    elif root == "reports":
        file_path = JVS_REPORTS_DIR / artifact_path
    else:
        raise HTTPException(status_code=400, detail="Invalid root")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Artifact not found")

    return FileResponse(str(file_path))


@app.post("/api/kill-codex")
async def kill_codex(x_log_viewer_token: Optional[str] = Header(None)):
    """Kill all Codex processes."""
    _require_token(x_log_viewer_token)

    results = []
    before = []
    after = []

    if sys.platform == "win32":
        try:
            result = subprocess.run(["tasklist", "/FI", "IMAGENAME eq codex.exe"], capture_output=True, text=True)
            before = [l for l in result.stdout.split("\n") if "codex" in l.lower()]
        except Exception:
            pass

        try:
            result = subprocess.run(["taskkill", "/F", "/IM", "codex.exe"], capture_output=True, text=True)
            results.append(result.stdout + result.stderr)
        except Exception as e:
            results.append(str(e))

        try:
            result = subprocess.run(["tasklist", "/FI", "IMAGENAME eq codex.exe"], capture_output=True, text=True)
            after = [l for l in result.stdout.split("\n") if "codex" in l.lower()]
        except Exception:
            pass
    else:
        try:
            result = subprocess.run(["pgrep", "-l", "codex"], capture_output=True, text=True)
            before = result.stdout.strip().split("\n") if result.stdout.strip() else []
        except Exception:
            pass

        try:
            result = subprocess.run(["pkill", "-9", "codex"], capture_output=True, text=True)
            results.append(result.stdout + result.stderr)
        except Exception as e:
            results.append(str(e))

        try:
            result = subprocess.run(["pgrep", "-l", "codex"], capture_output=True, text=True)
            after = result.stdout.strip().split("\n") if result.stdout.strip() else []
        except Exception:
            pass

    return {"before": before, "after": after, "results": results}


@app.post("/api/settings/sessions-root")
async def set_sessions_root(
    request: Request,
    x_log_viewer_token: Optional[str] = Header(None),
):
    """Change sessions root directory at runtime."""
    _require_token(x_log_viewer_token)

    body = await request.json()
    raw_path = body.get("path", "")
    if not raw_path:
        raise HTTPException(status_code=400, detail="Missing path")

    normalized = _normalize_path(raw_path)
    if not normalized.exists():
        raise HTTPException(status_code=400, detail=f"Path does not exist: {normalized}")

    global CODEX_SESSIONS_ROOT, CLAUDE_SESSIONS_ROOT

    path_str = str(normalized).lower()
    if ".codex" in path_str:
        CODEX_SESSIONS_ROOT = normalized
    elif ".claude" in path_str:
        CLAUDE_SESSIONS_ROOT = normalized
    else:
        CODEX_SESSIONS_ROOT = normalized

    return {"codex_sessions_root": str(CODEX_SESSIONS_ROOT), "claude_sessions_root": str(CLAUDE_SESSIONS_ROOT)}


# ==============================================================================
# Main
# ==============================================================================

def main():
    """CLI entry point for agent-session-viewer."""
    import argparse
    import uvicorn
    
    parser = argparse.ArgumentParser(description="Agent Session Viewer - Web UI for AI coding agent logs")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")
    parser.add_argument("--port", "-p", type=int, default=8765, help="Port to bind to (default: 8765)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args()
    
    print(f"Starting Agent Session Viewer at http://{args.host}:{args.port}")
    uvicorn.run("agent_session_viewer.server:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()

