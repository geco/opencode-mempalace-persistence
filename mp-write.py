#!/usr/bin/env python3
"""One-shot MemPalace writer for a read-only MCP world.

When the MCP server runs with MEMPALACE_MCP_READ_ONLY=1 it never takes the
palace writer lease — which keeps `mempalace mine` free to drain the queue
while you work — but its mutating tools (diary_write, kg_add, …) are refused.
This script is the replacement write path: it calls the SAME tool functions
the MCP server calls, in a process that exits immediately, so the kernel
releases the flock in seconds instead of a session lifetime.

Usage:
  mp-write.py diary --agent NAME --entry TEXT [--topic TOPIC] [--wing WING]
  mp-write.py kg-add --subject S --predicate P --object O
  mp-write.py kg-invalidate --subject S --predicate P --object O [--ended DATE]
  mp-write.py kg-supersede --subject S --predicate P --old OLD --new NEW [--at DATE]
  mp-write.py add-drawer --wing W --room R --content TEXT
  mp-write.py --palace /path/to/palace <subcommand> ...   (non-default palace)

Exit codes: 0 written, 1 refused/failed after retries, 2 usage or environment
error. Stdout is one JSON object either way; errors are loud, never silent.

Contention: a Chroma write (diary, add-drawer) holds the flock for seconds.
If a mine holds it, retry a few times (~5 minutes total), then fail loudly
so the caller retries later. KG writes never touch the flock at all
(threading lock only), so kg-* subcommands do not retry — they either work
or the palace is genuinely broken.

Interpreter: needs the mempalace package, which pipx/uv keep isolated from
system python. If `import mempalace` fails, re-exec into the first venv
python that exists (MEMPALACE_PYTHON wins when set). Same pattern as
mine-detached.sh: no new dependencies, no daemons, no config.
"""

import json
import os
import sys
import time

RETRY_DELAYS = [10, 20, 40, 80, 160]


def ensure_mempalace() -> None:
    """Re-exec into a venv python that has mempalace, or fail loudly."""
    try:
        import mempalace  # noqa: F401
        return
    except ImportError:
        pass
    home = os.path.expanduser("~")
    candidates = []
    env_py = os.environ.get("MEMPALACE_PYTHON", "").strip()
    if env_py:
        candidates.append(env_py)
    candidates += [
        os.path.join(home, ".local/share/pipx/venvs/mempalace/bin/python"),
        os.path.join(home, ".local/share/uv/tools/mempalace/bin/python"),
    ]
    me = os.path.realpath(sys.argv[0])
    for cand in candidates:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            os.execv(cand, [cand, me] + sys.argv[1:])
    sys.stdout.write(
        json.dumps(
            {
                "success": False,
                "error": "mempalace package not importable: tried system python3, "
                "MEMPALACE_PYTHON and the pipx/uv venvs; install mempalace>=3.3.5",
            }
        )
        + "\n"
    )
    sys.exit(2)


def out(obj: dict, code: int) -> int:
    sys.stdout.write(json.dumps(obj) + "\n")
    return code


def call_chroma_write(fn):
    """Run fn() with retry on lock contention only. Anything else fails at
    once — waiting out a genuine error is just latency. Returns the tool's
    result dict, or a failure dict after ~5 minutes of contention."""
    last = None
    for attempt, wait in enumerate([0] + RETRY_DELAYS):
        if wait:
            time.sleep(wait)
        try:
            last = fn()
        except Exception as exc:  # noqa: BLE001 — report, don't crash
            if "MineAlreadyRunning" in type(exc).__name__:
                last = {"success": False, "error": f"another mine is in progress: {exc}"}
            else:
                return {"success": False, "error": f"{type(exc).__name__}: {exc}", "_fatal": True}
        if last.get("success"):
            return last
        err = str(last.get("error", ""))
        # Lock contention only: anything else fails at once, no point waiting.
        if "another mine is in progress" not in err and "held by" not in err:
            last["_fatal"] = True
            return last
        if attempt >= len(RETRY_DELAYS):
            break
    last = last or {}
    last["error"] = "palace busy for ~5 minutes, mine still running; retry later: " + str(last.get("error", ""))
    return last


def cmd_diary(args: list) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="mp-write.py diary")
    p.add_argument("--agent", required=True)
    p.add_argument("--entry", required=True)
    p.add_argument("--topic", default="general")
    p.add_argument("--wing", default="")
    ns = p.parse_args(args)

    from mempalace.mcp_server import tool_diary_write

    res = call_chroma_write(lambda: tool_diary_write(ns.agent, ns.entry, ns.topic, ns.wing))
    res.pop("_fatal", None)
    return out(res, 0 if res.get("success") else 1)


def cmd_kg_add(args: list) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="mp-write.py kg-add")
    p.add_argument("--subject", required=True)
    p.add_argument("--predicate", required=True)
    p.add_argument("--object", required=True)
    ns = p.parse_args(args)

    # Same function the MCP server calls, minus dispatch and lease logic.
    # KG lives in its own sqlite with a threading lock only: no flock, no
    # contention with mines, no retries needed.
    from mempalace.mcp_server import tool_kg_add

    try:
        res = tool_kg_add(ns.subject, ns.predicate, ns.object)
    except Exception as exc:  # noqa: BLE001
        return out({"success": False, "error": f"{type(exc).__name__}: {exc}"}, 1)
    if isinstance(res, dict) and res.get("success", True) is False:
        return out(res, 1)
    return out(res if isinstance(res, dict) else {"success": True, "result": res}, 0)


def cmd_kg_invalidate(args: list) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="mp-write.py kg-invalidate")
    p.add_argument("--subject", required=True)
    p.add_argument("--predicate", required=True)
    p.add_argument("--object", required=True)
    p.add_argument("--ended", default=None)
    ns = p.parse_args(args)

    from mempalace.mcp_server import tool_kg_invalidate

    try:
        res = tool_kg_invalidate(ns.subject, ns.predicate, ns.object, ns.ended)
    except Exception as exc:  # noqa: BLE001
        return out({"success": False, "error": f"{type(exc).__name__}: {exc}"}, 1)
    if isinstance(res, dict) and res.get("success", True) is False:
        return out(res, 1)
    return out(res if isinstance(res, dict) else {"success": True, "result": res}, 0)


def cmd_kg_supersede(args: list) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="mp-write.py kg-supersede")
    p.add_argument("--subject", required=True)
    p.add_argument("--predicate", required=True)
    p.add_argument("--old", required=True)
    p.add_argument("--new", required=True)
    p.add_argument("--at", default=None)
    ns = p.parse_args(args)

    from mempalace.mcp_server import tool_kg_supersede

    try:
        res = tool_kg_supersede(ns.subject, ns.predicate, ns.old, ns.new, ns.at)
    except Exception as exc:  # noqa: BLE001
        return out({"success": False, "error": f"{type(exc).__name__}: {exc}"}, 1)
    if isinstance(res, dict) and res.get("success", True) is False:
        return out(res, 1)
    return out(res if isinstance(res, dict) else {"success": True, "result": res}, 0)


def cmd_add_drawer(args: list) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="mp-write.py add-drawer")
    p.add_argument("--wing", required=True)
    p.add_argument("--room", required=True)
    p.add_argument("--content", required=True)
    ns = p.parse_args(args)

    from mempalace.mcp_server import tool_add_drawer

    # Chroma write like diary: same lock, same retry.
    res = call_chroma_write(lambda: tool_add_drawer(ns.wing, ns.room, ns.content))
    res.pop("_fatal", None)
    return out(res, 0 if res.get("success") else 1)


def main(argv: list) -> int:
    palace = None
    rest = argv
    if rest[:1] == ["--palace"]:
        if len(rest) < 3:
            return out({"success": False, "error": "usage: --palace PATH <diary|kg-add> ..."}, 2)
        palace = rest[1]
        rest = rest[2:]
    if palace:
        # Read by MempalaceConfig before any mempalace import below.
        os.environ["MEMPALACE_PALACE_PATH"] = os.path.abspath(os.path.expanduser(palace))
    ensure_mempalace()
    cmds = ("diary", "kg-add", "kg-invalidate", "kg-supersede", "add-drawer")
    if not rest or rest[0] not in cmds:
        return out({"success": False, "error": "usage: mp-write.py [--palace P] <diary|kg-add|kg-invalidate|kg-supersede|add-drawer> ..."}, 2)
    if rest[0] == "diary":
        return cmd_diary(rest[1:])
    if rest[0] == "kg-invalidate":
        return cmd_kg_invalidate(rest[1:])
    if rest[0] == "kg-supersede":
        return cmd_kg_supersede(rest[1:])
    if rest[0] == "add-drawer":
        return cmd_add_drawer(rest[1:])
    return cmd_kg_add(rest[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
