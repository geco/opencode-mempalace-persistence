---
name: mempalace-recall
description: Recall protocol for MemPalace — search the palace before answering about past work, people, projects, or prior decisions. Use when the user asks what was decided, what happened before, who someone is, what was discussed last time, or anything that may already be filed in their memory palace. Requires the mempalace MCP server (or the opencode-mempalace-persistence plugin).
---

# MemPalace Recall

Search-before-answer protocol for MemPalace. Read the user's memory
palace before answering anything that may already be filed there,
instead of guessing from model memory.

If the `opencode-mempalace-persistence` plugin is active, identity and
relevant memories are usually already injected into the prompt — this
skill covers the cases where they are not, plus filing.

## When to recall

Search the palace **before answering** whenever the user asks about
something that may already be filed:

- Past work or prior decisions — "what did we decide / try / do?"
- A person, project, or entity — "who is …", "what is …"
- An earlier session — "remember when …", "last time …"
- A preference or fact that could have changed over time

Do **not** search on pure greenfield work with no memory relevance
(e.g. "rename this variable", "fix this typo"). Recall is
question-driven, not reflexive — a search on every turn wastes latency.

## Protocol

1. Before responding about people / projects / past events / prior
   decisions: call `mempalace_search` first (short natural-language
   query, optional `wing` / `room` filters, `limit` default 5). Use
   `mempalace_kg_query` for relational or time-bound facts.
2. If unsure about a fact: say "let me check the palace" and query.
3. Return the drawer's **verbatim** text. Never summarize or paraphrase
   stored content — quoting the exact words is the point of the system.
4. After a substantive session, record continuity with
   `~/.mempalace/mp-write.py diary --agent <name> --topic <topic> --entry <text>`
   (skip if a checkpoint hook already saved). The MCP tools are read-only by
   design — mp-write.py is the write path (same functions, seconds-long
   processes, lock released on exit).
5. File durable outcomes with `mp-write.py add-drawer --wing <w> --room <r> --content <text>`;
   new KG facts with `mp-write.py kg-add --subject <s> --predicate <p> --object <o>`
   (128 chars or fewer); single-valued replacements with `mp-write.py kg-supersede
   --subject <s> --predicate <p> --old <o> --new <n>`; ended facts with
   `mp-write.py kg-invalidate --subject <s> --predicate <p> --object <o>`.

## Tool names in OpenCode

Reads go through the MCP server (registered in OpenCode as `mempalace`, so
every tool carries a double prefix: `mempalace_mempalace_search`,
`mempalace_mempalace_kg_query`, `mempalace_mempalace_diary_read`, and
so on — in Claude Code the same tools have a single `mempalace_`
prefix). Writes go through `~/.mempalace/mp-write.py` instead: the MCP
server is read-only on purpose (a writer would hold the palace lock for
the whole session and starve mining).

## Unhappy paths

- **Empty results.** Say the palace has nothing on this; do not invent
  an answer. Offer to widen the search or file the new information.
- **MCP error / server down.** Surface the error and suggest
  `mempalace status`. Never fall back to guessing.
- **Conflicting facts.** Trust the knowledge graph's time-valid answer.

## References

- MemPalace: <https://github.com/MemPalace/mempalace>
- Recall protocol: <https://github.com/MemPalace/mempalace/blob/main/integrations/shared/recall-protocol.md>

Derived from the official `mempalace-recall` skill (MIT), adapted for
OpenCode and the opencode-mempalace-persistence plugin.
