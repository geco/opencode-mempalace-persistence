# opencode-mempalace-persistence

> **Community plugin** — not officially maintained by the MemPalace team. Fully open source, ~450 lines of TypeScript.

An OpenCode plugin that automatically saves every conversation to MemPalace and uses stored memory to provide better, context-aware responses. Real-time, zero cron, zero external scripts.

Follows the official MemPalace automation pattern (same as the Claude Code hooks): the plugin decides **when** to save, the model decides **what** to file via the MemPalace MCP tools.

[![npm version](https://img.shields.io/npm/v/opencode-mempalace-persistence.svg)](https://www.npmjs.com/package/opencode-mempalace-persistence)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mempalace-persistence.svg)](https://www.npmjs.com/package/opencode-mempalace-persistence)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Demo: a decision filed on Monday is recalled verbatim by a different session on Thursday — memory outlives sessions, not just compaction](demo.gif)

---

## How it works in 3 seconds

| Without plugin | With plugin |
|---|---|
| Every session starts from scratch | The model knows who you are and what you've done |
| You repeat context each time | Memory is automatic |
| Model starts from scratch each time | Memory persists across sessions |

The plugin injects relevant memories from MemPalace into every prompt (via `experimental.chat.messages.transform`), and saves every response back to MemPalace. A perfect feedback loop.

---

## Installation

### 1. Plugin (saves conversations)

```json
{
  "plugin": ["opencode-mempalace-persistence"]
}
```

Add this line to your `~/.config/opencode/opencode.json` and restart OpenCode.

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

# Configure MCP
mempalace mcp
```

The `mempalace mcp` command gives you the exact MCP setup string for your configuration.

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

- Durable outcomes (decisions, conclusions, learned facts):
  `mempalace_mempalace_add_drawer`.
- New KG facts: `mempalace_mempalace_kg_add` (128 chars or fewer).
- Changed single-valued fact: `mempalace_mempalace_kg_supersede`.
- Ended fact: `mempalace_mempalace_kg_invalidate`.

Record facts you are confident about. Prefer quality over quantity;
noisy entries degrade retrieval over time. Don't file secrets or tokens.

### Naming reminder
All MemPalace tools use the prefix `mempalace_mempalace_*` (not `mempalace_*`). Examples:
- `mempalace_mempalace_search` (NOT `mempalace_search`)
- `mempalace_mempalace_kg_query`
- `mempalace_mempalace_kg_add`
If you ever catch yourself typing `mempalace_search`, STOP — the correct prefix is `mempalace_mempalace_`.
```

#### Complete `~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-mempalace-persistence"],
  "instructions": ["AGENTS.md"],
  "mcp": {
    "mempalace": {
      "type": "local",
      "command": ["mempalace-mcp"],
      "enabled": true
    }
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
  → Every ~15 messages: injects a [MemPalace Checkpoint] block
  → Model files topics/decisions/quotes via MCP tools, then answers

The model responds
  → Once the turn completes, the next idle/exit/startup mines it to MemPalace (flat export, no hardcoded wings)
  → Model records new KG facts via MCP tools (only when something new emerged)

Session goes idle / process exits
  → Background mine of everything new since last sync (per-wing cursors:
  each wing advances independently, so one slow wing never stalls the rest)
  → TUI toast confirms what was mined (disable with `"toasts": false`)

Every MemPalace call — plugin searches, model MCP calls (search, diary,
KG) — also raises a short TUI toast with what was asked and a result
preview, so background memory activity is always visible. A startup toast
shows the loaded plugin version (`plugin v2.x loaded`), so you always know
whether you're running the npm release or a local build.

Multiple opencode instances are supported: mines coordinate through the
palace lock with backoff-and-retry (up to ~10min per wing), so concurrent
instances interleave wing by wing instead of starving each other — backfills
complete even with two sessions open. Routine contention shows one info
toast every 5 minutes max. To reduce contention during huge backfills, a
single instance is still fastest.

Compaction starts
  → [MemPalace Pre-Compact Emergency Save]: model files everything first
  → Identity + wake-up context re-attached so the summary cannot lose them

Next time you ask
  → Plugin finds the previous memory → injects it automatically
  → The cycle continues, memory grows
```

---

## What gets saved

Every turn (question + answer) is saved as a drawer in MemPalace. Mining runs with `--mode convos` (default `exchange` extraction: one drawer per exchange pair, verbatim, no paraphrasing). Exports are grouped one wing per project (official multi-project pattern: `bot-oc` sessions land in wing `bot-oc`, never leaking across projects). Only completed turns are exported (in-flight replies are revisited by the next sync). The model additionally records KG facts (decisions, milestones, preferences) during conversation and at each checkpoint via MCP tools.

### Backfill existing sessions

To mine the full opencode history once (e.g. on first install):

```bash
OPENCODE_MEMPALACE_BACKFILL=1 opencode
```

The plugin exports everything in the opencode database on the next sync, then resumes incremental mode. Mining is idempotent — re-running is safe.

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
                 │  Model (via AGENTS.md)    │
                 │  Records KG facts:       │
                 │  kg_add / kg_invalidate  │
                 └──────────────────────────┘
```

---

## Relevant files

| File | Purpose |
|---|---|
| `~/.config/opencode/opencode.json` | OpenCode config with plugin + MCP |
| `~/.config/opencode/AGENTS.md` | Tells the model to manage KG facts |
| `~/.mempalace/plugin-config.json` | Plugin config (`autoInjectContext`, `saveInterval`, `toasts` — all optional, see §4) |
| `~/.config/opencode/skills/mempalace-recall/SKILL.md` | Bundled recall skill (copy from `skills/` in this repo) |
| `~/.mempalace/identity.txt` | Your identity (injected by plugin) |
| `~/.mempalace/hook_state/opencode_counters.json` | Per-session message counters (checkpoint cadence) |
| `~/.mempalace/hook_state/hook.log` | Checkpoint / pre-compact event log (errors always land here) |
| `~/.mempalace/oc-sessions/` | Private (0700) export workspace for pending transcripts |
| `~/.mempalace/config.json` | MemPalace config (palace path) |
| `~/.mempalace/knowledge_graph.sqlite3` | Knowledge Graph (structured facts) |
| `~/opencode-memory/` | MemPalace vector DB (all drawers) |
| `~/.mempalace/sync_state.json` | Last sync state |

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
  (`opencode-mempalace-persistence v2.x loaded`), so npm-cache vs
  local build is never a mystery.
- **`/memory-status`** — palace health in the transcript: drawers,
  KG stats, last sync, pending backlog, recent activity, errors with
  explanations, active config. Read-only.
- **`/memory-log [N] [filter]`** — the interaction history: every
  search (query → result count), tool call (asked → answered preview),
  mine (outcome per wing) and checkpoint, newest last. Backed by
  `~/.mempalace/hook_state/interactions.log` (JSON lines, auto-rotated).
  Read-only.

---

## License

MIT
