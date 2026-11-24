#!/usr/bin/env python3
"""S.H.I.E.L.D. — Strategic Homeland Intervention, Enforcement and Logistics Division
MCP App server for monitoring Antigravity agents and conversations in real time.
"""

import json
import logging
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
APP_URI = "ui://shield/app.html"
DEFAULT_HTML_PATH = PLUGIN_ROOT / "ui" / "dist" / "app.html"
BRAIN_DIR = Path(os.environ.get("ANTIGRAVITY_BRAIN_DIR", str(Path.home() / ".gemini" / "antigravity" / "brain")))
LOG_PATH = Path(os.environ.get("SHIELD_LOG_PATH", str(PLUGIN_ROOT / "shield.log")))

logger = logging.getLogger("shield")
logger.setLevel(logging.INFO)
_fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
_stderr_handler = logging.StreamHandler(sys.stderr)
_stderr_handler.setFormatter(_fmt)
logger.addHandler(_stderr_handler)
try:
    _file_handler = logging.FileHandler(LOG_PATH, encoding="utf-8")
    _file_handler.setFormatter(_fmt)
    logger.addHandler(_file_handler)
except Exception as _log_exc:
    sys.stderr.write(f"[shield] Could not open log file {LOG_PATH}: {_log_exc}\n")

IGNORED_PATH_PARTS = {
    ".gemini", "antigravity", "brain", "scratch", ".system_generated",
    "tmp", "var", "usr", "opt", "Library", "Applications", "System",
}


def _strip_quotes(val: Any) -> str:
    if not isinstance(val, str):
        return ""
    s = val.strip()
    if len(s) >= 2 and ((s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'")):
        try:
            return json.loads(s)
        except Exception:
            return s[1:-1]
    return s


def _clean_user_prompt(text: str) -> str:
    if not text:
        return ""
    m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", text, re.DOTALL)
    if m:
        text = m.group(1)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:180]


def _extract_project_from_path(raw_path: str) -> Optional[str]:
    p = _strip_quotes(raw_path)
    if not p or not p.startswith("/"):
        return None
    parts = [seg for seg in p.split("/") if seg]
    if not parts:
        return None
    # Skip system / .gemini internal paths unless inside scratch/<project>
    if ".gemini" in parts:
        try:
            idx = parts.index("scratch")
            if idx + 1 < len(parts):
                return parts[idx + 1]
        except ValueError:
            pass
        try:
            idx = parts.index("plugins")
            if idx + 1 < len(parts):
                return f"plugin:{parts[idx + 1]}"
        except ValueError:
            pass
        return None

    # Mounted macOS volumes: /Volumes/<volume>/<project>/... or /Volumes/<volume>/Projects/<project>/...
    if len(parts) >= 3 and parts[0] == "Volumes":
        if len(parts) >= 4 and parts[2] in ("Projects", "Code", "Developer", "Workspace", "Work", "src", "repos", "dev"):
            return parts[3]
        if parts[2] not in IGNORED_PATH_PARTS and not parts[2].startswith("."):
            return parts[2]

    # Common macOS/Linux user workspace patterns: /Users/<user>/<dir>/<project>/...
    if len(parts) >= 4 and parts[0] in ("Users", "home"):
        if parts[2] in ("Desktop", "Documents", "Projects", "Code", "Developer", "Workspace", "Work", "src", "repos", "dev"):
            return parts[3]
        if parts[2] not in IGNORED_PATH_PARTS and not parts[2].startswith("."):
            return parts[2]
    return None


def _read_git_config_github(git_cfg: Path) -> str:
    try:
        text = git_cfg.read_text(encoding="utf-8", errors="replace")
        m = re.search(r'\[remote\s+"origin"\][^\[]*?url\s*=\s*(\S+)', text, re.DOTALL)
        if not m:
            m = re.search(r'url\s*=\s*(\S*github\.com\S+)', text)
        if m:
            raw = m.group(1).strip()
            if raw.startswith("git@github.com:"):
                raw = "https://github.com/" + raw[len("git@github.com:"):]
            elif raw.startswith("ssh://git@github.com/"):
                raw = "https://github.com/" + raw[len("ssh://git@github.com/"):]
            if "github.com/" in raw:
                if raw.endswith(".git"):
                    raw = raw[:-4]
                return raw
    except Exception:
        pass
    return ""


def _find_github_url(project_path: str, project_name: str = "") -> str:
    candidates: List[Path] = []
    if project_path:
        p = Path(project_path)
        if p.exists():
            candidates.append(p if p.is_dir() else p.parent)

    # Also check mounted volumes if the path doesn't exist locally (e.g. moved to external drive)
    if not candidates and project_name and not project_name.startswith("plugin:"):
        volumes = Path("/Volumes")
        if volumes.is_dir():
            try:
                for vol in volumes.iterdir():
                    if not vol.is_dir() or vol.name.startswith("."):
                        continue
                    for sub in (vol / project_name, vol / "Projects" / project_name, vol / "Code" / project_name):
                        if sub.is_dir():
                            candidates.append(sub)
            except Exception:
                pass

    for start in candidates:
        cur = start
        for _ in range(6):
            git_cfg = cur / ".git" / "config"
            if git_cfg.is_file():
                url = _read_git_config_github(git_cfg)
                if url:
                    return url
                break
            if cur.parent == cur:
                break
            cur = cur.parent
    return ""


_GH_TOKEN_LOADED = False
_GH_TOKEN = ""
_GH_ACTIONS_CACHE: Dict[str, Tuple[float, bool]] = {}


def _get_gh_token() -> str:
    global _GH_TOKEN_LOADED, _GH_TOKEN
    if _GH_TOKEN_LOADED:
        return _GH_TOKEN
    _GH_TOKEN_LOADED = True
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not tok:
        try:
            out = subprocess.check_output(["gh", "auth", "token"], stderr=subprocess.DEVNULL, timeout=2)
            tok = out.decode("utf-8", errors="replace").strip()
        except Exception:
            tok = ""
    _GH_TOKEN = tok
    return _GH_TOKEN


def _check_github_actions_running(github_url: str) -> bool:
    if not github_url or "github.com/" not in github_url:
        return False
    slug = github_url.split("github.com/", 1)[1].strip("/")
    parts = slug.split("/")
    if len(parts) < 2:
        return False
    repo = f"{parts[0]}/{parts[1]}"
    now = time.time()
    cached = _GH_ACTIONS_CACHE.get(repo)
    if cached and (now - cached[0]) < 30.0:
        return cached[1]

    running = False
    try:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/actions/runs?per_page=5",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "shield-antigravity-plugin",
            },
        )
        tok = _get_gh_token()
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
            for run in data.get("workflow_runs") or []:
                if run.get("status") in ("in_progress", "queued", "waiting", "pending"):
                    running = True
                    break
    except Exception as exc:
        logger.debug("GitHub Actions check failed for %s: %s", repo, exc)

    _GH_ACTIONS_CACHE[repo] = (now, running)
    return running


def _parse_iso_ts(ts: Optional[str]) -> Optional[float]:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp()
    except Exception:
        return None


def _read_tail_lines(path: Path, max_bytes: int = 131072) -> Tuple[Optional[str], List[str]]:
    """Read the first line (for initial user prompt) and the tail lines (for live state)."""
    first_line = None
    tail_lines: List[str] = []
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            first_raw = f.readline()
            if first_raw:
                first_line = first_raw.decode("utf-8", errors="replace").strip()
            if size > max_bytes:
                f.seek(max(0, size - max_bytes))
                f.readline()  # discard partial line
            rest = f.read().decode("utf-8", errors="replace")
            for ln in rest.splitlines():
                ln = ln.strip()
                if ln:
                    tail_lines.append(ln)
    except Exception:
        pass
    return first_line, tail_lines


def _inspect_conversation(conv_dir: Path, now: float) -> Optional[Dict[str, Any]]:
    transcript = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
    if not transcript.is_file():
        return None

    try:
        st = transcript.stat()
        mtime = st.st_mtime
    except OSError:
        return None

    first_line, tail_lines = _read_tail_lines(transcript)
    entries: List[Dict[str, Any]] = []
    if first_line:
        try:
            entries.append(json.loads(first_line))
        except Exception:
            pass
    for ln in tail_lines:
        try:
            entries.append(json.loads(ln))
        except Exception:
            pass

    if not entries:
        return None

    conv_id = conv_dir.name
    initial_prompt = ""
    latest_focus = ""
    latest_tool = ""
    latest_tool_summary = ""
    latest_steps: List[Dict[str, str]] = []
    model_name = ""
    project_name = ""
    project_path = ""
    subagents: List[str] = []
    total_input_tokens = 0
    total_output_tokens = 0
    total_cached_tokens = 0
    step_count = 0
    last_status = "DONE"
    last_type = ""
    last_has_tool_calls = False
    last_ts = mtime

    for entry in entries:
        step_idx = entry.get("step_index")
        if isinstance(step_idx, int) and step_idx + 1 > step_count:
            step_count = step_idx + 1

        etype = entry.get("type", "")
        estatus = entry.get("status", "")
        if estatus:
            last_status = estatus
        if etype:
            last_type = etype
        last_has_tool_calls = bool(entry.get("tool_calls"))

        ets = _parse_iso_ts(entry.get("created_at"))
        if ets:
            last_ts = max(last_ts, ets)

        if entry.get("model"):
            model_name = str(entry["model"])

        if isinstance(entry.get("input_tokens"), int):
            total_input_tokens += entry["input_tokens"]
        if isinstance(entry.get("output_tokens"), int):
            total_output_tokens += entry["output_tokens"]
        if isinstance(entry.get("cache_read_tokens"), int):
            total_cached_tokens += entry["cache_read_tokens"]

        if etype == "USER_INPUT" and not initial_prompt:
            initial_prompt = _clean_user_prompt(str(entry.get("content", "")))

        tool_calls = entry.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                tname = str(tc.get("name", ""))
                args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                if tname == "update_focus":
                    f = _strip_quotes(args.get("focus", ""))
                    if f:
                        latest_focus = f
                elif tname == "update_steps":
                    raw_steps = args.get("steps")
                    if isinstance(raw_steps, str):
                        try:
                            raw_steps = json.loads(raw_steps)
                        except Exception:
                            raw_steps = None
                    if isinstance(raw_steps, list):
                        parsed_steps = []
                        for s in raw_steps:
                            if isinstance(s, dict) and s.get("title"):
                                parsed_steps.append({
                                    "title": str(s.get("title", "")),
                                    "status": str(s.get("status", "pending")),
                                })
                        if parsed_steps:
                            latest_steps = parsed_steps
                elif tname == "invoke_subagent":
                    role = _strip_quotes(args.get("Role", ""))
                    if role and role not in subagents:
                        subagents.append(role)
                else:
                    if tname:
                        latest_tool = tname
                    summary = _strip_quotes(args.get("toolSummary", ""))
                    if summary:
                        latest_tool_summary = summary

                # Infer project from file paths or Cwd
                for key in ("Path", "Cwd", "SearchPath", "DirectoryPath", "TargetFile"):
                    if key in args:
                        proj = _extract_project_from_path(args[key])
                        if proj:
                            project_name = proj
                            raw_p = _strip_quotes(args[key])
                            if raw_p.startswith("/"):
                                p_obj = Path(raw_p)
                                project_path = str(p_obj if p_obj.is_dir() else p_obj.parent)

    age_seconds = max(0.0, now - mtime)

    # Determine agent state accurately
    if last_status == "ERROR":
        state = "ERROR"
    elif last_status not in ("DONE", "COMPLETED", "CANCELLED"):
        state = "ACTIVE"
    elif last_type == "PLANNER_RESPONSE" and not last_has_tool_calls:
        # Agent finished its turn and replied to the user
        state = "IDLE"
    elif age_seconds <= 45:
        state = "ACTIVE"
    elif age_seconds <= 900:
        state = "STANDBY"
    else:
        state = "IDLE"

    # Determine current task description
    in_progress_step = next((s["title"] for s in latest_steps if s.get("status") == "in_progress"), "")
    if state == "ACTIVE":
        current_task = latest_focus or in_progress_step or latest_tool_summary or (f"Running {latest_tool}" if latest_tool else "") or initial_prompt or "Processing request"
    else:
        current_task = in_progress_step or latest_focus or initial_prompt or latest_tool_summary or "Completed session"

    # Collect artifacts in this conversation's brain directory
    artifacts: List[Dict[str, Any]] = []
    try:
        for item in sorted(conv_dir.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
            if item.name.startswith(".") or item.name in ("scratch", "browser_sandbox"):
                continue
            if item.is_file() and not item.name.endswith(".metadata.json"):
                try:
                    artifacts.append({
                        "name": item.name,
                        "path": str(item),
                        "size": item.stat().st_size,
                    })
                except OSError:
                    pass
    except Exception:
        pass

    github_url = _find_github_url(project_path, project_name)
    actions_url = f"{github_url}/actions" if github_url else ""
    actions_running = _check_github_actions_running(github_url) if github_url else False

    return {
        "id": conv_id,
        "shortId": conv_id[:8].upper(),
        "project": project_name or "Global / Unassigned",
        "projectPath": project_path,
        "githubUrl": github_url,
        "actionsUrl": actions_url,
        "actionsRunning": actions_running,
        "state": state,
        "task": current_task,
        "prompt": initial_prompt or "Untitled operation",
        "model": model_name or "unknown",
        "steps": latest_steps,
        "stepCount": step_count,
        "lastTool": latest_tool_summary or latest_tool or "",
        "subagents": subagents,
        "artifacts": artifacts[:20],
        "artifactCount": len(artifacts),
        "tokens": {
            "input": total_input_tokens,
            "output": total_output_tokens,
            "cached": total_cached_tokens,
        },
        "ageSeconds": round(age_seconds, 1),
        "updatedAt": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
    }


def scan_agents(limit: int = 40, state_filter: str = "all") -> Dict[str, Any]:
    now = time.time()
    agents: List[Dict[str, Any]] = []
    errors: List[str] = []

    if not BRAIN_DIR.exists():
        msg = f"Brain directory does not exist: {BRAIN_DIR}"
        logger.error(msg)
        errors.append(msg)
    elif BRAIN_DIR.is_dir():
        candidates = []
        try:
            for child in BRAIN_DIR.iterdir():
                if not child.is_dir() or child.name.startswith("."):
                    continue
                tpath = child / ".system_generated" / "logs" / "transcript.jsonl"
                if tpath.is_file():
                    try:
                        candidates.append((tpath.stat().st_mtime, child))
                    except OSError as exc:
                        msg = f"stat failed for {child.name}: {exc}"
                        logger.warning(msg)
                        errors.append(msg)
        except PermissionError as exc:
            msg = f"Permission denied reading {BRAIN_DIR}: {exc}"
            logger.error(msg)
            errors.append(msg)
        except Exception as exc:
            msg = f"Failed scanning {BRAIN_DIR}: {exc}"
            logger.exception(msg)
            errors.append(msg)

        candidates.sort(key=lambda x: x[0], reverse=True)
        for _, conv_dir in candidates[: max(limit, 50)]:
            try:
                info = _inspect_conversation(conv_dir, now)
                if info:
                    agents.append(info)
            except Exception as exc:
                msg = f"Error inspecting {conv_dir.name}: {exc}"
                logger.exception(msg)
                errors.append(msg)

    summary = {
        "total": len(agents),
        "active": sum(1 for a in agents if a["state"] == "ACTIVE"),
        "standby": sum(1 for a in agents if a["state"] == "STANDBY"),
        "idle": sum(1 for a in agents if a["state"] == "IDLE"),
        "error": sum(1 for a in agents if a["state"] == "ERROR"),
    }

    if state_filter == "active":
        filtered = [a for a in agents if a["state"] in ("ACTIVE", "ERROR")]
    elif state_filter == "recent":
        filtered = [a for a in agents if a["state"] in ("ACTIVE", "STANDBY", "ERROR")]
    else:
        filtered = agents

    return {
        "timestamp": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
        "brainDir": str(BRAIN_DIR),
        "logPath": str(LOG_PATH),
        "errors": errors,
        "summary": summary,
        "agents": filtered[:limit],
    }


def get_conversation_feed(conv_id: str, limit: int = 20) -> Dict[str, Any]:
    conv_dir = BRAIN_DIR / conv_id
    transcript = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
    events: List[Dict[str, Any]] = []
    if transcript.is_file():
        _, tail_lines = _read_tail_lines(transcript, max_bytes=262144)
        for ln in tail_lines[-limit:]:
            try:
                e = json.loads(ln)
            except Exception:
                continue
            tools = []
            if isinstance(e.get("tool_calls"), list):
                for tc in e["tool_calls"]:
                    if isinstance(tc, dict):
                        tname = str(tc.get("name", ""))
                        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                        summary = _strip_quotes(args.get("toolSummary", "")) or _strip_quotes(args.get("focus", ""))
                        tools.append(f"{tname}: {summary}" if summary else tname)
            content = str(e.get("content", ""))
            if e.get("type") == "USER_INPUT":
                content = _clean_user_prompt(content)
            else:
                content = re.sub(r"\s+", " ", content).strip()[:280]
            events.append({
                "step": e.get("step_index"),
                "type": e.get("type", ""),
                "status": e.get("status", ""),
                "time": e.get("created_at", ""),
                "tools": tools,
                "text": content,
            })
    return {"id": conv_id, "events": events}


def open_target(
    conv_id: str,
    project_path: str = "",
    open_folder: bool = False,
    action: str = "",
    artifact_path: str = "",
) -> Dict[str, Any]:
    copied = False
    opened_folder = False
    status_msg = ""
    try:
        subprocess.run(["pbcopy"], input=f"conversation://{conv_id}".encode("utf-8"), check=False, timeout=2)
        copied = True
    except Exception as exc:
        logger.warning("pbcopy failed: %s", exc)

    if action == "open_conversation":
        status_msg = f"Copied conversation://{conv_id} to clipboard"
    elif action == "open_artifact":
        target = Path(artifact_path) if artifact_path else (BRAIN_DIR / conv_id)
        if target.exists():
            try:
                subprocess.Popen(["open", str(target)])
                status_msg = f"Opened {target.name}"
            except Exception as exc:
                logger.warning("open artifact failed: %s", exc)
                status_msg = f"Failed to open {target.name}: {exc}"
        else:
            status_msg = f"Artifact not found: {target}"
    elif open_folder and project_path and Path(project_path).exists():
        try:
            subprocess.Popen(["open", project_path])
            opened_folder = True
            status_msg = "Opened project folder in Finder"
        except Exception as exc:
            logger.warning("open folder failed: %s", exc)

    return {
        "copied": copied,
        "openedFolder": opened_folder,
        "statusMsg": status_msg,
        "link": f"conversation://{conv_id}",
    }


def send_to_agent(conv_id: str, message: str, project_path: str = "") -> Dict[str, Any]:
    msg = message.strip()
    if not conv_id or not msg:
        return {"ok": False, "statusMsg": "Conversation ID and message are required."}
    agy_bin = os.environ.get("AGY_BIN", str(Path.home() / ".local" / "bin" / "agy"))
    if not Path(agy_bin).exists():
        agy_bin = "agy"
    cwd = project_path if (project_path and Path(project_path).is_dir()) else None
    try:
        log_f = open(LOG_PATH, "a", encoding="utf-8")
        subprocess.Popen(
            [agy_bin, "--conversation", conv_id, "-p", msg],
            cwd=cwd,
            stdout=log_f,
            stderr=log_f,
            start_new_session=True,
        )
        logger.info("Dispatched message to %s (cwd=%s): %s", conv_id, cwd, msg[:120])
        return {"ok": True, "statusMsg": "Message dispatched to agent — watch Live Feed for progress"}
    except Exception as exc:
        logger.exception("send_to_agent failed for %s", conv_id)
        return {"ok": False, "statusMsg": f"Failed to dispatch: {exc}"}


def load_app_html() -> str:
    html_path = Path(os.environ.get("SHIELD_APP_HTML", str(DEFAULT_HTML_PATH)))
    if html_path.is_file():
        return html_path.read_text(encoding="utf-8")
    return "<!doctype html><html><body><h1>S.H.I.E.L.D. UI bundle not found</h1></body></html>"


TOOLS = [
    {
        "name": "open_shield",
        "title": "S.H.I.E.L.D.",
        "description": "Open the S.H.I.E.L.D. live agent operations dashboard showing all running agents, their projects, states, and current tasks.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filter": {
                    "type": "string",
                    "enum": ["all", "active", "recent"],
                    "description": "Filter agents by state (default: all).",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of agents to return (default: 40).",
                },
            },
        },
        "_meta": {
            "ui": {"resourceUri": APP_URI},
            "com.google.antigravity/ui": {
                "entrypoints": [
                    {"type": "global", "title": "S.H.I.E.L.D."},
                    {"type": "aux_pane", "title": "S.H.I.E.L.D."},
                ]
            },
        },
    },
    {
        "name": "refresh_agents",
        "title": "Refresh S.H.I.E.L.D. telemetry",
        "description": "App-only tool to poll live agent telemetry from Antigravity.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filter": {"type": "string", "enum": ["all", "active", "recent"]},
                "limit": {"type": "integer"},
            },
        },
        "_meta": {
            "ui": {"visibility": ["app"]},
        },
    },
    {
        "name": "follow_agent",
        "title": "Follow agent conversation",
        "description": "App-only tool to fetch live conversation feed and optionally open its project folder.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "projectPath": {"type": "string"},
                "openFolder": {"type": "boolean"},
                "action": {"type": "string"},
                "artifactPath": {"type": "string"},
            },
            "required": ["id"],
        },
        "_meta": {
            "ui": {"visibility": ["app"]},
        },
    },
    {
        "name": "send_to_agent",
        "title": "Send message to agent",
        "description": "App-only tool to send a follow-up instruction directly to an agent conversation in the background.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "message": {"type": "string"},
                "projectPath": {"type": "string"},
            },
            "required": ["id", "message"],
        },
        "_meta": {
            "ui": {"visibility": ["app"]},
        },
    },
]

RESOURCES = [
    {
        "uri": APP_URI,
        "name": "S.H.I.E.L.D. Dashboard",
        "description": "Visual operations dashboard for monitoring active Antigravity agents.",
        "mimeType": "text/html;profile=mcp-app",
        "_meta": {"ui": {"prefersBorder": False}},
    }
]


def _send(msg: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def handle_request(req: Dict[str, Any]) -> None:
    req_id = req.get("id")
    method = req.get("method", "")
    params = req.get("params") or {}

    if method == "initialize":
        proto = params.get("protocolVersion", "2025-03-26")
        _send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": proto,
                "capabilities": {
                    "tools": {},
                    "resources": {},
                },
                "serverInfo": {"name": "shield", "version": "1.0.0"},
            },
        })
        return

    if method == "notifications/initialized":
        return

    if method == "ping":
        _send({"jsonrpc": "2.0", "id": req_id, "result": {}})
        return

    if method == "tools/list":
        _send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})
        return

    if method == "tools/call":
        name = params.get("name", "")
        args = params.get("arguments") or {}
        if name in ("open_shield", "refresh_agents"):
            state_filter = str(args.get("filter", "all"))
            limit = int(args.get("limit", 40))
            data = scan_agents(limit=limit, state_filter=state_filter)
            s = data["summary"]
            summary_text = (
                f"S.H.I.E.L.D. Telemetry: {s['active']} active, {s['standby']} standby, "
                f"{s['idle']} idle, {s['error']} error ({s['total']} total conversations)."
            )
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": summary_text}],
                    "structuredContent": data,
                },
            })
            return
        if name == "follow_agent":
            conv_id = str(args.get("id", ""))
            proj_path = str(args.get("projectPath", ""))
            open_folder = bool(args.get("openFolder", False))
            action_name = str(args.get("action", ""))
            artifact_path = str(args.get("artifactPath", ""))
            feed = get_conversation_feed(conv_id)
            action = open_target(conv_id, proj_path, open_folder, action_name, artifact_path)
            payload = {**feed, **action}
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Following {conv_id}"}],
                    "structuredContent": payload,
                },
            })
            return
        if name == "send_to_agent":
            conv_id = str(args.get("id", ""))
            message = str(args.get("message", ""))
            proj_path = str(args.get("projectPath", ""))
            res = send_to_agent(conv_id, message, proj_path)
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": res.get("statusMsg", "")}],
                    "structuredContent": res,
                },
            })
            return
        _send({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Unknown tool: {name}"},
        })
        return

    if method == "resources/list":
        _send({"jsonrpc": "2.0", "id": req_id, "result": {"resources": RESOURCES}})
        return

    if method == "resources/read":
        uri = params.get("uri", "")
        if uri == APP_URI:
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "contents": [
                        {
                            "uri": APP_URI,
                            "mimeType": "text/html;profile=mcp-app",
                            "text": load_app_html(),
                        }
                    ]
                },
            })
            return
        _send({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32002, "message": f"Resource not found: {uri}"},
        })
        return

    if req_id is not None:
        _send({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        })


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            handle_request(req)
        except Exception as exc:
            logger.error("Unhandled error in %s: %s\n%s", req.get("method"), exc, traceback.format_exc())
            if "id" in req:
                _send({
                    "jsonrpc": "2.0",
                    "id": req["id"],
                    "error": {"code": -32603, "message": str(exc)},
                })


if __name__ == "__main__":
    main()
