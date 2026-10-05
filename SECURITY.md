# Security Policy

## Supported Versions

Only the latest npm release (`latest` tag) is supported. Older versions do
not receive fixes — upgrade with the TUI's plugin update command or
`rm -rf ~/.cache/opencode/npm/opencode-mempalace-persistence@latest` plus a
restart.

## Reporting a Vulnerability

Use GitHub's **private vulnerability reporting** on the repository
(Security tab → Report a vulnerability). Do not open a public issue for
anything that could put users at risk.

What to include: affected version, what you did, what you expected, what
happened instead, and whether local files outside `~/.mempalace/` were
touched (they never should be — the plugin writes only there).

## Scope notes

- The plugin spawns only `mempalace` CLI processes and short-lived wrapper
  scripts it ships (`mine-detached.sh`, `mp-write.py`). It never downloads
  or executes remote code.
- On startup it terminates only its own orphaned detached-mine wrappers
  (cmdline match + orphan check, children first). It never signals
  anything else.
- The auto-registered MCP entry is read-only; the plugin never writes the
  user's `opencode.jsonc`.
