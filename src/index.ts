import { execSync, execFileSync, execFile, spawnSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, unlinkSync, appendFileSync, statSync, readdirSync, openSync, readSync, closeSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"
import { createHash } from "crypto"
import { fileURLToPath } from "url"
import type { Plugin } from "@opencode-ai/plugin"
import { Plugin as PluginV2 } from "@opencode/plugin"

const HOME = homedir()
const MEMPALACE_BIN = join(HOME, ".local/bin/mempalace")
const OPENCODE_DB = join(HOME, ".local/share/opencode/opencode.db")
const STATE_FILE = join(HOME, ".mempalace/sync_state.json")
const PLUGIN_CONFIG = join(HOME, ".mempalace/plugin-config.json")
const IDENTITY_FILE = join(HOME, ".mempalace/identity.txt")
const HOOK_STATE_DIR = join(HOME, ".mempalace/hook_state")
const COUNTERS_FILE = join(HOOK_STATE_DIR, "opencode_counters.json")
const HOOK_LOG = join(HOOK_STATE_DIR, "hook.log")
const INTERACTIONS_LOG = join(HOOK_STATE_DIR, "interactions.log")
// Cap the interactions log so it never grows unbounded (approx lines).
const INTERACTIONS_MAX_LINES = 2000
// Private sync workspace (0700): transcripts contain conversation text,
// so they must never sit world-readable in /tmp (see PR #1524 review).
const SYNC_DIR = join(HOME, ".mempalace/oc-sessions")
const OUT_DIR = SYNC_DIR
const TMP_SCRIPT = join(SYNC_DIR, "oc-plugin-query.py")
const DEBUG = !!process.env.OPENCODE_MEMPALACE_DEBUG
const LOG_FILE = "/tmp/opencode-mempalace.log"
const MAX_INJECT_CHARS = 900
const MAX_SEARCH_RESULTS = 3
const MAX_WAKEUP_CHARS = 1500
// Message-ID retention for export dedup: age + size caps (see commitExportedIds).
const MINED_IDS_MAX_AGE_MS = 90 * 24 * 3600 * 1000
const MINED_IDS_MAX_ENTRIES = 200000
// All child-process output buffers raised well above Node's 1 MiB
// default (see issue #6): session exports and mine summaries routinely
// exceed it (a single message.data with summary.diffs measured 1.1 MB),
// and ENOBUFS aborted the whole sync permanently.
const CHILD_MAX_BUFFER = 64 * 1024 * 1024
// Official MemPalace hook cadence: AI checkpoint every N human messages.
const DEFAULT_SAVE_INTERVAL = 15

function log(msg: string) {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch {}
}

function hookLog(msg: string) {
  try {
    mkdirSync(HOOK_STATE_DIR, { recursive: true })
    appendFileSync(HOOK_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

// Errors are never silent: hook.log is always written (unlike the
// DEBUG-gated log), so a broken pipeline is visible by default.
function errLog(msg: string) {
  log("ERROR: " + msg)
  hookLog("ERROR: " + msg)
}

// Structured interaction log (JSON lines): every MemPalace question and
// answer, readable by /memory-log. Ephemeral TUI toasts show the moment;
// this file keeps the history — without polluting session context.
// TUI status: one small JSON file the TUI-side plugin polls. Direction is
// always server -> file, because the TUI plugin filesystem is READ-ONLY (a
// write there is refused, silently, which makes a debug trace useless).
// Kept separate from interactions.log on purpose: that file is a JSONL
// archive that reaches hundreds of KB, and the TUI should not tail it.
const STATUS_FILE = join(HOOK_STATE_DIR, "status.json")
type StatusPhase = "idle" | "mining" | "busy" | "error"
let statusPhase: StatusPhase = "idle"
let statusWing = ""
let statusLast: Record<string, unknown> | null = null
let statusError = ""
let statusWrittenAt = 0

function writeStatus(force = false): void {
  const now = Date.now()
  // Throttled: ilog() fires on every tool call and this is only a UI hint.
  if (!force && now - statusWrittenAt < 400) return
  statusWrittenAt = now
  try {
    mkdirSync(HOOK_STATE_DIR, { recursive: true })
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        phase: statusPhase,
        wing: statusWing || undefined,
        pending: countPendingFiles(),
        last: statusLast || undefined,
        error: statusError || undefined,
        plugin: `${pluginName()} v${pluginVersion()}`,
        wingIndex: mineWingsTotal > 0 ? mineWingIndex : undefined,
        wingsTotal: mineWingsTotal > 0 ? mineWingsTotal : undefined,
        drawersBaseline: mineDrawersBaseline >= 0 ? mineDrawersBaseline : undefined,
        drawersNow: mineDrawersNow >= 0 ? mineDrawersNow : undefined,
      }),
      { mode: 0o600 },
    )
  } catch (e) {
    log("status write err: " + String(e))
  }
}

// Live mine progress.
//
// The mine CLI prints nothing until it exits, so per-FILE progress does not
// exist to an outside observer: the miner walks the files silently and only
// the final summary says what was filed. Faking a per-file counter would be
// the percentage lie all over again. What DOES exist is the palace itself,
// which grows while the mine runs. So the "current item" is reported at the
// two granularities that are real: which wing of this run is being mined
// (the plugin mines wing by wing and knows the list upfront), and how many
// drawers the palace has gained since the run started.
//
// Both are best-effort. The drawer count is a read-only COUNT(*) over the
// local Chroma sqlite; anything unreadable (another backend, schema change)
// degrades the footer to elapsed-time-only instead of breaking it. The delta
// counts every writer, so strictly it is palace growth during the run, not
// this mine's output alone — in practice the mine is the only bulk writer
// and MCP writes are a drawer at a time.
let mineWingIndex = 0
let mineWingsTotal = 0
let mineDrawersBaseline = -1
let mineDrawersNow = -1
let minePoll: ReturnType<typeof setInterval> | null = null

function palaceDrawersNow(): number {
  try {
    const db = join(HOME, "opencode-memory", "chroma.sqlite3")
    const out = execFileSync(
      process.env.MEMPALACE_PYTHON || "python3",
      [
        "-c",
        "import sqlite3\n" +
          `c=sqlite3.connect('file:${db}?mode=ro',uri=True,timeout=5)\n` +
          "print(c.execute('SELECT COUNT(*) FROM embeddings').fetchone()[0])",
      ],
      { encoding: "utf-8", timeout: 15000 },
    ).trim()
    const n = parseInt(out, 10)
    return Number.isFinite(n) && n >= 0 ? n : -1
  } catch {
    return -1
  }
}

function stopMinePoll(): void {
  if (minePoll !== null) {
    clearInterval(minePoll)
    minePoll = null
  }
  mineWingIndex = 0
  mineWingsTotal = 0
  mineDrawersBaseline = -1
  mineDrawersNow = -1
}

function statusEvent(kind: string, data: Record<string, unknown> = {}): void {
  statusLast = { kind, ...data, at: new Date().toISOString() }
  writeStatus()
}

function ilog(kind: string, data: Record<string, unknown>): void {
  statusEvent(kind, data)
  try {
    mkdirSync(HOOK_STATE_DIR, { recursive: true })
    appendFileSync(INTERACTIONS_LOG, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\n")
    // Cheap rotation: count lines only when the file looks big.
    let size = 0
    try { size = statSync(INTERACTIONS_LOG).size } catch {}
    if (size > 600 * 1024) {
      const lines = readFileSync(INTERACTIONS_LOG, "utf-8").split("\n")
      if (lines.length > INTERACTIONS_MAX_LINES) {
        writeFileSync(INTERACTIONS_LOG, lines.slice(-INTERACTIONS_MAX_LINES).join("\n"))
      }
    }
  } catch {}
}

function toastsEnabled(): boolean {
  try {
    const raw = readFileSync(PLUGIN_CONFIG, "utf-8")
    const v = (JSON.parse(raw) as any)?.toasts
    if (v === false) return false
  } catch {}
  return true
}

// Messages arrived after each wing's sync cursor: still waiting for the
// next run. Per-wing, so one slow wing never masks the others.
function countPendingMessages(): { total: number; byWing: Record<string, number> } {
  try {
    const st = readSyncState()
    const out = runPython(`
import sqlite3, json, re
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
cursors = json.loads(${JSON.stringify(JSON.stringify(st.wings || {}))})
default = ${st.last_sync_ms || 0}
def has(t):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone() is not None
rows = []
# Same dual-schema rule as the export: v2 is the live layout, v1 is read
# only as a fill-in (a v1 -> v2 migration leaves older messages there).
if has("session_v2") and has("session_message"):
    rows += db.execute("""
      SELECT s.directory, sm.time_created, sm.id FROM session_message sm
      JOIN session_v2 s ON s.id = sm.session_id
    """).fetchall()
if has("session") and has("message"):
    rows += db.execute("""
      SELECT s.directory, m.time_created, m.id FROM message m
      JOIN session s ON s.id = m.session_id
    """).fetchall()
db.close()
by = {}
seen = set()
for directory, mts, mid in rows:
    if mid in seen: continue
    seen.add(mid)
    base = ((directory or "").rstrip("/").split("/") or ["global"])[-1] or "global"
    wing = re.sub("[^a-zA-Z0-9_-]", "_", base)[:40] or "global"
    if mts > cursors.get(wing, default):
        by[wing] = by.get(wing, 0) + 1
print(json.dumps(by))
`)
    const byWing = JSON.parse(out) as Record<string, number>
    const total = Object.values(byWing).reduce((a, b) => a + b, 0)
    return { total, byWing }
  } catch {
    return { total: 0, byWing: {} }
  }
}
let cachedName: string | undefined = undefined
let cachedVersion: string | undefined = undefined
function pluginName(): string {
  if (cachedName !== undefined) return cachedName
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")) as any
    cachedName = typeof pkg?.name === "string" ? pkg.name : "opencode-mempalace-persistence"
  } catch { cachedName = "opencode-mempalace-persistence" }
  return cachedName ?? "opencode-mempalace-persistence"
}
function pluginVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")) as any
    cachedVersion = typeof pkg?.version === "string" ? pkg.version : "unknown"
  } catch { cachedVersion = "unknown" }
  return cachedVersion ?? "unknown"
}

// Pending export files (backlog). Pure fs walk, no shell.
function countPendingFiles(): number {
  let n = 0
  try {
    for (const w of readdirSync(SYNC_DIR, { withFileTypes: true })) {
      if (!w.isDirectory()) continue
      try { n += readdirSync(join(SYNC_DIR, w.name)).length } catch {}
    }
  } catch {}
  return n
}

function countPendingSuffix(): string {
  const pending = countPendingFiles()
  return pending > 0 ? `, ${pending} file(s) waiting to mine` : ", queue empty"
}

// TUI toast client (set by the factory). Fire-and-forget: headless runs
// (`opencode run`, no TUI attached) must never break on this.
let tuiClient: any = null
// Throttle for routine skip notices (busy palace): at most one toast
// per window, otherwise active sessions get spammed every turn.
let lastBusyToastTs = 0
const BUSY_TOAST_WINDOW_MS = 5 * 60 * 1000
function toast(variant: "info" | "success" | "warning" | "error", title: string, message: string): void {
  if (!toastsEnabled() || !tuiClient?.tui?.showToast) return
  try {
    const p = tuiClient.tui.showToast({ body: { title, message, variant, duration: 5000 } })
    if (p && typeof p.catch === "function") p.catch(() => {})
  } catch {}
}

// Probe for a working Python interpreter at startup instead of hardcoding
// one installer layout (pipx vs uv tool vs system). runPython only needs
// stdlib (sqlite3/json), so any python3 works. Priority: explicit env
// override, legacy pipx venv, uv tool venv, PATH fallback.
let resolvedPython: string | null | undefined = undefined
function resolvePython(): string | null {
  if (resolvedPython !== undefined) return resolvedPython
  const candidates = [
    process.env.MEMPALACE_PYTHON,
    join(HOME, ".local/share/pipx/venvs/mempalace/bin/python3"),
    join(HOME, ".local/share/uv/tools/mempalace/bin/python3"),
  ].filter((p): p is string => !!p && existsSync(p))
  if (candidates.length > 0) {
    resolvedPython = candidates[0]
  } else {
    try {
      execSync("python3 --version", { encoding: "utf-8", timeout: 10000 })
      resolvedPython = "python3"
    } catch {
      resolvedPython = null
    }
  }
  if (resolvedPython) {
    log("using python: " + resolvedPython)
  } else {
    errLog("no working Python interpreter found (tried MEMPALACE_PYTHON, pipx venv, uv tool venv, PATH python3) — DB export disabled")
  }
  return resolvedPython
}

let miningLock = false
let lastSyncTs = 0
let wakeupDone = false
// V1 factory consts (autoInject/identity/interval) become shared runtime
// state so both the V1 server() and the V2 setup() use one init.
let runtimeInit = false
let autoInject = false
let identity = ""
let interval = DEFAULT_SAVE_INTERVAL
// Exact-once guard for the V2 prompt hook: the server may instantiate one
// plugin per location, so the same user message could pass several hook
// registrations in one process. messageID dedup keeps counting exact.
const seenPromptIDs = new Set<string>()
function rememberPromptID(id: string): boolean {
  if (!id || seenPromptIDs.has(id)) return false
  seenPromptIDs.add(id)
  if (seenPromptIDs.size > 5000) {
    const it = seenPromptIDs.values()
    for (let i = 0; i < 1000; i++) {
      const n = it.next()
      if (n.done) break
      seenPromptIDs.delete(n.value)
    }
  }
  return true
}
// Set by chat.message when a SAVE_INTERVAL boundary is crossed,
// consumed once by the next messages.transform (same pattern as the
// official Stop hook: the hook decides WHEN, the model decides WHAT).
let pendingCheckpoint: { sessionID: string; count: number } | null = null

function runPython(code: string): string {
  const python = resolvePython()
  if (!python) throw new Error("no working Python interpreter (see hook.log)")
  mkdirSync(SYNC_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(TMP_SCRIPT, code, { mode: 0o600 })
  try {
    // argv array, no shell (see PR #2): paths here are fixed, never user input.
    return execFileSync(python, [TMP_SCRIPT], { encoding: "utf-8", timeout: 30000, maxBuffer: CHILD_MAX_BUFFER }).trim()
  } finally {
    try { unlinkSync(TMP_SCRIPT) } catch {}
  }
}

// Resolve the mempalace CLI without hardcoding one installer layout:
// explicit env override, PATH lookup (cross-platform, incl. Windows),
// legacy ~/.local/bin fallback.
let resolvedBin: string | null | undefined = undefined
function resolveBin(): string | null {
  if (resolvedBin !== undefined) return resolvedBin
  const envBin = process.env.MEMPALACE_BIN
  if (envBin && existsSync(envBin)) {
    resolvedBin = envBin
  } else {
    try {
      const found = execSync(process.platform === "win32" ? "where mempalace" : "command -v mempalace", {
        encoding: "utf-8", timeout: 10000,
      }).trim().split(/\r?\n/)[0]?.trim()
      if (found) resolvedBin = found;
    } catch {}
    if (!resolvedBin && existsSync(MEMPALACE_BIN)) resolvedBin = MEMPALACE_BIN;
    if (!resolvedBin) resolvedBin = null;
  }
  if (resolvedBin) {
    log("using mempalace: " + resolvedBin)
  } else {
    errLog("mempalace CLI not found (tried MEMPALACE_BIN env, PATH, ~/.local/bin) — search/wake-up/mine disabled")
  }
  return resolvedBin
}

function hasText(parts: any[]): string {
  return parts
    .filter((p: any) => p?.type === "text" && p?.text?.trim())
    .map((p: any) => p.text.trim())
    .join("\n")
}

function isAutoInjectEnabled(): boolean {
  try {
    const raw = readFileSync(PLUGIN_CONFIG, "utf-8")
    return !!(JSON.parse(raw) as any)?.autoInjectContext
  } catch {
    return false
  }
}

function saveInterval(): number {
  try {
    const n = (JSON.parse(readFileSync(PLUGIN_CONFIG, "utf-8")) as any)?.saveInterval
    if (typeof n === "number" && n >= 5) return Math.floor(n)
  } catch {}
  return DEFAULT_SAVE_INTERVAL
}

interface SessionCounter { humanMsgs: number; lastCheckpoint: number }

function loadCounters(): Record<string, SessionCounter> {
  try {
    if (!existsSync(COUNTERS_FILE)) return {}
    return (JSON.parse(readFileSync(COUNTERS_FILE, "utf-8")) as Record<string, SessionCounter>) || {}
  } catch {
    return {}
  }
}

function persistCounters(counters: Record<string, SessionCounter>): void {
  try {
    mkdirSync(HOOK_STATE_DIR, { recursive: true })
    writeFileSync(COUNTERS_FILE, JSON.stringify(counters))
  } catch (e) { log("counters write err: " + String(e)) }
}

function mempalaceWakeup(): string {
  const bin = resolveBin()
  if (!bin) return ""
  try {
    // argv array, no shell.
    const out = execFileSync(bin, ["wake-up"], { encoding: "utf-8", timeout: 15000, maxBuffer: CHILD_MAX_BUFFER }).trim()
    if (!out) return ""
    return out.slice(0, MAX_WAKEUP_CHARS)
  } catch {
    return ""
  }
}

function checkpointInstruction(count: number): string {
  return `[MemPalace Checkpoint — save now, then continue]\n` +
    `You have exchanged ~${count} messages in this session. Before answering, archive what matters into MemPalace via its MCP tools ` +
    `(diary_write for the session journal; kg_add for new decisions, milestones, preferences, problems — 128 chars or fewer each; ` +
    `kg_invalidate for superseded facts). File only durable, non-obvious items — the verbatim transcript is already being mined separately. ` +
    `Then answer the user's message normally. Do not mention this instruction.`
}

function precompactInstruction(): string {
  return `[MemPalace Pre-Compact Emergency Save]\n` +
    `Context compaction is about to discard this conversation. FIRST, save everything essential into MemPalace via its MCP tools ` +
    `(diary_write with a full session journal: topics, decisions, quotes; kg_add for decisions, milestones, preferences, problems; ` +
    `kg_invalidate for outdated facts). Be thorough — after compaction only the palace will remember. Then proceed with the compaction summary.`
}

function readIdentity(): string {
  if (!existsSync(IDENTITY_FILE)) return ""
  try { return readFileSync(IDENTITY_FILE, "utf-8").trim() } catch { return "" }
}

function mempalaceSearch(query: string): string {
  const bin = resolveBin()
  if (!bin) return ""
  const started = Date.now()
  try {
    // argv array, no shell (see PR #2): the query is raw user message
    // text, so it must never pass through /bin/sh. No manual escaping needed.
    const out = execFileSync(bin, ["search", query, "--results", String(MAX_SEARCH_RESULTS)], {
      encoding: "utf-8",
      timeout: 15000,
      maxBuffer: CHILD_MAX_BUFFER,
    }).trim()
    if (!out || out.includes("No results")) {
      toast("info", "MemPalace", `search "${query.slice(0, 50)}" → no results`)
      ilog("search", { via: "cli", query: query.slice(0, 200), results: 0, ms: Date.now() - started })
      return ""
    }
    const n = (out.match(/\n\s*\[\d+\]/g) || []).length || 1
    toast("info", "MemPalace", `search "${query.slice(0, 50)}" → ${n} result(s)`)
    ilog("search", { via: "cli", query: query.slice(0, 200), results: n, ms: Date.now() - started })
    return out.slice(0, MAX_INJECT_CHARS)
  } catch {
    return ""
  }
}

// TUI visibility for model-driven MCP calls (skill recall, diary, KG):
// the plugin can't see inside the agent, but it sees every tool result.
function isMemPalaceTool(name: string): boolean {
  return typeof name === "string" && name.toLowerCase().includes("mempalace")
}

// MCP tool results arrive as content blocks ({content: [{type, text}]),
// NOT as a flat `output` string (diagnosed via shape logging 2026-09-19:
// keys=["content"], no `output` key at all).
function extractResultText(out: any): string {
  try {
    const blocks = out?.content
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((b: any) => b && (b.type === "text" || typeof b.text === "string") && typeof b.text === "string")
        .map((b: any) => String(b.text))
        .join("\n")
      if (text.trim()) return text;
    }
    if (typeof out?.output === "string" && out.output.trim()) return out.output;
    if (typeof out === "string" && out.trim()) return out;
  } catch {}
  return ""
}

function summarizeToolCall(tool: string, args: any, out: any): string {
  const short = tool.replace(/^mcp_+/, "").replace(/^mempalace_mempalace_/, "").replace(/^mempalace_/, "")
  let asked = ""
  try {
    const a = typeof args === "string" ? args : JSON.stringify(args || {})
    asked = a.replace(/\s+/g, " ").slice(0, 60)
  } catch { asked = "" }
  const answered = extractResultText(out).replace(/\s+/g, " ").slice(0, 120) || "(empty)"
  return `${short} · asked: ${asked} → ${answered}`.slice(0, 260)
}

interface SyncState { last_sync_ms: number; wings?: Record<string, number>; mined_ids?: Record<string, number> }

function readSyncState(): SyncState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as SyncState
    if (typeof raw?.last_sync_ms === "number") {
      return {
        last_sync_ms: raw.last_sync_ms,
        wings: raw.wings && typeof raw.wings === "object" ? raw.wings : {},
        mined_ids: raw.mined_ids && typeof raw.mined_ids === "object" ? raw.mined_ids : {},
      }
    }
  } catch {}
  return { last_sync_ms: 0, wings: {}, mined_ids: {} }
}

// Message IDs whose content is already IN THE PALACE. Committed only when a
// mine succeeds, so it is the one set that means "durable".
//
// Caveat worth knowing: it is a claim about the palace, and a manual purge
// invalidates it — after deleting drawers by source_file the ids say "filed"
// while the content is gone, and those messages will not be exported again
// until their entries are cleared from sync_state.json. Recorded per message
// id rather than per file so a purge can be repaired selectively.
function loadMinedIds(): Map<string, number> {
  try {
    const raw = (readSyncState().mined_ids || {}) as Record<string, number>
    return new Map(Object.entries(raw).filter(([, ts]) => typeof ts === "number"))
  } catch {
    return new Map()
  }
}

// Message IDs currently sitting in the export queue, rebuilt by reading the
// queue files themselves.
//
// The obvious alternative — remembering the same ids in sync_state.json — is
// what this replaced, and it is worse in a way that only shows up later: the
// two drift the moment anything touches the queue outside the plugin (a manual
// cleanup, a disk purge, a run killed between write and bookkeeping). A stale
// set makes the plugin believe a message is queued when its file is gone, and
// that content is then never exported again — silent and permanent, with no
// error anywhere. Deriving the set from the files makes that impossible: the
// queue is the only record, and deleting a file immediately frees its
// messages.
//
// Cost is one tail read per queued file, once per sync. A file with no
// trailer — anything written by an older version — contributes nothing, which
// errs toward re-exporting (duplicate memory) rather than losing it.
function queueMessageIds(): Set<string> {
  const ids = new Set<string>()
  const TAIL = 32 * 1024
  const TRAILER = /\n?<!-- mp-ids: ([^>]*?) -->\s*$/
  let wings: string[] = []
  try {
    wings = readdirSync(OUT_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(OUT_DIR, e.name))
  } catch {
    return ids
  }
  for (const wing of wings) {
    let files: string[] = []
    try {
      files = readdirSync(wing).filter((n) => n.endsWith(".txt"))
    } catch {
      continue
    }
    for (const name of files) {
      try {
        const path = join(wing, name)
        const size = statSync(path).size
        const len = Math.min(size, TAIL)
        const buf = Buffer.alloc(len)
        const fd = openSync(path, "r")
        try {
          readSync(fd, buf, 0, len, size - len)
        } finally {
          closeSync(fd)
        }
        const m = TRAILER.exec(buf.toString("utf-8"))
        if (!m) continue
        for (const id of m[1].split(",")) if (id) ids.add(id)
      } catch {}
    }
  }
  return ids
}

function commitExportedIds(byWing: Map<string, Map<string, number>>): void {
  try {
    const st = readSyncState()
    const merged: Record<string, number> = { ...(st.mined_ids || {}) }
    for (const ids of byWing.values()) {
      for (const [mid, ts] of ids) {
        if (typeof ts === "number") merged[mid] = ts
      }
    }
    // Retention by AGE (90d) and SIZE (200k newest) — NOT by cursor.
    // Cursors move backward on incomplete clamps and stall on failures;
    // cursor-based pruning dropped IDs that future exports reselect,
    // silently disabling the filter (seen live: set always empty).
    const cutoff = Date.now() - MINED_IDS_MAX_AGE_MS
    let entries = Object.entries(merged).filter(([, ts]) => typeof ts === "number" && (ts as number) >= cutoff)
    if (entries.length > MINED_IDS_MAX_ENTRIES) {
      entries = entries.sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, MINED_IDS_MAX_ENTRIES)
    }
    st.mined_ids = Object.fromEntries(entries)
    writeFileSync(STATE_FILE, JSON.stringify(st))
  } catch (e) { log("mined-ids write err: " + String(e)) }
}

// Per-wing cursors (see PR #1524 follow-up): a global cursor stalls
// forever when one wing keeps failing while others succeed. Each wing
// advances independently; last_sync_ms stays the min for compatibility.
function getLastSync(wing?: string): number {
  if (!existsSync(STATE_FILE)) return 0
  const st = readSyncState()
  if (wing && st.wings && typeof st.wings[wing] === "number") return st.wings[wing] as number
  return st.last_sync_ms || 0
}

function dbSync(): void {
  if (miningLock) return
  try { doDbSync() } catch (e) { errLog("sync err: " + String(e)) }
}

function backfillRequested(): boolean {
  return !!process.env.OPENCODE_MEMPALACE_BACKFILL
}

// Export sessions with new messages as flat transcripts, grouped by
// project wing. cursorFor(wing) gives each wing its own cursor (null =
// discovery floor: sessions with anything newer anywhere). Filenames
// embed a content hash, so re-exports are naturally idempotent.
function exportNewSessions(
  cursorFor: (wing: string | null) => number,
): { wings: Map<string, string[]>; now: number; exportedIds: Map<string, Map<string, number>> } {
  const sinceMs = cursorFor(null)
  // Dual schema. OpenCode v2 stores live sessions in `session_v2` +
  // `session_message` (content inside the message JSON), while v1 used
  // `session` + `message` + `part` rows. Both are read so a v1 -> v2
  // migration never strands messages written before the switch: v2 wins
  // for ids present in both (it is the live schema), v1 fills the rest.
  const sessions = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
def has(t):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone() is not None
sessions = {}
if has("session_v2") and has("session_message"):
    for sid, title, directory, newest in db.execute("""
      SELECT sm.session_id, s.title, s.directory, MAX(sm.time_created)
      FROM session_message sm JOIN session_v2 s ON s.id = sm.session_id
      WHERE sm.time_created > ${sinceMs} GROUP BY sm.session_id
    """).fetchall():
        sessions[sid] = [sid, title, directory, newest, "v2"]
if has("session") and has("message"):
    for sid, title, directory, newest in db.execute("""
      SELECT m.session_id, s.title, s.directory, MAX(m.time_created)
      FROM message m JOIN session s ON s.id = m.session_id
      WHERE m.time_created > ${sinceMs} GROUP BY m.session_id
    """).fetchall():
        if sid not in sessions:
            sessions[sid] = [sid, title, directory, newest, "v1"]
rows = sorted(sessions.values(), key=lambda r: r[3])
db.close()
print(json.dumps(rows))
`)

  let sessionsArr: any[][]
  try { sessionsArr = JSON.parse(sessions) } catch { return { wings: new Map(), now: Date.now(), exportedIds: new Map() } }
  if (!sessionsArr || sessionsArr.length === 0) return { wings: new Map(), now: Date.now(), exportedIds: new Map() }

  const now = Date.now()
  // Never advance the cursor past an in-flight reply: anything skipped
  // as incomplete is revisited by the next sync (idle/exit/startup).
  let cursor = now
  const wings = new Map<string, string[]>()
  // Message IDs already known to be in the palace, loaded ONCE per export
  // (the state file can be MBs).
  const seen = loadMinedIds()
  // Message IDs sitting in the queue RIGHT NOW, read from the queue files
  // themselves. Together with `seen` this is the full "already exported"
  // set: a message is skipped if its content is either in the palace or
  // waiting in a file. See queueMessageIds() for why the second half is
  // derived rather than remembered.
  const queued = queueMessageIds()
  // Wings whose window is fully accounted for in this run — either a file was
  // written, or every message was already in the queue. The cursor advances
  // for these and ONLY these, right here — see the cursor note below: the
  // export cursor means "written", not "mined".
  const coveredWings = new Set<string>()
  // Message IDs written to export files, PER WING. Moved into mined_ids only
  // when that wing mines successfully; until then the queue file is the
  // record (same reason the cursor advances on write).
  const exportedByWing = new Map<string, Map<string, number>>()
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })

  for (const sess of sessionsArr) {
  try {
    const [sessId, title, directory, , schema] = sess
    const wing = (((directory as string) || "").split("/").filter(Boolean).pop() || "global")
      .replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "global"
    const label = (title || "").replace(/[^a-zA-Z0-9 _-]/g, "_") || (sessId || "").slice(0, 12)
    const wingSince = cursorFor(wing)

    const msgs = runPython(`
import sqlite3, json, time
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
now_ms = int(time.time() * 1000)
STALE_PART_MS = 30 * 60 * 1000
STALE_EMPTY_MS = 10 * 60 * 1000
texts = []
incomplete = []

# Completion tracking (see PR #1524 review): an assistant message row is
# created when a reply STARTS and is marked complete only afterwards, so
# exporting mid-reply would snapshot partial content while the cursor
# advances past its timestamp, losing the rest of the reply forever.
# Unfinished replies are skipped and revisited by the next sync, BUT only
# while recently active: a reply with no new content for a while is dead
# (killed session, crashed run) and treating it as perpetually in-flight
# pinned the cursor forever (seen live: a stillborn message froze sync
# for 7h). Dead replies are exported as-is.
if ${JSON.stringify(schema)} == "v2":
    rows = db.execute("""
      SELECT id, time_created, time_updated, type, data FROM session_message
      WHERE session_id = ? AND time_created > ? ORDER BY time_created, seq
    """, (${JSON.stringify(sessId)}, ${wingSince})).fetchall()
    for mid, mts, mupd, mtype, mdata_raw in rows:
        try: mdata = json.loads(mdata_raw)
        except: mdata = {}
        role = mtype or mdata.get("role", "unknown")
        finished = bool(mdata.get("finish")) or bool((mdata.get("time") or {}).get("completed"))
        if role == "assistant" and not finished:
            alive = (now_ms - (mupd or mts)) < (STALE_PART_MS if mupd else STALE_EMPTY_MS)
            if alive:
                incomplete.append(mts)
                continue
        for block in mdata.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text" and str(block.get("text") or "").strip():
                texts.append({"mid": mid, "role": role, "text": str(block["text"]).strip(), "ts": mts})
        # v2 stores the human turn as a plain "text" field on the message
        # (assistant turns use the content[] blocks above) -- without this
        # every prompt would be missing from the transcript.
        if str(mdata.get("text") or "").strip():
            texts.append({"mid": mid, "role": role, "text": str(mdata["text"]).strip(), "ts": mts})
else:
    rows = db.execute("""
      SELECT m.id, m.time_created, m.data FROM message m
      WHERE m.session_id = ? AND m.time_created > ?
      ORDER BY m.time_created
    """, (${JSON.stringify(sessId)}, ${wingSince})).fetchall()
    for mid, mts, mdata_raw in rows:
        try: mdata = json.loads(mdata_raw)
        except: mdata = {}
        role = mdata.get("role", "unknown")
        if role == "assistant" and not mdata.get("finish"):
            max_part = db.execute("SELECT MAX(time_created) FROM part WHERE message_id = ?", (mid,)).fetchone()[0]
            if max_part is None:
                alive = (now_ms - mts) < STALE_EMPTY_MS
            else:
                alive = (now_ms - max_part) < STALE_PART_MS
            if alive:
                incomplete.append(mts)
                continue
        for (pdata_raw,) in db.execute("SELECT data FROM part WHERE message_id = ? ORDER BY time_created", (mid,)).fetchall():
            try:
                pdata = json.loads(pdata_raw)
                if pdata.get("type") == "text" and pdata.get("text","").strip():
                    texts.append({"mid": mid, "role": role, "text": pdata.get("text").strip(), "ts": mts})
            except: pass
db.close()
print(json.dumps({"texts": texts, "incomplete": incomplete}))
`)

    let msgList: Array<{ mid: string; role: string; text: string; ts: number }>
    let incompleteTs: number[] = []
    try {
      const parsed = JSON.parse(msgs) as { texts: typeof msgList; incomplete: number[] }
      // Message-level dedup: each message is exported exactly once ever.
      // "Once ever" means once into the palace OR once into a queue file —
      // a message waiting in the queue is already on its way in, and
      // re-writing it would only make the mine file the same memory twice.
      // Repeated boilerplate (system prompts re-sent every turn) across
      // overlapping windows was the main duplicate source mempalace's
      // file-level dedup cannot catch (different files, same paragraph).
      msgList = (parsed.texts || []).filter((m) => m && m.mid && !seen.has(m.mid) && !queued.has(m.mid))
      incompleteTs = parsed.incomplete || []
    } catch { continue }
    if (incompleteTs.length > 0) {
      cursor = Math.min(cursor, Math.min(...incompleteTs) - 1)
    }
    // Count distinct messages, not text blocks: one message can carry several
    // blocks, and a "file" holding a single message repeated is not memory
    // worth filing.
    const distinct = new Set(msgList.map((m) => m.mid)).size
    if (distinct === 0) {
      // The whole window is already in the queue, so there is nothing to
      // write — but the cursor MUST still move past it. Without this the wing
      // would re-read the same window on every sync forever, and since the
      // window never changes nothing would ever be written again.
      if (incompleteTs.length === 0) coveredWings.add(wing)
      continue
    }
    if (distinct < 2 && incompleteTs.length === 0) continue

    // The transcript, and ONLY the transcript, is what identifies a file.
    //
    // Both volatile fields used to be part of it: the export date and the
    // session title. They made the same window hash differently on a different
    // day, so every re-export created a NEW file instead of overwriting the
    // old one — which is how one session ended up as three near-identical
    // files in the queue (seen: 116 sections, then 137, then 116 again).
    //
    // A filename has to be a function of the content or deduplication can
    // never work. With this hash an unchanged re-export lands on the same path
    // and overwrites it, and a window that gained messages becomes a new file
    // whose messages are disjoint from the previous one (the cursor only moves
    // forward), so mining both costs no duplicated content.
    const transcript = msgList
      .map((m) => {
        const ts = m.ts ? new Date(m.ts).toISOString().slice(11, 19) : ""
        return `## ${m.role.toUpperCase()} \u2014 ${ts}\n\n${m.text}`
      })
      .join("\n\n")
    if (!transcript.trim()) continue

    // The header keeps title, session and date — no information is lost by
    // taking it out of the hash — but the date is named for what it actually
    // is: the last time this window was confirmed, rewritten on every
    // re-export. Calling it "Date" implied a creation date it never had.
    const ids = [...new Set(msgList.map((m) => m.mid).filter(Boolean))].sort()
    const content = [
      `# ${title || label}`,
      `Session: ${sessId}`,
      `Last verified: ${new Date().toISOString().slice(0, 10)}`,
      "",
      transcript,
      "",
      // The trailer is what makes the queue self-describing: the ids of the
      // messages this file holds. queueMessageIds() reads it back so a
      // re-export skips them, and a file deleted by hand immediately makes its
      // messages exportable again — no bookkeeping to fall out of sync. It is
      // one line per file, not one id per message inline, so the transcript
      // itself stays verbatim.
      `<!-- mp-ids: ${ids.join(",")} -->`,
    ]
      .join("\n")
      .trim()

    const contentHash = createHash("sha256").update(transcript).digest("hex").slice(0, 12)
    const wingDir = join(OUT_DIR, wing)
    mkdirSync(wingDir, { recursive: true, mode: 0o700 })
    const fname = `sync_${(sessId || "session").slice(0, 8)}_${contentHash}.txt`
    writeFileSync(join(wingDir, fname), content + "\n", { mode: 0o600 })
    if (!exportedByWing.has(wing)) exportedByWing.set(wing, new Map())
    coveredWings.add(wing)
    const wingIds = exportedByWing.get(wing)!
    for (const m of msgList) {
      if (m && m.mid && typeof m.ts === "number") wingIds.set(m.mid, m.ts)
    }
    if (!wings.has(wing)) wings.set(wing, [])
    wings.get(wing)!.push(join(wingDir, fname))
  } catch (e) {
    // One pathological session (oversized payload, corrupt row) must
    // never abort the whole export — skip it, log, continue with the
    // rest (see issue #6).
    try {
      errLog(`export skipped session ${(sess as any[])?.[0] || "?"}: ${String(e).slice(0, 160)}`)
    } catch {}
    continue
  }
  }

  // The cursor advances HERE, on a successful write — not after the mine.
  //
  // Why: the export is cheap and idempotent (same content -> same filename,
  // so a re-export overwrites itself), while the mine is expensive and fails
  // for reasons outside our control (lock contention, exit kill, OOM). When
  // the cursor waited for the mine, a mine that never finished pinned it
  // forever: every later export re-cut the window from the stale cursor, and
  // since the session kept growing each file was a SUPERSET of the previous
  // one. 691 overlapping files were produced that way, and mining them all
  // multiplied every message by up to 691 (628k drawers, 5GB).
  //
  // Advancing on write keeps every window disjoint: the next export starts
  // where this one stopped. Nothing is lost when a mine fails — the pending
  // file IS the queue, and the next mine picks it up untouched.
  //
  // `cursor` is the running minimum over in-flight replies, so this never
  // skips past a reply that was still streaming when we looked.
  for (const wing of coveredWings) markSynced(cursor, wing)
  if (coveredWings.size > 0) {
    log(`cursors advanced on write: ${[...coveredWings].join(", ")} -> ${new Date(cursor).toISOString()}`)
  }

  return { wings, now: cursor, exportedIds: exportedByWing }
}

function markSynced(now: number, wing?: string): void {
  try {
    const st = readSyncState()
    if (wing) {
      st.wings = st.wings || {}
      st.wings[wing] = now
      const vals = Object.values(st.wings)
      st.last_sync_ms = vals.length > 0 ? Math.min(...vals) : now
    } else {
      st.last_sync_ms = now
    }
    writeFileSync(STATE_FILE, JSON.stringify(st))
  } catch (e) { log("state write err: " + String(e)) }
  lastSyncTs = Date.now()
}

// Default `exchange` extraction: one drawer per exchange pair, verbatim,
// no paraphrasing (see PR #1524 review). Intelligent filing (decisions,
// KG facts, diary) happens through AI checkpoints, not the miner.
// Agent tag keeps opencode-mined drawers attributable.
// One wing per project (official multi-project pattern).
// Argv array, no shell (see PR #2): wing names are sanitized, but the
// spawn path stays shell-free regardless.
function mineArgs(wingDir: string, wing: string): string[] {
  return ["mine", wingDir, "--mode", "convos", "--agent", "opencode", "--wing", wing]
}

function cleanupExport(wings: Map<string, string[]>): void {
  // Wipe whole wing dirs: a successful mine filed everything in them,
  // including orphan files from previously failed runs.
  for (const wing of wings.keys()) {
    try {
      for (const f of readdirSync(join(OUT_DIR, wing))) {
        try { unlinkSync(join(OUT_DIR, wing, f)) } catch {}
      }
    } catch {}
    try { rmdirSync(join(OUT_DIR, wing)) } catch {}
  }
  try { rmdirSync(OUT_DIR) } catch {}
}

function wingCount(wings: Map<string, string[]>): number {
  let n = 0
  for (const files of wings.values()) n += files.length
  return n
}

// Queue alarm. A pile of pending files means mines are not draining: the
// palace silently stops receiving memories while the transcript DB keeps
// growing. This exact silence is what hid the 5GB blow-up, so it is worth a
// line in hook.log (and therefore in /memory-status) at a low threshold.
const BACKLOG_ALARM_FILES = 20
function warnIfBacklogPiling(): void {
  const pending = countPendingFiles()
  if (pending <= BACKLOG_ALARM_FILES) return
  const perWing: string[] = []
  try {
    for (const w of readdirSync(SYNC_DIR, { withFileTypes: true })) {
      if (!w.isDirectory()) continue
      const n = readdirSync(join(SYNC_DIR, w.name)).length
      if (n > 0) perWing.push(`${w.name}=${n}`)
    }
  } catch {}
  hookLog(`WARNING: ${pending} exported files waiting to be mined (${perWing.join(" ") || "?"}) — mines are not draining, the palace is falling behind`)
}

function doDbSync(): void {
  if (lastSyncTs && Date.now() - lastSyncTs < 5000) return
  try { warnIfBacklogPiling() } catch {}

  const sinceMs = backfillRequested() ? 0 : getLastSync()
  if (backfillRequested()) log("backfill requested: exporting full history")
  const cursorFor = backfillRequested()
    ? (_wing: string | null) => 0
    : (wing: string | null) => (wing ? getLastSync(wing) : getLastSync())

  const { wings, exportedIds } = exportNewSessions(cursorFor)
  if (wings.size === 0) return

  miningLock = true
  statusPhase = "mining"
  statusWing = [...wings.keys()].join(",")
  statusError = ""
  // The run's progress baseline: which wings, and how full the palace is
  // now. A 2s poll refreshes the live count while the mine runs; the TUI
  // shows the delta. Cleared on every terminal path (done, error, busy).
  stopMinePoll()
  mineWingsTotal = wings.size
  mineWingIndex = 0
  mineDrawersBaseline = palaceDrawersNow()
  mineDrawersNow = mineDrawersBaseline
  minePoll = setInterval(() => {
    mineDrawersNow = palaceDrawersNow()
    writeStatus(true)
  }, 2000)
  writeStatus(true)
  log(`mining ${wingCount(wings)} sessions across ${wings.size} wings`)

  const entries = [...wings.entries()]
  // Per-wing drawers tally for the final toast (parsed from mine stdout).
  const wingDrawers = new Map<string, number>()
  const parseDrawers = (stdout: unknown): number => {
    const m = String(stdout || "").match(/Drawers filed:\s*(\d+)/i)
    return m ? parseInt(m[1], 10) : 0
  }
  // Retry schedule for lock contention: two instances (or an MCP write)
  // interleave wing by wing instead of starving each other. Total ~10min
  // of retries per wing, then give up until the next trigger (idle/exit).
  // miningLock stays held during backoff so one process never piles up.
  const RETRY_DELAYS_MS = [15000, 30000, 60000, 120000, 180000, 300000]
  const jitter = (ms: number) => ms + Math.floor(Math.random() * 10000)
  const mineNext = (i: number, attempt = 0): void => {
    if (i >= entries.length) {
      miningLock = false
      stopMinePoll()
      cleanupExport(wings)
      log("mine done")
      const names = [...wings.keys()].join(", ")
      const totalDrawers = [...wingDrawers.values()].reduce((a, b) => a + b, 0)
      const detail = totalDrawers > 0 ? ` (${totalDrawers} drawers)` : ""
      // Anything that arrived while this mine was running stays pending.
      const remaining = countPendingMessages()
      const tail = remaining.total > 0 ? `, ${remaining.total} message(s) still waiting` : ", queue empty"
      toast("success", "MemPalace", `mined ${wingCount(wings)} session(s) → ${names}${detail}${tail}`)
      ilog("mine", { outcome: "ok", sessions: wingCount(wings), wings: [...wings.keys()], drawers: totalDrawers, remaining: remaining.total })
      return
    }
    const [wing, files] = entries[i]
    // Current wing, every attempt: this also repairs the phase between
    // wings, which used to sit at "idle" after each wing finished because
    // only the run start set "mining".
    mineWingIndex = i
    statusPhase = "mining"
    statusWing = wing
    writeStatus(true)
    // No timeout here by design (see PR #4): Node would kill only the
    // wrapper shell and orphan the python mine process, which keeps
    // holding the palace lock while the next mine piles up. miningLock
    // already serializes concurrent mines; long mines run to completion.
    const bin = resolveBin()
    if (!bin) { miningLock = false; stopMinePoll(); errLog("mine skipped: mempalace CLI not found"); return }
    execFile(bin, mineArgs(join(OUT_DIR, wing), wing), {
      encoding: "utf-8",
      maxBuffer: CHILD_MAX_BUFFER,
    }, (err, stdout) => {
      if (err) {
        const msg = err.message || String(err)
        // Lock contention (second opencode instance mining, or an MCP
        // write in flight) is routine, not a failure: back off and retry
        // the same wing — the holder releases between its own wings, so
        // concurrent instances interleave instead of starving. Anything
        // else is a real error.
        if (/is held by/i.test(msg) && attempt < RETRY_DELAYS_MS.length) {
          const wait = jitter(RETRY_DELAYS_MS[attempt])
          log(`palace busy (${wing}), retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(wait / 1000)}s`)
          const nowTs = Date.now()
          if (nowTs - lastBusyToastTs > BUSY_TOAST_WINDOW_MS) {
            lastBusyToastTs = nowTs
            toast("info", "MemPalace", "palace busy (another instance mining?) — backing off, will retry")
          }
          setTimeout(() => mineNext(i, attempt + 1), wait)
          return
        }
        miningLock = false
        if (/is held by/i.test(msg)) {
          statusPhase = "busy"
          statusWing = wing
          stopMinePoll()
          statusEvent("mine", { outcome: "busy", wing })
          log(`mine skipped, palace busy (${wing}) after ${attempt} retries — next trigger will retry`)
          ilog("mine", { outcome: "busy", wing })
          return
        }
        errLog(`mine err (${wing}): ${msg}`)
        statusPhase = "error"
        statusWing = wing
        statusError = msg.slice(0, 200)
        stopMinePoll()
        writeStatus(true)
        toast("error", "MemPalace", `mine failed (${wing}): ${msg.slice(0, 120)}`)
        ilog("mine", { outcome: "error", wing, error: msg.slice(0, 200) })
        return
      }
      log(`mined wing ${wing} (${files.length} sessions)`)
      wingDrawers.set(wing, parseDrawers(stdout))
      statusPhase = "idle"
      statusWing = ""
      statusError = ""
      statusEvent("mine", { outcome: "ok", wing, drawers: wingDrawers.get(wing) || 0 })
      // The cursor already advanced when these files were written, so a
      // successful mine has no cursor work left to do — it only files the
      // content and releases the queue.
      // Only THIS wing's message IDs are recorded: other wings' content
      // is not filed yet, recording it would skip it forever on failure.
      commitExportedIds(new Map([[wing, exportedIds.get(wing) || new Map()]]))
      for (const f of files) { try { unlinkSync(f) } catch {} }
      try { rmdirSync(join(OUT_DIR, wing)) } catch {}
      // Truthful progress: one toast per completed wing (an exact % is
      // impossible — the mine CLI is a black box with ~4s startup cost
      // per invocation, so per-file mines would only add overhead).
      toast("info", "MemPalace", `wing ${wing} done (${i + 1}/${entries.length})`)
      mineNext(i + 1)
    })
  }
  mineNext(0)
}

// Best-effort synchronous save for process exit (SIGINT/SIGTERM/exit):
// only synchronous calls are allowed here. Bounded by EXIT_BUDGET_MS so
// shutdown stays fast; miningLock is deliberately ignored here because
// any in-flight async mine dies with the process — at exit this sync
// mine takes ownership (see PR #1524 review).
const EXIT_BUDGET_MS = 45000
const EXIT_WING_TIMEOUT_MS = 30000
// A wing whose queue is bigger than this cannot be mined inside the exit
// budget, and trying anyway is worse than not trying: the mine is killed at
// the timeout having filed part of the backlog, and the next startup faces
// the same wall. Measured on a 1-core VPS: 6.6 MB of conversations took over
// 40 minutes, so the budget is not close. A backlog this size is drained by
// the in-session mine, which has no timeout by design — the exit path only
// exists to catch up on the small tail.
const EXIT_MAX_QUEUE_BYTES = 2 * 1024 * 1024

function exitSync(): void {
  try {
    const bin = resolveBin()
    if (!bin) return
    const { wings, exportedIds } = exportNewSessions((wing) => (wing ? getLastSync(wing) : getLastSync()))
    if (wings.size === 0) return
    const deadline = Date.now() + EXIT_BUDGET_MS
    const done: string[] = []
    let locked = false
    for (const [wing] of wings) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { log("exit save: budget exhausted, rest covered next startup"); break }
      const files = wings.get(wing) || []
      let bytes = 0
      for (const f of files) {
        try { bytes += statSync(f).size } catch {}
      }
      if (bytes > EXIT_MAX_QUEUE_BYTES) {
        log(
          `exit save: wing ${wing} has ${files.length} files / ${(bytes / 1048576).toFixed(1)}MB, ` +
            `over the ${(EXIT_MAX_QUEUE_BYTES / 1048576).toFixed(0)}MB the exit budget can cover — ` +
            `left for the in-session mine (no timeout), not killed halfway here`,
        )
        continue
      }
      log(`exit save: mining wing ${wing}`)
      const res = spawnSync(bin, mineArgs(join(OUT_DIR, wing), wing), {
        encoding: "utf-8",
        timeout: Math.min(EXIT_WING_TIMEOUT_MS, remaining),
        maxBuffer: CHILD_MAX_BUFFER,
      })
      if (res.error || res.status !== 0) {
        // The cause lives on stderr, not in the error object: the process ran
        // and exited non-zero, so res.error is undefined and res.status is
        // just the number. Logging the status produced 801 identical lines
        // reading "exit mine err (wing): 1" — the real message was there all
        // along, on stderr, and threw away. An error that does not report its
        // cause is worse than no error.
        const detail = String(res.stderr || "").trim()
        const why = (res.error as any)?.message || detail || (res as any).signal || res.status
        errLog(`exit mine err (${wing}): ${String(why).slice(0, 300)}`)
        // A palace held by the MCP server is contention, not a failure, and it
        // applies to every wing equally. Bailing out here meant one blocked
        // wing abandoned all the others that could have drained. Skip this
        // one and keep going, exactly as the in-session path does.
        if (/is held by/i.test(String(why))) {
          locked = true
          continue
        }
        return
      }
      commitExportedIds(new Map([[wing, exportedIds.get(wing) || new Map()]]))
      done.push(wing)
    }
    for (const wing of done) {
      for (const f of wings.get(wing) || []) { try { unlinkSync(f) } catch {} }
      try { rmdirSync(join(OUT_DIR, wing)) } catch {}
    }
    try { rmdirSync(OUT_DIR) } catch {}
    if (locked) {
      // Say it once, in the status the TUI reads, so the footer can say WHY
      // the queue is not draining instead of leaving the user to guess.
      statusPhase = "busy"
      statusError = "palazzo occupato da un altro processo"
      writeStatus(true)
      log("exit save: palace is held by another process — queue left for the in-session mine")
    }
    log("exit save done")
  } catch (e) { errLog("exit save err: " + String(e)) }
}

// Shared runtime init for both entrypoints (V1 server() and V2 setup()).
// Runs once per process: on V2 the server may instantiate one plugin per
// location, but timers, exit handlers and the startup sync must not repeat.
function initRuntime(client: any): void {
  tuiClient = client || null
  if (runtimeInit) return
  runtimeInit = true
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(HOOK_STATE_DIR, { recursive: true })
  autoInject = isAutoInjectEnabled()
  identity = readIdentity()
  interval = saveInterval()
  writeStatus(true)
  log(`loaded (autoInjectContext: ${autoInject}, saveInterval: ${interval})`)

  // Catch anything missed by a previous run (e.g. content skipped when
  // the exit budget ran out). Fires once per server lifetime.
  setTimeout(() => dbSync(), 10000)

  // Startup toast (delayed so the TUI is attached): shows exactly which
  // plugin build is loaded — no more guessing npm-cache vs local build —
  // plus pending backlog so a restarted-into-backlog state is visible.
  // (No TUI client on V2 server runtime: toast() degrades to a silent no-op.)
  setTimeout(() => {
    toast("info", "MemPalace", `${pluginName()} v${pluginVersion()} loaded${countPendingSuffix()}`)
    log(`startup toast fired (${pluginName()} v${pluginVersion()})`)
  }, 15000)

  // Crash safety: best-effort synchronous save on hard exit.
  // Mirrors the official emergency-save intent (nothing async allowed here).
  // SIGHUP included: closing the terminal / dropping SSH kills the process
  // group, otherwise mines would die mid-run with no save attempt.
  let exitHandled = false
  const onExit = () => {
    if (exitHandled) return
    exitHandled = true
    exitSync()
  }
  process.once("SIGINT", onExit)
  process.once("SIGTERM", onExit)
  process.once("SIGHUP", onExit)
  process.once("exit", onExit)
}

// V1 entrypoint (object form, supported by OpenCode >= 1.18.29).
async function server({ client }: any): Promise<any> {
  initRuntime(client)

  return {
    "chat.message": async (input: any, output: any) => {
      const role = (output.message as any).role
      if (role !== "user") return
      const text = hasText(output.parts || [])
      if (!text) return
      const sessionID = (input as any)?.sessionID || "global"

      // Official Save-hook cadence: count human messages per session,
      // persist like ~/.mempalace/hook_state/, arm ONE AI checkpoint
      // per boundary. The model decides WHAT to file.
      // NOTE: no mine here by design (see PR #1524 review) — mining a
      // mid-reply snapshot would export partial assistant parts. Mines
      // run on idle/exit/startup, when turns are complete; the export
      // additionally skips unfinished replies (finish tracking).
      const counters = loadCounters()
      const c = counters[sessionID] || { humanMsgs: 0, lastCheckpoint: 0 }
      c.humanMsgs += 1
      const boundary = Math.floor(c.humanMsgs / interval)
      if (boundary > c.lastCheckpoint) {
        c.lastCheckpoint = boundary
        pendingCheckpoint = { sessionID, count: c.humanMsgs }
        hookLog(`session ${sessionID}: ${c.humanMsgs} human msgs — checkpoint armed`)
        ilog("checkpoint", { sessionID, count: c.humanMsgs })
        toast("info", "MemPalace", `checkpoint armed (~${c.humanMsgs} msgs): the model will file memories now`)
      }
      counters[sessionID] = c
      persistCounters(counters)
    },

    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      if (!output?.messages?.length) return

      const injectParts: any[] = []
      const lastUser = [...output.messages].reverse().find((m: any) => m.info?.role === "user")

      // AI checkpoint (works with or without autoInject: filing happens
      // through the MemPalace MCP tools, the hook only decides WHEN).
      if (pendingCheckpoint && lastUser) {
        injectParts.push({
          id: `mp-checkpoint-${Date.now()}`,
          type: "text",
          synthetic: true,
          text: checkpointInstruction(pendingCheckpoint.count),
        })
        log(`checkpoint injected (~${pendingCheckpoint.count} msgs)`)
        hookLog(`checkpoint injected for session ${pendingCheckpoint.sessionID}`)
        pendingCheckpoint = null
      }

      if (!autoInject) {
        if (injectParts.length > 0 && lastUser) lastUser.parts.push(...injectParts)
        return
      }
      if (!lastUser) return

      const query = hasText(lastUser.parts || [])
      if (!query && injectParts.length === 0) return

      if (!wakeupDone) {
        wakeupDone = true
        if (identity) {
          injectParts.push({
            id: `mp-identity-${Date.now()}`,
            type: "text",
            synthetic: true,
            text: `[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`,
          })
        }
      }

      if (query) {
        const memories = mempalaceSearch(query)
        if (memories) {
          injectParts.push({
            id: `mp-recall-${Date.now()}`,
            type: "text",
            synthetic: true,
            text: `[MemPalace Recall]\n${memories}\n[/MemPalace Recall]`,
          })
        }
      }

      if (injectParts.length > 0) {
        lastUser.parts.push(...injectParts)
        log(`injected ${injectParts.length} context blocks`)
      }
    },

    // Official PreCompact pattern: compaction ALWAYS warrants a save.
    // Instruct the model to file everything via MCP now, and re-attach
    // identity + wake-up context so the summary cannot lose them (rescue).
    "experimental.session.compacting": async (input: any, output: any) => {
      const sessionID = (input as any)?.sessionID || "unknown"
      log(`compacting session ${sessionID} - emergency save + rescue`)
      hookLog(`pre-compact emergency save for session ${sessionID}`)
      output.context.push(precompactInstruction())
      const rescue: string[] = []
      if (identity) rescue.push(`[MemPalace Identity]\n${identity}`)
      const wakeup = mempalaceWakeup()
      if (wakeup) rescue.push(`[MemPalace Wake-up]\n${wakeup}`)
      if (rescue.length > 0) {
        output.context.push(`[MemPalace Rescue — core memory, must survive compaction]\n${rescue.join("\n\n")}`)
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      try {
        const name = (input as any)?.tool || ""
        if (!isMemPalaceTool(name)) return
        const summary = summarizeToolCall(name, (input as any)?.args, output)
        log(`tool: ${summary}`)
        toast("info", "MemPalace", summary)
        // Diagnostic: MCP results may live outside `output` — record the
        // real shape once so extraction can be fixed (see answered-empty).
        const outAny = (output as any) || {}
        ilog("tool", {
          tool: String(name).replace(/^mcp_+/, "").replace(/^mempalace_mempalace_/, "").replace(/^mempalace_/, ""),
          asked: (() => { try { return JSON.stringify((input as any)?.args || {}).replace(/\s+/g, " ").slice(0, 200) } catch { return "" } })(),
          answered: extractResultText(output).replace(/\s+/g, " ").slice(0, 300),
          shape: {
            keys: Object.keys(outAny),
            title: outAny.title,
            metaKeys: outAny.metadata && typeof outAny.metadata === "object" ? Object.keys(outAny.metadata) : typeof outAny.metadata,
            raw: JSON.stringify(outAny).slice(0, 300),
          },
        })
      } catch {}
    },

    event: async ({ event }: any) => {
      if (event?.type === "session.idle" || event?.type === "session.deleted") {
        log(`${event.type} - queue sync`)
        setTimeout(() => dbSync(), 3000)
      }
    },
  }
}

// V2 entrypoint: 1:1 port of the V1 hooks above onto the V2 plugin API
// (Plugin.define + ctx hook registrations). Shared helpers and module
// state are reused verbatim; only the event shapes changed.
const mempalaceV2 = PluginV2.define({
  id: "opencode-mempalace-persistence",
  async setup(ctx) {
    initRuntime(null)

    // Port of V1 "chat.message": count admitted human prompts per session,
    // arm one AI checkpoint per save-interval boundary.
    await ctx.session.hook("prompt", (event: any) => {
      if (!rememberPromptID(String(event?.messageID || ""))) return
      const text = (event?.prompt?.text || "").trim()
      if (!text) return
      const sessionID = event?.sessionID || "global"
      const counters = loadCounters()
      const c = counters[sessionID] || { humanMsgs: 0, lastCheckpoint: 0 }
      c.humanMsgs += 1
      const boundary = Math.floor(c.humanMsgs / interval)
      if (boundary > c.lastCheckpoint) {
        c.lastCheckpoint = boundary
        pendingCheckpoint = { sessionID, count: c.humanMsgs }
        hookLog(`session ${sessionID}: ${c.humanMsgs} human msgs — checkpoint armed`)
        ilog("checkpoint", { sessionID, count: c.humanMsgs })
        toast("info", "MemPalace", `checkpoint armed (~${c.humanMsgs} msgs): the model will file memories now`)
      }
      counters[sessionID] = c
      persistCounters(counters)
    })

    // Port of V1 "experimental.chat.messages.transform": inject the armed
    // checkpoint, identity and recall hits as text parts of the last user
    // message (V2 Message shape: { role, content: [{ type: "text", text }] }).
    await ctx.session.hook("context", (event: any) => {
      const messages = event?.messages
      if (!Array.isArray(messages) || messages.length === 0) return
      const lastUser = [...messages].reverse().find((m: any) => m?.role === "user")
      const injectTexts: string[] = []
      if (pendingCheckpoint && lastUser) {
        injectTexts.push(checkpointInstruction(pendingCheckpoint.count))
        log(`checkpoint injected (~${pendingCheckpoint.count} msgs)`)
        hookLog(`checkpoint injected for session ${pendingCheckpoint.sessionID}`)
        pendingCheckpoint = null
      }
      if (autoInject && lastUser) {
        const query = (lastUser.content || [])
          .filter((p: any) => p?.type === "text" && p?.text?.trim())
          .map((p: any) => String(p.text).trim())
          .join("\n")
        if (!wakeupDone) {
          wakeupDone = true
          if (identity) injectTexts.push(`[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`)
        }
        if (query) {
          const memories = mempalaceSearch(query)
          if (memories) injectTexts.push(`[MemPalace Recall]\n${memories}\n[/MemPalace Recall]`)
        }
      }
      if (injectTexts.length > 0 && lastUser) {
        lastUser.content ??= []
        for (const text of injectTexts) lastUser.content.push({ type: "text", text })
        log(`injected ${injectTexts.length} context blocks`)
      }
    })

    // Port of V1 "experimental.session.compacting": V2 has no output.context,
    // so the emergency-save + rescue instructions go to the summary
    // request's system prompt instead.
    await ctx.session.hook("compaction", (event: any) => {
      const sessionID = event?.sessionID || "unknown"
      log(`compacting session ${sessionID} - emergency save + rescue`)
      hookLog(`pre-compact emergency save for session ${sessionID}`)
      if (!Array.isArray(event?.system)) return
      event.system.push({ type: "text", text: precompactInstruction() })
      const rescue: string[] = []
      if (identity) rescue.push(`[MemPalace Identity]\n${identity}`)
      const wakeup = mempalaceWakeup()
      if (wakeup) rescue.push(`[MemPalace Wake-up]\n${wakeup}`)
      if (rescue.length > 0) {
        event.system.push({ type: "text", text: `[MemPalace Rescue — core memory, must survive compaction]\n${rescue.join("\n\n")}` })
      }
    })

    // Port of V1 "tool.execute.after": V2 delivers one event with
    // { tool, input, status, result | error } instead of (input, output).
    await ctx.tool.hook("execute.after", (event: any) => {
      try {
        const name = event?.tool || ""
        if (!isMemPalaceTool(name)) return
        const out = event?.status === "completed"
          ? event?.result
          : { output: String(event?.error?.message || event?.error || "") }
        const summary = summarizeToolCall(name, event?.input, out)
        log(`tool: ${summary}`)
        toast("info", "MemPalace", summary)
        const outAny = (out as any) || {}
        ilog("tool", {
          tool: String(name).replace(/^mcp_+/, "").replace(/^mempalace_mempalace_/, "").replace(/^mempalace_/, ""),
          asked: (() => { try { return JSON.stringify(event?.input || {}).replace(/\s+/g, " ").slice(0, 200) } catch { return "" } })(),
          answered: extractResultText(out).replace(/\s+/g, " ").slice(0, 300),
          shape: {
            keys: Object.keys(outAny),
            title: outAny.title,
            metaKeys: outAny.metadata && typeof outAny.metadata === "object" ? Object.keys(outAny.metadata) : typeof outAny.metadata,
            raw: JSON.stringify(outAny).slice(0, 300),
          },
        })
      } catch {}
    })

    // Port of the V1 `event` hook: mine on idle/exit of a session.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as any)?.type
          if (type === "session.idle" || type === "session.deleted") {
            log(`${type} - queue sync`)
            setTimeout(() => dbSync(), 3000)
          }
        }
      } catch {}
    })()
    return () => controller.abort()
  },
})

// Dual entrypoint: V2 calls setup(), V1 (>= 1.18.29) calls server().
// The V1 hook implementation above is untouched, so opencode-v1 keeps working.
export default { ...mempalaceV2, server }
