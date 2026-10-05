# opencode-mempalace-persistence

> **Community plugin** — not officially maintained by the MemPalace team. Fully open source.

An OpenCode plugin that automatically saves every conversation to MemPalace and uses stored memory to provide better, context-aware responses. Mines run on idle, exit and startup — never mid-reply — with zero cron and zero external scripts.

Follows the official MemPalace automation pattern (same as the Claude Code hooks): the plugin decides **when** to save, the model decides **what** to file via `mp-write.py` one-shots (the bundled MCP server is read-only by design).

[![npm version](https://img.shields.io/npm/v/opencode-mempalace-persistence.svg)](https://www.npmjs.com/package/opencode-mempalace-persistence)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mempalace-persistence.svg)](https://www.npmjs.com/package/opencode-mempalace-persistence)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![HOL Guard Scanner](https://img.shields.io/badge/HOL%20Guard-passing-00a67e)](https://github.com/hashgraph-online/hol-guard)

![Demo: a decision filed on Monday is recalled verbatim by a different session on Thursday — memory outlives sessions, not just compaction](demo.gif)

---

## How it works in 3 seconds

| Without plugin | With plugin |
|---|---|
| Every session starts from scratch | The model knows who you are and what you've done |
| You repeat context each time | Memory is automatic |
| Model starts from scratch each time | Memory persists across sessions |

The plugin saves every completed turn to MemPalace (mined on idle, exit
and startup) and gives the model recall (question-driven search via the
bundled skill and MCP reads, or injected identity + memories with
`autoInjectContext`). A feedback loop with no extra AI calls.

---

## Installation

Zero-config: install the plugin and the palace, nothing else to wire.

### 1. Plugin (saves conversations)

```json
{
  "plugin": ["opencode-mempalace-persistence"]
}
```

Add this line to your `~/.config/opencode/opencode.json` and restart OpenCode.

Works on **OpenCode v1 (>= 1.18.29) and v2** — the package ships a dual
entrypoint (`server()` for v1, `Plugin.define({ id, setup })` for v2), so the
same install works before and after you move to v2. One caveat on v2: the
plugin runs in the server runtime, which has no `tui.showToast`, so TUI
toasts are silent there — `hook.log`, `interactions.log`, `/memory-status`
and `/memory-log` are unaffected.

The transcript export reads **both** database layouts, so a v1 → v2
migration never strands messages: v2 sessions (`session_v2` +
`session_message`, human turn in `data.text`, replies in `data.content[]`)
and v1 sessions (`session` + `message` + `part`) are unioned by session id,
with v2 winning where both exist. Sessions still readable only in the v1
tables (e.g. one created by v1 right before the switch) are exported too.

### 2. Identity (who you are)

Create `~/.mempalace/identity.txt`:

```
I am [name], a [role]. I work with [technologies]. My main projects are [projects].
```

This file is loaded by the plugin — no need to add it to `instructions` in opencode.json.

### 3. MemPalace (if not already installed)

```bash
# Install (requires mempalace>=3.3.5 for HNSW corruption fix)
uv tool install "mempalace>=3.3.5"
# or
pipx install "mempalace>=3.3.5"

# Create palace
mempalace init ~/opencode-memory
```

Then the MCP server — recall for the model — needs no configuration either.
On startup the plugin ensures a correct `mempalace` entry exists (same
pattern as `nguyentamdat/opencode-mempalace`, via the `config` hook on v1
and `ctx.mcp.transform` on v2): missing entries are registered, present
ones are **repaired** (broken command repointed to the working binary,
read-only env added), custom keys (`cwd`, `timeout`, …) preserved. The
file on disk is never rewritten — the correction applies in memory at
load and is logged every time. To keep a hand-managed entry fully
untouched (writer included), set `MEMPALACE_MCP_MANUAL=1` in the server
environment.

That entry is read-only (`MEMPALACE_MCP_READ_ONLY`): a writer MCP takes
the palace lock for its whole lifetime and starves mining — with one tab
occasionally, with two tabs (one MCP server each) as the rule. Reads
never need the lock, so recall is unaffected; writes go through the
bundled `mp-write.py` one-shots instead (synced to
`~/.mempalace/mp-write.py` on startup, same functions the MCP server
calls, seconds-long processes).

Restart OpenCode after editing.

### 4. Plugin config (all optional)

No config file is needed to start: every setting has a default, and **not
creating anything means all defaults**. When you want to change one,
create `~/.mempalace/plugin-config.json`:

```json
{
  "autoInjectContext": false,
  "saveInterval": 15,
  "toasts": true
}
```

| Key | Default | What it does |
|---|---|---|
| `autoInjectContext` | `false` | Inject identity + `mempalace search` results into every prompt. Needs no model discipline, but adds context (and noise) to every turn. Off by default: recall happens via the skill instead |
| `saveInterval` | `15` (min `5`) | Human messages between AI checkpoints — same cadence as the official MemPalace save hook |
| `toasts` | `true` | TUI toasts for mines, checkpoints and MemPalace calls. Set `false` to silence them |

**Do NOT put this in `opencode.json`** — OpenCode's schema validation rejects unknown keys. The plugin reads its config from `~/.mempalace/plugin-config.json` instead.

When `autoInjectContext` is enabled:
- **First message**: Injects your identity from `~/.mempalace/identity.txt`
- **Every message**: Runs `mempalace search` and injects relevant results

#### AGENTS.md (minimal — recall lives in the skill)

Create `~/.config/opencode/AGENTS.md`:

```markdown
# Memory & Knowledge instructions

## Recall (via skill, unless auto-inject is on)

Recall follows the bundled `mempalace-recall` skill (question-driven
search). If you enabled `autoInjectContext`, identity + relevant memories
are additionally injected into every prompt — then only search MemPalace
yourself when the question is about past work, decisions, people, or
projects AND the injected context has nothing. Either way, quote results
verbatim, never paraphrase.

## Record facts (after responding, only when something new emerged)

Writes go through `~/.mempalace/mp-write.py` (the MCP server is read-only
by design — see §3):

- Durable outcomes (decisions, conclusions, learned facts):
  `mp-write.py add-drawer --wing <w> --room <r> --content <text>`.
- New KG facts: `mp-write.py kg-add --subject <s> --predicate <p> --object <o>`
  (128 chars or fewer).
- Changed single-valued fact:
  `mp-write.py kg-supersede --subject <s> --predicate <p> --old <o> --new <n>`.
- Ended fact: `mp-write.py kg-invalidate --subject <s> --predicate <p> --object <o>`.
- Session journal:
  `mp-write.py diary --agent <name> --topic <topic> --entry <text>`.

Record facts you are confident about. Prefer quality over quantity;
noisy entries degrade retrieval over time. Don't file secrets or tokens.

### Naming reminder
Reads use the prefix `mempalace_mempalace_*` (not `mempalace_*`). Examples:
- `mempalace_mempalace_search` (NOT `mempalace_search`)
- `mempalace_mempalace_kg_query`
- `mempalace_mempalace_diary_read`
If you ever catch yourself typing `mempalace_search`, STOP — the correct prefix is `mempalace_mempalace_`.
Writes do NOT go through MCP tools (`..._diary_write`, `..._kg_add` are
refused: the server is read-only) — they go through `mp-write.py` above.
```

#### Complete `~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-mempalace-persistence"],
  "instructions": ["AGENTS.md"]
}
```

No `mcp` block needed: the plugin registers its own read-only entry on
startup (manual entries still win — see §3). If you want the old manual
wiring instead, add it explicitly:

```jsonc
"mcp": {
  "mempalace": {
    "type": "local",
    "command": ["/home/YOU/.local/bin/mempalace-mcp"],
    "enabled": true
    // NOTE: at load the plugin repairs this entry (working binary +
    // read-only env) unless MEMPALACE_MCP_MANUAL=1 is set — see §3.
    // A bare writer entry holds the palace lock for the session lifetime
    // and idle mines will wait behind it (with two tabs, almost always).
  }
}
```

> Note: `identity.txt` is NOT listed in `instructions` — the plugin injects it automatically. It is also NOT in the `provider` block or `permission` block — those are optional and depend on your model setup.

#### Recall skill (bundled, Claude-style)

The repo ships `skills/mempalace-recall/SKILL.md` — the question-driven
search-before-answer protocol, adapted from the official MemPalace skill
for OpenCode (including the `mempalace_mempalace_*` tool-prefix note).
Install it where OpenCode loads skills from:

```bash
mkdir -p ~/.config/opencode/skills/mempalace-recall
cp skills/mempalace-recall/SKILL.md ~/.config/opencode/skills/mempalace-recall/
```

The model then loads it on demand whenever a question touches past work,
decisions, people, or projects — same mechanism as the Claude skill.
No AGENTS.md changes needed beyond the minimal block above.

---

## What happens after installation

```
You ask a question
  → Plugin hooks into `experimental.chat.messages.transform`
  → Injects your identity + relevant memories from MemPalace
    (when autoInjectContext is on; otherwise recall is question-driven
    via the bundled skill and MCP reads)
  → Every ~15 messages: injects a [MemPalace Checkpoint] block
  → Model files topics/decisions/quotes via ~/.mempalace/mp-write.py,
    then answers

The model responds
  → Once the turn completes, the next idle/exit/startup mines it to MemPalace (flat export, no hardcoded wings)
  → Model records new KG facts via mp-write.py (only when something new emerged)

Session goes idle / process exits
  → Background mine of everything new since last sync (per-wing cursors:
  each wing advances independently, so one slow wing never stalls the rest)
  → TUI toast confirms what was mined (disable with `"toasts": false`)

Every MemPalace call — plugin searches, model MCP reads (search, diary_read,
KG) — also raises a short TUI toast with what was asked and a result
preview, so background memory activity is always visible. A startup toast
shows the loaded plugin version (`opencode-mempalace-persistence v4.0.0
loaded`, with pending backlog when there is one), so you always know
whether you're running the npm release or a local build.

Lock contention is a solved problem, not a state to manage. The MCP
servers the plugin registers are read-only, so they never hold the palace
lock; the only writers are short-lived processes (CLI mines, mp-write.py
one-shots), which serialize through the lock in seconds. Two tabs mean
two readers, not two contenders — the tab starvation that motivated v4
cannot happen. A leftover writer MCP (manual entry, or a dying server
releasing the flock) is the only remaining source of `wait`, and it
resolves on its own: in-session mines retry with backoff, exit mines
retry for 30 minutes.

Compaction starts
  → [MemPalace Pre-Compact Emergency Save]: model files everything first
  → Identity + wake-up context re-attached so the summary cannot lose them

Next time you ask
  → Plugin finds the previous memory → injects it automatically
  → The cycle continues, memory grows
```

---

## What gets saved

Every turn (question + answer) is saved as a drawer in MemPalace. Mining runs with `--mode convos` (default `exchange` extraction: one drawer per exchange pair, verbatim, no paraphrasing). Exports are grouped one wing per project (official multi-project pattern: `bot-oc` sessions land in wing `bot-oc`, never leaking across projects). Only completed turns are exported (in-flight replies are revisited by the next sync). The model additionally records KG facts (decisions, milestones, preferences) during conversation and at each checkpoint via `mp-write.py`.

### Message-level dedup

Each opencode message is exported **exactly once ever**. A message is skipped if its content is either already in the palace (`mined_ids` in `sync_state.json`, recorded when a mine succeeds) or still waiting in the queue. This kills the main duplicate source mempalace's file-level dedup cannot catch — repeated boilerplate (e.g. system prompts re-sent every turn) landing in different export files. (`mempalace dedup` only compares drawers from the *same* source file, so it can't fix that either.)

The "still in the queue" half is **read back from the queue files themselves**, not remembered in the state file. Every export ends with a trailer:

```
<!-- mp-ids: msg_0f1b9…,msg_0f1ba…,msg_0f1bb… -->
```

so the plugin can rebuild the set of queued messages by reading the files. One trailer line per file, not an id per message inline, so the transcript itself stays verbatim.

That choice is deliberate. The obvious alternative — keeping the same ids in `sync_state.json` — drifts the moment anything touches the queue outside the plugin (a manual cleanup, a disk purge, a run killed between write and bookkeeping). A stale set makes the plugin believe a message is queued when its file is gone, and that content is then never exported again: silent, permanent, with no error anywhere. Deriving the set from the files makes that impossible, and deleting a file by hand immediately frees its messages. Cost is one tail read per queued file, once per sync.

A file with no trailer — anything written by 2.x — contributes nothing, which errs toward re-exporting (duplicate memory) rather than losing it.

### Filenames are content-addressed

```
sync_<session-id-prefix>_<sha256-of-transcript[0:12]>.txt
```

The hash covers **only the transcript**, and the filename carries no date and no title. Both were volatile: the same window re-exported on a different day hashed differently and became a *new* file instead of overwriting the old one. That is how one session ended up as three near-identical files in the queue (116 sections, then 137, then 116 again — two of them byte-identical but for the date line).

Nothing is lost by taking them out: title, session and date stay in the file header, and the date is named `Last verified:` because that is what it is — the last time the window was confirmed, rewritten on every re-export. Calling it `Date:` implied a creation date it never had.

A filename has to be a function of the content, or deduplication cannot work at all. It also makes a *growing* window correct: new messages mean a new hash, so a new file, disjoint from the previous one by construction.

### The cursor means "exported", not "mined"

The per-wing cursor advances **when an export file is written**, not when its mine succeeds. That distinction is the whole ballgame:

- The export is cheap and idempotent — same content produces the same filename, so a re-export overwrites itself.
- The mine is expensive and fails for reasons outside the plugin's control (palace lock held by another writer, killed at exit, OOM).

An earlier version advanced the cursor only after a successful mine. A mine that never finished therefore pinned the cursor forever: every later export re-cut its window from the same stale point, and because the session kept growing, each file was a **superset** of the previous one. One long-running session produced 691 overlapping files, and mining them all multiplied every message by up to 691 — 628k drawers, 5 GB, with no error anywhere.

With the cursor on write, windows are always disjoint: the next export starts where the last one stopped. A failed mine loses nothing — **the pending file *is* the queue**, and the next mine picks it up untouched.

The cursor also advances when a window turns out to be *entirely* already in the queue, even though no file was written. Without that, a wing whose window is fully covered would re-read the same messages on every sync forever and never write anything again.

One clamp remains, and it is the residual cause of the 691-file blow-up: if a reply looks in-flight, the cursor is pulled back to just before it, so the next sync re-cuts that window. It is time-bounded (a reply with no new content for 30 minutes is treated as dead and exported as-is), which is why it only bites while something is actively streaming. Combined with content-addressed filenames and the queued-message filter, a re-cut window is now a no-op instead of a new pile of files.

If the queue stops draining (mines blocked or too slow), `hook.log` gets a `WARNING: N exported files waiting to be mined` line, visible in `/memory-status`. Silence there is what hid the blow-up.

Every mine covers every wing with pending files, not just fresh exports: mining fresh-only stranded failures forever (cursor past, never reselected, never retried). On a wing's success the whole directory is deleted and fresh ids plus deleted-file trailers are committed together.

### If you purge the palace by hand

`mined_ids` is a claim about the palace: "this message's content was filed". Delete drawers manually — by `source_file`, by age, whatever — and that claim becomes false while the plugin still believes it, so those messages will not be exported again.

After a manual purge, clear the affected entries from `mined_ids` in `~/.mempalace/sync_state.json`, or delete the whole file to rebuild from scratch (the cost is re-exporting and re-mining recent history, not data loss). Keeping the ids per message rather than per file is what makes a selective repair possible.

### Backfill existing sessions

To mine the full opencode history once (e.g. on first install):

```bash
OPENCODE_MEMPALACE_BACKFILL=1 opencode
```

The plugin exports everything in the opencode database on the next sync, then resumes incremental mode. Mining is idempotent — re-running is safe.

### Durability notes (drawers vs KG)

- **Drawers** (transcripts) are append-mostly: a crash mid-mine can only leave already-filed content behind, never corrupt what's stored. Re-running the mine is always safe.
- **KG facts** live a different life: `kg_supersede` replaces a fact atomically at a shared boundary (single transaction) — a mid-write crash rolls back to the *old* fact: stale but present, never half-written.
- **Reads are validity-window only**: there is no liveness check on read, so a stale fact reads as current until the model revisits it (via checkpoint, diary review, or a new decision on the same subject).
- **Backfill mines transcripts into drawers only** — it never touches the KG. KG facts come exclusively from live `mp-write.py` calls (conversation, checkpoints, diary). A crashed supersede therefore waits for the next model touch, not the next backfill.

---

## Architecture

```
                 ┌──────────────────────────────┐
                 │         OpenCode              │
                 │                               │
  User msg ─────►│  experimental.chat.messages   │
                 │  .transform hook              │
                 │    ↓                          │
                 │  Injects identity + memories  │
                 │  (autoInjectContext: true)    │
                 │    ↓                          │
                 │  Model sees context → answers │
                 │    ↓                          │
  Answer done ──►│  chat.message (count) + session.idle   │
                 │  mine on idle / exit / startup           │
                 │    ↓                                     │
                 │  Query OpenCode DB (completed turns)     │
                 │    ↓                                     │
                 │  Export → flat text files (0700)         │
                 │    ↓                                     │
                 │  mempalace mine --mode convos            │
                 │  single serialized call                  │
                 └──────────────────────────────────────────┘
                            │
                            ▼
                 ┌──────────────────────────┐
                 │      MemPalace            │
                 │  ~/opencode-memory/       │
                 │  Vector DB + KG           │
                 └──────────────────────────┘
                            ▲
                            │
                 ┌──────────────────────────┐
                 │  Model writes via           │
                 │  ~/.mempalace/mp-write.py │
                 │  diary / kg-* / add-drawer│
                 └──────────────────────────┘
```

Reads (search, diary_read, kg_query) go through the MCP server, which
the plugin auto-registers read-only (repaired if you have your own
entry): readers never hold the palace lock, so two tabs mean two
readers, not two contenders. See §3.

---

## Relevant files

| File | Purpose |
|---|---|
| `~/.config/opencode/opencode.json` | Plugin entry (MCP auto-registered read-only, repaired if present) |
| `~/.config/opencode/AGENTS.md` | Tells the model to manage KG facts via `mp-write.py` |
| `~/.mempalace/mp-write.py` | One-shot writer (synced from the package on startup): diary, kg-*, add-drawer |
| `~/.mempalace/plugin-config.json` | Plugin config (`autoInjectContext`, `saveInterval`, `toasts` — all optional, see §4) |
| `~/.config/opencode/skills/mempalace-recall/SKILL.md` | Bundled recall skill (copy from `skills/` in this repo) |
| `~/.mempalace/identity.txt` | Your identity (injected by plugin) |
| `~/.mempalace/hook_state/opencode_counters.json` | Per-session message counters (checkpoint cadence) |
| `~/.mempalace/hook_state/hook.log` | Checkpoint / pre-compact event log (errors always land here) |
| `~/.mempalace/oc-sessions/` | Private (0700) export workspace for pending transcripts |
| `~/.mempalace/config.json` | MemPalace config (palace path) |
| `~/.mempalace/knowledge_graph.sqlite3` | Knowledge Graph (structured facts) |
| `~/opencode-memory/` | MemPalace vector DB (all drawers) |
| `~/.mempalace/sync_state.json` | Per-wing cursors + mined message IDs |
| `~/.mempalace/hook_state/status.json` | One small JSON the TUI status line polls (phase, queue depth, last event) |

---

## Status line in the TUI (OpenCode v2)

The plugin ships a second entry point, `tui.tsx`, that claims the sidebar footer:

```
◆ MP mining 4/10 q8 w2/2 6m +1,240d
[██████████▓▓▓░░░░░░░░░░░░░] v4.0.0
```

Two lines. Line 1 is compact tokens: `◆` semaphore (green idle, blue mining, yellow queue/busy, red error), `MP` tag, phase, files completed over files in the current wing (`4/10`, bare — the q- and w- prefixes mark the other counters), files queued live (`q8`), wing over wings (`w2/2`, always shown — `w1/1` confirms the run was scoped), elapsed of this run (`6m`), drawers gained (`+1,240d`, single-letter unit like the rest). While backed off waiting for the lock the frozen counters drop out and only the clock stays: `◆ MP mining w2/2 6m waiting`. No holder, no pid — on a transient holder a pid is already dead when you read it, on a stuck one it is in `/memory-log` where it belongs. Other states: `◆ MP queue q6 waiting 146h` (nothing has tried yet), `◆ MP busy q1 21m` (a mine gave up: the lock was held, a later trigger retries), `◆ MP error q1 21m` (a real failure — read `/memory-log`), and idle with the last completed run (`◆ MP idle 9fl 2wn - 25m ago +1,240dr`, persisted across restarts — or plain `◆ MP idle` with no recorded run).

A third line appears above them, only while a palace read is in flight:

```
◇ MP searching "asdfasdf asdf asdf.."
```

`◇` hollow diamond (same family as `◆`, hollow because transient), query text capped at 18 chars so the line stays within ~37 columns and never wraps (`..` inside the quotes, only when truncated). Driven by `execute.before`/`after` hooks around an explicit read-tool allowlist (`search`, `diary_read`, `kg_query`, …); writes are excluded on purpose (recording is not querying). The footer polls every second, so sub-second queries rarely render mid-flight — multi-second searches do. Mining keeps priority: a query never replaces the mining line.

With no query running, the same row shows the last completed read, if any (muted: history, not activity):

```
◇ MP last search: 2m ago (5 res)
```

Tool, age and result count (parsed from the result's `results` array; omitted when unparseable rather than invented). Session-scoped, not persisted: after a restart there is no last search until the first one.

Line 2 is a REAL fraction — completed files over total files of the run, queued arrivals included — not a gauge. What the bar shows is **queue depth, not progress** is over: the old gauge filled with the queue and could never drain visually. A percentage was tried first and was wrong (`mempalace mine` is a black box: no total to divide by, so an animated 0→100 loop read as a job stuck at 99%). A fraction of files is exact; a percentage of "done" would be invented. The `▓▓▓` window sweeps while mining so a slow batch (minutes between commits) still looks alive. Idle the bar always sits empty — even with nothing queued, where a full bar read as garish: "done" is said by the idle line (last run summary below), and the accent-colored fill is then unmistakably the "executing" state. After the closing bracket, the loaded plugin version (` v4.0.0`, parsed from the status file the server already writes) — same answer as the startup toast, always visible.

Per-FILE completion does not come from the mine: the miner walks the files silently (`for i, filepath in enumerate(files, 1)` — it knows, it just never says) and only the final summary reports. It comes from the palace instead: every filed drawer records its `source_file` plus the file's `chunk_total`, so intersecting the wing directory with the filed set tells exactly which files are done — with zero mine overhead. A read-only `COUNT(*)` plus one grouped metadata query, polled every 3s while a mine runs. Anything unreadable degrades to elapsed-time-only.

This is also why per-file mine invocations were considered and dropped: they would buy the same detail at ~56s of startup per file (measured: model load is ~1s of it, the rest is two whole-palace prefetch scans that grow with the palace). The detail is free from metadata; the startup cost is not paid.

#### What it looks like over time

A 10-file run, one frame per footer poll (1s). `█` is files done,
`▓▓▓` is the sweep (it paints over anything, including filled cells —
frame 5 shows it wrapping mid-bar), `░` is not yet done:

```
◆ MP mining 0/10 q10 w1/1 just started +0d
[▓▓▓░░░░░░░░░░░░░░░░░░░░░] v4.0.0

◆ MP mining 2/10 q8 w1/1 1m +14d
[█████░░▓▓▓░░░░░░░░░░░░░░] v4.0.0

◆ MP mining 5/10 q5 w1/1 3m +180d
[████████████░░▓▓▓░░░░░░░] v4.0.0

◆ MP mining 7/10 q3 w1/1 4m +260d
[█████████████████░░░░▓▓▓] v4.0.0

◆ MP mining 9/10 q1 w1/1 5m +331d
[████▓▓▓███████████████░░] v4.0.0

◆ MP mining 10/10 q0 w1/1 6m +340d
[███████████▓▓▓██████████] v4.0.0

◆ MP idle 10fl 1wn - 1m ago +340dr
[░░░░░░░░░░░░░░░░░░░░░░░░] v4.0.0

◇ MP last search: 2m ago (5 res)
◆ MP idle 10fl 1wn - 1m ago +340dr
[░░░░░░░░░░░░░░░░░░░░░░░░] v4.0.0
```

Then the bar goes dark and stays dark: idle is always an empty bar, and
"done" is said by the line above. The last frame shows the query row in
its idle form on top — the two query forms never coexist.

### The mine outlives opencode

Closing opencode never stops the memory system. On exit the plugin exports what's new and spawns one DETACHED mine per pending wing, then returns immediately — shutdown stays instant no matter how big the backlog is. (The old 45s-budget synchronous mine is gone: it guaranteed failure on any real backlog, 6.6 MB needing 50 minutes.)

Resume is duplicate-free by mempalace's own protocol, not by plugin bookkeeping: every drawer carries its `source_file` plus the file's `chunk_total`, so a mine tells a complete file from one that crashed mid-file (mempalace #2183), purges stale partial drawers, and refiles only what's missing — and drawer ids are deterministic on content, so even a full re-mine overwrites rather than duplicates. Reboot or `kill -9` at any point converges on the next mine. Lock contention at close is expected — MCP servers die with opencode but take seconds to release — so the detached mine goes through `mine-detached.sh`, which retries "held by" for up to 30 minutes and exits immediately on any other failure.

Detached runs are recorded in `~/.mempalace/hook_state/detached-mines.json` (pid, wings, log) with per-wing logs `mine-<wing>-<ts>.log` pruned after 7 days.

### Reopening opencode kills its own abandoned detached mines

A detached mine that outlives its session is a feature; one that outlives a session the user has *replaced* is just contention — nobody is watching it, it holds the palace lock, and the new session's mine backs off behind work with no owner. So on startup the plugin reaps its own orphans before doing anything else (`reapDetachedMines`), and the mine it starts next owns the lock.

Nothing is lost: resume is idempotent, so the new mine refiles whatever the old one had not finished.

The reap is deliberately narrow, because "kill processes" is not ours to do at large. A pid is only signalled when **all** of these hold:

- `/proc` is readable (Linux only — elsewhere the reap is a silent no-op and lock arbitration handles it as before),
- it is not us and not pid ≤ 1,
- its command line contains **our** `mine-detached.sh` wrapper — the only unambiguous signature. A bare `mempalace mine … ~/.mempalace/oc-sessions/...` could be your own manual run or another live session's attached mine, so it is left alone and arbitrated by the lock,
- it is an **orphan** (ppid 1, or a parent that is already dead). A process attached to a live parent may belong to a session that is merely shutting down.

Its children (the python mine holding the flock) are killed before the wrapper, so none is left orphaned with the lock. `SIGTERM`, ~2s grace, `SIGKILL` for survivors; an unreadable `/proc/<pid>/stat` counts as orphan, since the worst case there is killing work a dying session had just started — which idempotent resume makes harmless, while skipping would leave the contention in place. Everything killed is logged (`reaped N detached mine process(es)…`) and visible in `/memory-log`.

`test-reap-detached.mjs` exercises this against real processes, extracting the functions from the compiled `dist/index.js` so the test cannot drift from what ships: orphan wrapper and its child killed, live-parented wrapper spared, a manual mine spared, unrelated orphans spared, pid 1 and self never signalled.

Two details cost real time to find, both from `packages/plugin/src/host.ts`:

```ts
const specifier = target.name
  ? [target.name, subpath].filter(Boolean).join("/")   // package -> "name/tui"
  : path.resolve(target.directory, subpath || "index") // local dir -> <dir>/tui
```

1. For a **package** (how this ships) the entry must be reachable as `<package-name>/tui`, i.e. declared in this package's `exports` map. For a **local directory** the file must be literally named `tui` — a plain `index.tsx` is never a TUI candidate. (This is also why `server.mjs` exists at the repo root: a local directory resolves its server entry as `<dir>/server` before `<dir>/index`.)
2. **The TUI plugin filesystem is read-only.** A write is refused silently, which is why the direction is one-way: the server plugin publishes `status.json` and this side only polls it. It is also why a `console`/file trace from TUI code is useless for debugging.

Local plugin directories load with `optional: true`, so an import error is skipped with no message anywhere. If a local TUI plugin does nothing, suspect the filename first: it must be `tui.tsx` / `tui.ts` / `tui.js` in a directory (or symlink to one) under `~/.config/opencode/plugins/`.

`tui.tsx` is shipped **uncompiled** on purpose — OpenCode transpiles the TSX and provides the JSX factory, so `@opentui/solid` (14 MB with its Babel toolchain) is not a dependency. The only runtime import is `solid-js`, for the signals that drive the sweep.

## Upgrades are not automatic

OpenCode resolves npm plugins **once** and caches them. A new version of this plugin will not be picked up on its own. To upgrade:

- the TUI's plugin update command, or
- `rm -rf ~/.cache/opencode/npm/opencode-mempalace-persistence@latest` and restart.

Check what is actually loaded with `opencode plugin list`.

### What 4.0.0 changed (and why it's a major)

Same guarantees — local-only, zero extra AI calls, verbatim messages,
private files — with the setup and write posture changed:

- **Zero-config MCP.** The plugin ensures a correct `mempalace` server
  entry on startup (`config` hook on v1, `ctx.mcp.transform` on v2):
  missing entries are registered, present ones repaired (working binary
  + read-only env, custom keys kept, disk file never rewritten —
  `MEMPALACE_MCP_MANUAL=1` opts out). No `mcp` block to write.
- **That entry is read-only** (`MEMPALACE_MCP_READ_ONLY`). A writer MCP
  takes the palace lock for its whole lifetime and starves CLI mines —
  with one tab occasionally, with two tabs (one MCP server each) as the
  rule. Reads never need the lock, so recall is unaffected.
- **Writes go through `mp-write.py`** (synced to `~/.mempalace/mp-write.py`
  on startup): `diary`, `kg-add`, `kg-supersede`, `kg-invalidate`,
  `add-drawer` — the same tool functions the MCP server calls, in
  seconds-long processes. The MCP `..._diary_write` / `..._kg_add` tools
  are refused by design now; checkpoint and pre-compact instructions,
  the skill and this README point at `mp-write.py`.

If you relied on MCP writes (diary/KG via MCP tools), move them to
`mp-write.py` — same functions, same results. To keep a fully hand-managed
entry instead, set `MEMPALACE_MCP_MANUAL=1` (see §3).

### What 3.0.0 changed (and why it's a major)

Same guarantees as before — local-only, zero extra AI calls, verbatim messages, private files — with three behavioural changes worth reading before upgrading:

- **Export filenames are content-addressed**: `sync_<session8>_<sha256-prefix>.txt` instead of `sync_<date>_<title>_<session>.txt`. The date and title used to be part of the name, so the same conversation exported twice produced two different files with identical content. Each file also ends with an `mp-ids` trailer listing the message ids it carries, which is what dedup now keys on. Files exported by 2.x are still mined — the mine scans by `*.txt` — they just keep their old names until they are consumed.
- **Dedup is derived from the queue, not from `exported_ids`.** Deleting an export file immediately frees its messages again, instead of the plugin believing they are already filed because a stale set says so.
- **The TUI sidebar footer is new**: two permanent lines (compact status tokens + a true run-fraction bar) plus a query row that shows a palace read in flight and, when idle, the last one. It only reads a small status file the server already writes; it never triggers work.

Mining is still manual: mempalace runs when OpenCode goes idle, at startup and at exit — never in the middle of your work.

---

## Install from npm

```json
{
  "plugin": ["opencode-mempalace-persistence"]
}
```

## Local development

```json
{
  "plugin": ["/path/to/opencode-mempalace-persistence/dist/index.js"]
}
```

## Debug logging

```bash
export OPENCODE_MEMPALACE_DEBUG=1
```

When set, the plugin writes a debug log to `/tmp/opencode-mempalace.log`.

---

## Observability: toasts and commands

Background memory activity is visible three ways — ephemeral first,
history on demand, never polluting session context:

- **TUI toasts** (on by default, `"toasts": false` to disable): mine
  results and errors, armed checkpoints, and every MemPalace call
  (plugin searches and model MCP calls) with what was asked plus a
  short answer preview. A startup toast shows the loaded build
  (`opencode-mempalace-persistence v4.0.0 loaded`), so npm-cache vs
  local build is never a mystery. *(Silent on OpenCode v2 — its server
  runtime has no toast surface; use `/memory-log` there.)*
- **`/memory-status`** — palace health in the transcript: drawers,
  KG stats, last sync, pending backlog, recent activity, errors with
  explanations, active config. Read-only.
- **`/memory-log [N] [filter]`** — the interaction history: every
  search (query → result count), tool call (asked → answered preview),
  mine (outcome per wing), checkpoint and MCP auto-register repair,
  newest last. Backed by
  `~/.mempalace/hook_state/interactions.log` (JSON lines, auto-rotated).
  Read-only.

---

## License

MIT
