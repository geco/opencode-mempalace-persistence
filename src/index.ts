import { execSync, execFileSync, execFile, spawnSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, unlinkSync, appendFileSync, statSync, readdirSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"
import { createHash } from "crypto"
import { fileURLToPath } from "url"
import type { Plugin } from "@opencode-ai/plugin"

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
function ilog(kind: string, data: Record<string, unknown>): void {
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

// Plugin's own name + version (shown in the startup toast and
// /memory-status, so you always know which build is loaded).
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
    return execFileSync(python, [TMP_SCRIPT], { encoding: "utf-8", timeout: 30000 }).trim()
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
    const out = execFileSync(bin, ["wake-up"], { encoding: "utf-8", timeout: 15000 }).trim()
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

function summarizeToolCall(tool: string, args: any, out: string): string {
  const short = tool.replace(/^mcp_+/, "").replace(/^mempalace_mempalace_/, "").replace(/^mempalace_/, "")
  let asked = ""
  try {
    const a = typeof args === "string" ? args : JSON.stringify(args || {})
    asked = a.replace(/\s+/g, " ").slice(0, 60)
  } catch { asked = "" }
  const answered = (out || "").replace(/\s+/g, " ").slice(0, 80) || "(empty)"
  return `${short} · asked: ${asked} → ${answered}`.slice(0, 220)
}

function getLastSync(): number {
  if (!existsSync(STATE_FILE)) return 0
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")).last_sync_ms || 0 } catch { return 0 }
}

function dbSync(): void {
  if (miningLock) return
  try { doDbSync() } catch (e) { errLog("sync err: " + String(e)) }
}

function backfillRequested(): boolean {
  return !!process.env.OPENCODE_MEMPALACE_BACKFILL
}

// Export all sessions with new messages since `sinceMs` as flat transcripts,
// grouped by project wing (official multi-project pattern: one wing per
// project, so memories never leak across projects). Filenames embed a
// content hash, so re-exports are naturally idempotent.
function exportNewSessions(sinceMs: number): { wings: Map<string, string[]>; now: number } {
  const sessions = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT DISTINCT s.id, s.title, p.worktree, s.directory, s.slug, s.time_created
  FROM session s
  LEFT JOIN project p ON s.project_id = p.id
  INNER JOIN message m ON m.session_id = s.id
  WHERE m.time_created > ${sinceMs}
  ORDER BY s.time_created
""").fetchall()
db.close()
print(json.dumps(rows))
`)

  let sessionsArr: any[][]
  try { sessionsArr = JSON.parse(sessions) } catch { return { wings: new Map(), now: Date.now() } }
  if (!sessionsArr || sessionsArr.length === 0) return { wings: new Map(), now: Date.now() }

  const now = Date.now()
  // Never advance the cursor past an in-flight reply: anything skipped
  // as incomplete is revisited by the next sync (idle/exit/startup).
  let cursor = now
  const wings = new Map<string, string[]>()
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })

  for (const sess of sessionsArr) {
    const [sessId, title, , directory] = sess
    const wing = (((directory as string) || "").split("/").filter(Boolean).pop() || "global")
      .replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "global"
    const label = (title || "").replace(/[^a-zA-Z0-9 _-]/g, "_") || (sessId || "").slice(0, 12)
    const prefix = `${new Date().toISOString().slice(0, 10)}_${label.slice(0, 30)}_${(sessId || "").slice(0, 8)}`

    const msgs = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT m.id, m.time_created, m.data FROM message m
  WHERE m.session_id = ${JSON.stringify(sessId)} AND m.time_created > ${sinceMs}
  ORDER BY m.time_created
""").fetchall()
texts = []
incomplete = []
for (mid, mts, mdata_raw) in rows:
    try: mdata = json.loads(mdata_raw)
    except: mdata = {}
    role = mdata.get("role", "unknown")
    # Completion tracking (see PR #1524 review): the assistant message row
    # is created when a reply STARTS, parts stream in afterwards, and
    # finish is set only on completion. Exporting mid-reply would
    # snapshot partial parts while the cursor advances past the message
    # timestamp — losing the rest of the reply forever. So assistant
    # messages without finish are skipped and revisited next sync.
    if role == "assistant" and not mdata.get("finish"):
        incomplete.append(mts)
        continue
    for (pdata_raw,) in db.execute("SELECT data FROM part WHERE message_id = ? ORDER BY time_created", (mid,)).fetchall():
        try:
            pdata = json.loads(pdata_raw)
            if pdata.get("type") == "text" and pdata.get("text","").strip():
                texts.append({"role": role, "text": pdata.get("text").strip(), "ts": mts})
        except: pass
db.close()
print(json.dumps({"texts": texts, "incomplete": incomplete}))
`)

    let msgList: Array<{ role: string; text: string; ts: number }>
    let incompleteTs: number[] = []
    try {
      const parsed = JSON.parse(msgs) as { texts: typeof msgList; incomplete: number[] }
      msgList = parsed.texts
      incompleteTs = parsed.incomplete || []
    } catch { continue }
    if (incompleteTs.length > 0) {
      cursor = Math.min(cursor, Math.min(...incompleteTs) - 1)
    }
    if (msgList.length < 2 && incompleteTs.length === 0) continue

    const lines: string[] = [
      `# ${title || label}`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      `Session: ${sessId}`,
      "",
    ]
    for (const m of msgList) {
      const ts = m.ts ? new Date(m.ts).toISOString().slice(11, 19) : ""
      lines.push(`## ${m.role.toUpperCase()} \u2014 ${ts}`)
      lines.push("")
      lines.push(m.text)
      lines.push("")
    }

    const content = lines.join("\n").trim()
    if (!content) continue

    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12)
    const wingDir = join(OUT_DIR, wing)
    mkdirSync(wingDir, { recursive: true, mode: 0o700 })
    const fname = `sync_${prefix}_${contentHash}.txt`
    writeFileSync(join(wingDir, fname), content + "\n", { mode: 0o600 })
    if (!wings.has(wing)) wings.set(wing, [])
    wings.get(wing)!.push(join(wingDir, fname))
  }

  return { wings, now: cursor }
}

function markSynced(now: number): void {
  writeFileSync(STATE_FILE, JSON.stringify({ last_sync_ms: now }))
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
  for (const files of wings.values()) {
    for (const f of files) {
      try { unlinkSync(f) } catch {}
    }
  }
  for (const wing of wings.keys()) {
    try { rmdirSync(join(OUT_DIR, wing)) } catch {}
  }
  try { rmdirSync(OUT_DIR) } catch {}
}

function wingCount(wings: Map<string, string[]>): number {
  let n = 0
  for (const files of wings.values()) n += files.length
  return n
}

function doDbSync(): void {
  if (lastSyncTs && Date.now() - lastSyncTs < 5000) return

  const sinceMs = backfillRequested() ? 0 : getLastSync()
  if (backfillRequested()) log("backfill requested: exporting full history")

  const { wings, now } = exportNewSessions(sinceMs)
  if (wings.size === 0) return

  miningLock = true
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
      // Advance state only on full success: on failure the same
      // content-hashed files are re-exported and retried at the next
      // sync (mine is idempotent).
      markSynced(now)
      cleanupExport(wings)
      log("mine done")
      const names = [...wings.keys()].join(", ")
      const totalDrawers = [...wingDrawers.values()].reduce((a, b) => a + b, 0)
      const detail = totalDrawers > 0 ? ` (${totalDrawers} drawers)` : ""
      toast("success", "MemPalace", `mined ${wingCount(wings)} session(s) → ${names}${detail}`)
      ilog("mine", { outcome: "ok", sessions: wingCount(wings), wings: [...wings.keys()], drawers: totalDrawers })
      return
    }
    const [wing, files] = entries[i]
    // No timeout here by design (see PR #4): Node would kill only the
    // wrapper shell and orphan the python mine process, which keeps
    // holding the palace lock while the next mine piles up. miningLock
    // already serializes concurrent mines; long mines run to completion.
    const bin = resolveBin()
    if (!bin) { miningLock = false; errLog("mine skipped: mempalace CLI not found"); return }
    execFile(bin, mineArgs(join(OUT_DIR, wing), wing), {
      encoding: "utf-8",
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
          log(`mine skipped, palace busy (${wing}) after ${attempt} retries — next trigger will retry`)
          ilog("mine", { outcome: "busy", wing })
          return
        }
        errLog(`mine err (${wing}): ${msg}`)
        toast("error", "MemPalace", `mine failed (${wing}): ${msg.slice(0, 120)}`)
        ilog("mine", { outcome: "error", wing, error: msg.slice(0, 200) })
        return
      }
      log(`mined wing ${wing} (${files.length} sessions)`)
      wingDrawers.set(wing, parseDrawers(stdout))
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
function exitSync(): void {
  try {
    const bin = resolveBin()
    if (!bin) return
    const { wings, now } = exportNewSessions(getLastSync())
    if (wings.size === 0) return
    const deadline = Date.now() + EXIT_BUDGET_MS
    for (const [wing] of wings) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { log("exit save: budget exhausted, rest covered next startup"); break }
      log(`exit save: mining wing ${wing}`)
      const res = spawnSync(bin, mineArgs(join(OUT_DIR, wing), wing), {
        encoding: "utf-8",
        timeout: Math.min(EXIT_WING_TIMEOUT_MS, remaining),
      })
      if (res.error || res.status !== 0) { errLog(`exit mine err (${wing}): ${String(res.error || res.status)}`); return }
    }
    markSynced(now)
    cleanupExport(wings)
    log("exit save done")
  } catch (e) { errLog("exit save err: " + String(e)) }
}

export default (async ({ client }: any) => {
  tuiClient = client || null
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(HOOK_STATE_DIR, { recursive: true })
  const autoInject = isAutoInjectEnabled()
  const identity = readIdentity()
  const interval = saveInterval()
  log(`loaded (autoInjectContext: ${autoInject}, saveInterval: ${interval})`)

  // Catch anything missed by a previous run (e.g. content skipped when
  // the exit budget ran out). Fires once per server lifetime.
  setTimeout(() => dbSync(), 10000)

  // Startup toast (delayed so the TUI is attached): shows exactly which
  // plugin build is loaded — no more guessing npm-cache vs local build —
  // plus pending backlog so a restarted-into-backlog state is visible.
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

  return {
    "chat.message": async (input, output) => {
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

    "experimental.chat.messages.transform": async (_input, output) => {
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
    "experimental.session.compacting": async (input, output) => {
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

    "tool.execute.after": async (input, output) => {
      try {
        const name = (input as any)?.tool || ""
        if (!isMemPalaceTool(name)) return
        const summary = summarizeToolCall(name, (input as any)?.args, (output as any)?.output || "")
        log(`tool: ${summary}`)
        toast("info", "MemPalace", summary)
        ilog("tool", {
          tool: String(name).replace(/^mcp_+/, "").replace(/^mempalace_mempalace_/, "").replace(/^mempalace_/, ""),
          asked: (() => { try { return JSON.stringify((input as any)?.args || {}).replace(/\s+/g, " ").slice(0, 200) } catch { return "" } })(),
          answered: String((output as any)?.output || "").replace(/\s+/g, " ").slice(0, 300),
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
}) satisfies Plugin
