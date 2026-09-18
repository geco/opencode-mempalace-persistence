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

### 4. Memory injection

The plugin automatically injects your identity + relevant memories from MemPalace into every prompt. No model discipline required.

Create `~/.mempalace/plugin-config.json`:

```json
{
  "autoInjectContext": true
}
```

Optional tuning:

```json
{
  "autoInjectContext": true,
  "saveInterval": 15
}
```

- `saveInterval` (default `15`, min `5`): human messages between AI checkpoints — same cadence as the official MemPalace save hook.

**Do NOT put this in `opencode.json`** — OpenCode's schema validation rejects unknown keys. The plugin reads its config from `~/.mempalace/plugin-config.json` instead.

When enabled:
- **First message**: Injects your identity from `~/.mempalace/identity.txt`
- **Every message**: Runs `mempalace search` and injects relevant results

#### AGENTS.md (minimal — recall lives in the skill)

Create `~/.config/opencode/AGENTS.md`:

```markdown
# Memory & Knowledge instructions

## Recall (usually already covered)

The plugin auto-injects identity + relevant memories into every prompt.
Only search MemPalace yourself (`mempalace_mempalace_search`) when the
question is about past work, decisions, people, or projects AND the
injected context has nothing — quote results verbatim, never paraphrase.

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
  → Background mine of everything new since last sync
  → TUI toast confirms what was mined (disable with `"toasts": false`)

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
| `~/.mempalace/plugin-config.json` | Plugin config (`autoInjectContext`, `saveInterval`) |
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

## License

MIT
