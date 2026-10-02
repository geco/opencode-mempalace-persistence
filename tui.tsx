/** @jsxImportSource @opentui/solid */
/**
 * MemPalace TUI status line (OpenCode v2).
 *
 * Loaded through the `./tui` export of this package. Two details that are not
 * obvious and cost real time to find, both from packages/plugin/src/host.ts:17:
 *
 *   const specifier = target.name
 *     ? [target.name, subpath].filter(Boolean).join("/")   // package -> "name/tui"
 *     : path.resolve(target.directory, subpath || "index") // local dir -> <dir>/tui
 *
 * 1. For a PACKAGE (how this ships), the entry must be reachable as
 *    "<package-name>/tui", i.e. declared in this package's `exports` map.
 *    For a local DIRECTORY the file must be literally named `tui` — which is
 *    why a plain `index.tsx` is never a TUI candidate.
 * 2. The TUI plugin filesystem is READ-ONLY. A write is refused silently, so
 *    this side never writes: the server plugin publishes
 *    ~/.mempalace/hook_state/status.json and this polls it.
 *
 * Shipped uncompiled on purpose: opencode transpiles the TSX itself and
 * provides the JSX factory, so `@opentui/solid` (14M) is NOT a dependency.
 * The only runtime import is solid-js, for the signals that drive the bar.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createSignal, onCleanup } from "solid-js"

const HOME = homedir()
const STATUS_FILE = join(HOME, ".mempalace/hook_state/status.json")
const QUEUE_DIR = join(HOME, ".mempalace/oc-sessions")

type Phase = "idle" | "mining" | "busy" | "error" | "unknown"
type Status = {
  ts?: string
  phase: Phase
  wing?: string
  pending: number
  last?: { kind?: string; outcome?: string; drawers?: number; wing?: string; at?: string }
  error?: string
  plugin?: string
  wingIndex?: number
  wingsTotal?: number
  runDone?: number
  runTotal?: number
  drawersBaseline?: number
  drawersNow?: number
  mineStartedAt?: string
  waiting?: boolean
  fileIndex?: number
  filesTotal?: number
  fileName?: string
  fileFiled?: number
  fileTotal?: number | null
  lastRun?: { wings: number; files: number; drawers: number; at: string }
  querying?: { tool: string; text: string; startedAt?: string }
  lastQuery?: { tool: string; text: string | null; at: string; count: number | null }
  blockedBy?: string
}

const readStatus = (): Status => {
  try {
    const raw = JSON.parse(readFileSync(STATUS_FILE, "utf-8")) as Status
    return { phase: "idle", pending: 0, ...raw }
  } catch {
    return { phase: "unknown", pending: 0 }
  }
}

// The queue is counted here rather than read from status.json, because that
// field is a snapshot taken when an event was last logged. The plugin writes it
// BEFORE deleting a mined wing's files and never refreshes it afterwards, so
// right after a mine finished the line kept showing the pre-mine count. The
// directory is the truth; reading it costs one readdir per second.
type Queue = { count: number; oldest: number }

const readQueue = (): Queue => {
  let count = 0
  let oldest = 0
  try {
    for (const w of readdirSync(QUEUE_DIR, { withFileTypes: true })) {
      if (!w.isDirectory()) continue
      let entries: string[] = []
      try {
        entries = readdirSync(join(QUEUE_DIR, w.name)).filter((n) => n.endsWith(".txt"))
      } catch {
        continue
      }
      count += entries.length
      for (const n of entries) {
        try {
          const m = statSync(join(QUEUE_DIR, w.name, n)).mtimeMs
          if (m > 0 && (oldest === 0 || m < oldest)) oldest = m
        } catch {}
      }
    }
  } catch {}
  return { count, oldest }
}

const ink = (map: any, name: string, fallback: string) => {
  const v = map?.[name]
  return typeof v === "string" ? v : fallback
}
// The published 2.0.19 types expose `theme` as the resolved map; newer builds
// wrap it in { current }. Accept both so an upgrade cannot silently drop every
// colour to the fallback.
const skinOf = (theme: any) => ({
  muted: ink(theme, "textMuted", "#a5a5a5"),
  accent: ink(theme, "primary", "#5f87ff"),
  success: ink(theme, "success", "#3fb950"),
  warning: ink(theme, "warning", "#d29922"),
  error: ink(theme, "error", "#f85149"),
})

const FILLED = "█"
const EMPTY = "░"
const GAUGE_MAX = 24

// Sweep glyph, different on purpose: with the same glyph the window is
// invisible while it sits over the filled part, so a slow batch would look
// frozen for minutes.
const SWEEP = "▓"

// How long something has been going, as a short span. The label already says
// what is being measured ("running for", "waiting"), and a second clock on
// the same line was what made an earlier version unreadable.
const span = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

// "idle" means no mine is running, NOT that there is nothing to do. A queue
// waiting to be drained while the plugin sits idle is exactly the state that
// needed surfacing, and reporting it as plain idle is what made a stuck
// 16-file queue look healthy. Backlog is its own state, and it is not green.
//
// working() is "mining" only. "busy" is always terminal — it is set when the
// retries are exhausted and the run is over — so treating it as active showed
// a dead run as "running for just started". While backing off between
// retries the phase stays "mining" with waiting=true instead.
const working = (s: Status) => s.phase === "mining"
const backlogged = (s: Status, q: Queue) => !working(s) && q.count > 0

// Third row, above the two permanent lines, in two forms that never
// coexist. While a read runs: ◇ MP searching "asdfasdf asdf .."
// (hollow diamond: transient question, not a condition). Otherwise, if any
// read completed this session: ◇ MP last search: 2m ago (5 res)
// (muted: history, not activity; no text — the in-flight line had it).
//   ◇        hollow diamond: same family as the ◆ semaphore, hollow because
//            this state is transient (a question, not a condition)
//   18       max query chars, so the whole line stays within ~37 columns
//            and never wraps: 16 of fixed tokens + 18 + 3 for ..". The
//            sidebar is 42 wide by default but clamps 5..72, so like the
//            bar this is safe, not exact — on very narrow layouts any long
//            footer line wraps, this one is just the shortest of them.
//   .."      dots inside the quotes, only when truncated.
const QUERY_MAX = 18

const queryLine = (qq: { tool: string; text: string }): string => {
  const clean = qq.text.replace(/\s+/g, " ").trim()
  const shown = clean.length > QUERY_MAX ? clean.slice(0, QUERY_MAX) + ".." : clean
  return `◇ MP searching "${shown}"`
}

// Idle form of the same row: the last completed read, if any. Same row
// position as the in-flight line (they never coexist), muted instead of
// accent: history, not activity. No text shown — the in-flight line already
// had it; here only tool, age and result count.
const lastQueryLine = (lq: { tool: string; at: string; count: number | null }): string => {
  const at = lq.at ? Date.parse(lq.at) : 0
  const age = at ? ` ${span(at)} ago` : ""
  const n = typeof lq.count === "number" && lq.count >= 0 ? ` (${lq.count} res)` : ""
  return `◇ MP last ${lq.tool}:${age}${n}`
}

// Thousand grouping, done by hand: toLocaleString silently returns ungrouped
// digits on runtimes without full ICU data (seen: "1240" instead of "1,240"),
// and a counter that sometimes groups and sometimes does not is worse than
// one that never does.
const grouped = (n: number) =>
  String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

// The footer is two lines: a status line of compact tokens, and a TRUE
// progress bar underneath.
//
// Line 1 (mining):  ◆ MP mining 4/10 q8 w2/2 for 6m +1,240
//   ◆        semaphore: green idle, blue mining, yellow queue/blocked, red error
//   MP       fixed tag (was "MemPalace", shortened — the bar below says it too)
//   mining   phase: mining | queue | blocked | idle
//   4/10     files completed over files in the current wing, read from the
//            palace (filed source_files), not the mine. Bare on purpose:
//            the q- and w- prefixes mark the other two counters.
//   q8       files currently queued, counted live from the directory
//   w2/2     current wing over wings of this run, known upfront
//   for 6m   elapsed of THIS run (dedicated clock; the status file's own ts
//            is rewritten on every write and flickered 1s/2s when misused)
//   +1,240   drawers the palace gained since run start (all writers counted;
//            in practice the mine, MCP writes are a drawer at a time)
// Line 1 (other states):
//   ◆ MP queue q6 waiting 146h
//   ◆ MP busy q1 21m
//   ◆ MP error q1 21m
//   ◆ MP idle
//
// Line 2 is a REAL fraction, not a gauge: completed files over total files
// of the run, queued arrivals included (they join the denominator when they
// land, so the bar can dip when new work arrives — honest). New files that
// arrive mid-run belong to the next run's scope for the miner, but they sit
// in the same directory, so they count here. Monotonic within a run except
// for that case. 24 cells; the ▓▓▓ window sweeps while mining so a slow
// batch (minutes between commits) still looks alive. Idle with a queue: the
// bar is empty (nothing elaborated). Idle with nothing queued: full — the
// work is done. No percentage anywhere: a fraction of files is exact, a
// percentage of "done" would be invented.
const runFrac = (s: Status): number => {
  if (s.phase === "mining" && typeof s.runTotal === "number" && s.runTotal > 0) {
    return Math.max(0, Math.min(1, (s.runDone ?? 0) / s.runTotal))
  }
  // Idle is always an empty bar, even with nothing queued: a full bar reads
  // as garish when there is nothing running, and "done" is said by the line
  // above (idle + last run summary), not by the bar. The mining fill, in
  // accent color, is then unmistakably the "executing" state.
  return 0
}

const barLine = (s: Status, tick: number): string => {
  const frac = runFrac(s)
  const filled = Math.max(0, Math.min(GAUGE_MAX, Math.round(frac * GAUGE_MAX)))
  const cells: string[] = Array.from({ length: GAUGE_MAX }, (_, i) => (i < filled ? FILLED : EMPTY))
  if (s.phase === "mining") {
    const head = Math.abs(tick) % GAUGE_MAX
    for (let i = 0; i < 3; i++) cells[(head + i) % GAUGE_MAX] = SWEEP
  }
  // End caps, not full width, on purpose: the sidebar is 42 columns by
  // default but clamps dynamically between 5 and 72 with the terminal
  // (SESSION_SIDEBAR_WIDTH / clampSessionTabsWidth), and the plugin API
  // exposes no element measurement — only terminal dimensions. Matching an
  // exact width would mean reimplementing host layout logic that breaks
  // across versions, and overshooting wraps and breaks the layout. The caps
  // make fullness unambiguous at any width instead: a full bar touches both
  // ends, which is what "is it full or not" actually needed.
  return `[${cells.join("")}]`
}

const line1 = (s: Status, q: Queue): string => {
  if (working(s)) {
    const since = s.mineStartedAt ? Date.parse(s.mineStartedAt) : 0
    const file =
      typeof s.filesTotal === "number" && s.filesTotal > 0 && typeof s.fileIndex === "number" && s.fileIndex > 0
        ? ` ${s.fileIndex}/${s.filesTotal}`
        : ""
    const wing =
      typeof s.wingsTotal === "number" && s.wingsTotal > 0 ? ` w${(s.wingIndex ?? 0) + 1}/${s.wingsTotal}` : ""
    // Reached only when NOT waiting (waiting returns below): the full
    // detail line with live counters.
    // While waiting, frozen counters drop out: file/queue/drawer numbers do
    // not move during backoff, so they cost width for zero information. Only
    // the clock stays, plus the single word "waiting". The holder (who holds
    // the lock) is deliberately NOT shown: a pid is unactionable on a
    // transient holder (a mine finishing in seconds) and stale on a stuck
    // one — it lives in interactions.log (`/memory-log`) where it belongs.
    if (s.waiting) {
      const since = s.mineStartedAt ? Date.parse(s.mineStartedAt) : 0
      const wing =
        typeof s.wingsTotal === "number" && s.wingsTotal > 0 ? ` w${(s.wingIndex ?? 0) + 1}/${s.wingsTotal}` : ""
      return `◆ MP mining${wing} ${since ? span(since) : "just started"} waiting`
    }
    let grown = ""
    if (
      typeof s.drawersBaseline === "number" &&
      typeof s.drawersNow === "number" &&
      s.drawersNow - s.drawersBaseline >= 0
    ) {
      grown = ` +${grouped(s.drawersNow - s.drawersBaseline)}d`
    }
    return `◆ MP mining${file} q${q.count}${wing} ${since ? span(since) : "just started"}${grown}`
  }
  if (q.count > 0) {
    const age = q.oldest ? span(q.oldest) : "a while"
    // When the palace is held by another process the queue is not waiting
    // because nothing wants it: it is waiting because it cannot be written.
    // Two distinct causes, two labels, same shape — "busy" is contention
    // (the lock is held, a later trigger will retry) and "error" is a real
    // failure worth reading in /memory-log. They used to share one line
    // ending in "palace busy", which called a genuine error "busy".
    if (s.phase === "busy") return `◆ MP busy q${q.count} ${age}`
    if (s.error) return `◆ MP error q${q.count} ${age}`
    return `◆ MP queue q${q.count} waiting ${age}`
  }
  // Idle with nothing queued: last completed run in compact tokens.
  const last = s.lastRun
  if (last && last.files > 0) {
    const at = last.at ? Date.parse(last.at) : 0
    return `◆ MP idle ${last.files}fl ${last.wings}wn${at ? ` - ${span(at)} ago` : ""} +${grouped(last.drawers)}dr`
  }
  return "◆ MP idle"
}

export default {
  id: "opencode-mempalace-persistence",
  setup(ctx: any) {
    const skin = skinOf(ctx?.theme?.current ?? ctx?.theme ?? {})

    // Signals must be created inside setup(): at module scope there is no
    // Solid owner to attach them to and the slot can render nothing.
    const [status, setStatus] = createSignal<Status>(readStatus())
    const [queue, setQueue] = createSignal<Queue>(readQueue())
    const [tick, setTick] = createSignal(0)

    // status.json is one small file, and the queue is one directory listing:
    // poll both once a second.
    const poll = setInterval(() => {
      setStatus(readStatus())
      setQueue(readQueue())
      syncAnim()
    }, 1000)

    // The sweep runs only while a mine is in flight; the timer is stopped
    // otherwise, so an idle TUI costs nothing. The first version spun a 140ms
    // timer forever, which is exactly the "never stops moving" feel we dropped.
    let anim: ReturnType<typeof setInterval> | null = null
    const syncAnim = () => {
      // The sweep runs only while a mine is actually in flight. "busy" is
      // terminal (the run gave up waiting), so nothing animates there.
      const want = working(status())
      if (want && anim === null) anim = setInterval(() => setTick((t) => t + 1), 180)
      if (!want && anim !== null) {
        clearInterval(anim)
        anim = null
      }
    }
    syncAnim()
    onCleanup(() => {
      clearInterval(poll)
      if (anim !== null) clearInterval(anim)
    })

    const tone = () => {
      const s = status()
      if (s.phase === "error") return skin.error
      if (s.phase === "busy") return skin.warning
      if (s.phase === "mining") return skin.accent
      if (s.phase === "unknown") return skin.muted
      // A drained queue is genuinely idle; a queue with work in it is not,
      // and must not be reported as if it were.
      if (backlogged(s, queue())) return skin.warning
      return skin.success
    }

    // Two lines only; the label() and summary() split was merged into line1()
    // when the format went compact — one token stream, no duplication.

    // One claim, one place: the sidebar footer. A compact mirror in the prompt
    // footer was tried and removed — two bars showing the same state read as
    // noise, and the prompt line is the most visually loaded area of the TUI.
    // Two permanent lines (status tokens, progress bar) plus the query row
    // above them: the in-flight search while one runs, else the last
    // completed one if any, else nothing. The two query forms never
    // coexist — clearing on completion guarantees it.
    const off = ctx.ui.slot({
      append: "sidebar.footer",
      render: () => {
        const s = status()
        const q = queue()
        return (
          <box flexDirection="column" gap={0} flexShrink={0}>
            {s.querying ? (
              <text fg={skin.accent}>{queryLine(s.querying)}</text>
            ) : s.lastQuery ? (
              <text fg={skin.muted}>{lastQueryLine(s.lastQuery)}</text>
            ) : null}
            <text fg={tone()}>{line1(s, q)}</text>
            <text fg={tone()}>{barLine(s, tick())}</text>
          </box>
        )
      },
    })

    return () => {
      try { off?.() } catch {}
    }
  },
}
