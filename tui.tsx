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
  drawersBaseline?: number
  drawersNow?: number
  mineStartedAt?: string
  waiting?: boolean
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

// A bar that fills to 100% and loops back lies about progress: the mine CLI is
// a black box, so there is no real percentage to show, and the first version's
// "0..100 forever" read as a job stuck at 99%. What IS real is the queue
// depth, so the bar is a gauge of it — empty when the queue is drained, fuller
// as the backlog grows. While a mine runs a cursor sweeps over it, so activity
// is visible without inventing a number.
const GAUGE_MAX = 24

const gauge = (pending: number) => {
  const n = Math.max(0, Math.min(GAUGE_MAX, Math.round(pending)))
  return FILLED.repeat(n) + EMPTY.repeat(GAUGE_MAX - n)
}

// Indeterminate sweep: a lit window sliding across the gauge while mining.
// A different glyph on purpose — with the same one the window is invisible
// while it sits over the filled part, so the first seconds of a mine would
// look frozen.
const SWEEP = "▓"

const sweep = (pending: number, step: number) => {
  const cells: string[] = Array.from({ length: GAUGE_MAX }, (_, i) =>
    i < Math.min(GAUGE_MAX, Math.max(0, Math.round(pending))) ? FILLED : EMPTY,
  )
  const head = Math.abs(step) % GAUGE_MAX
  for (let i = 0; i < 3; i++) cells[(head + i) % GAUGE_MAX] = SWEEP
  return cells.join("")
}

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

const PHASE_LABEL: Record<Phase, string> = {
  idle: "idle",
  mining: "mining",
  busy: "palace busy",
  error: "error",
  unknown: "waiting",
}

// Thousand grouping, done by hand: toLocaleString silently returns ungrouped
// digits on runtimes without full ICU data (seen: "1240" instead of "1,240"),
// and a counter that sometimes groups and sometimes does not is worse than
// one that never does.
const grouped = (n: number) =>
  String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

// The one line that answers both questions, with each clock attached to the
// thing it measures:
//
//   mining  -> how long the current mine has been running, which wing of the
//              run it is on, and how many drawers the palace has gained
//   backlog -> how long the oldest queued file has been waiting
//   drained -> nothing to wait for
//
// No percentage: the mine CLI exposes no total to divide by, and an invented
// one reads as a job stuck at 99%. Per-FILE progress does not exist either —
// the miner walks the files silently and only the final summary says what
// was filed — so the "current item" is the wing (known upfront, the plugin
// mines wing by wing) plus the live drawer count. A negative delta (a
// concurrent prune removed rows mid-run) is omitted rather than shown.
//
// The elapsed clock is mineStartedAt, set once when the run starts. The
// status file's own `ts` is rewritten on every write (including the 2s
// progress poll), so using it made the line flicker between "running for 1s"
// and "running for 2s" forever.
const summary = (s: Status, q: Queue) => {
  if (working(s)) {
    const since = s.mineStartedAt ? Date.parse(s.mineStartedAt) : 0
    const wing =
      typeof s.wingsTotal === "number" && s.wingsTotal > 0
        ? ` · w${(s.wingIndex ?? 0) + 1}/${s.wingsTotal}`
        : ""
    const wait = s.waiting ? " · waiting for palace" : ""
    let grown = ""
    if (
      typeof s.drawersBaseline === "number" &&
      typeof s.drawersNow === "number" &&
      s.drawersNow - s.drawersBaseline >= 0
    ) {
      grown = ` · +${grouped(s.drawersNow - s.drawersBaseline)} drawers`
    }
    return `${q.count} queued · running for ${since ? span(since) : "just started"}${wing}${wait}${grown}`
  }
  if (q.count > 0) {
    const age = q.oldest ? span(q.oldest) : "a while"
    // When the palace is held by another process the queue is not waiting
    // because nothing wants it: it is waiting because it cannot be written.
    // Saying so is the difference between a user who waits and a user who
    // goes and closes the thing holding the lock.
    if (s.phase === "busy" || s.error) return `${q.count} queued · blocked ${age} · palace busy`
    return `${q.count} queued · waiting ${age}`
  }
  return "queue empty"
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

    // The header word: the state of the WORK, not of the process. A queue
    // held by another writer is "blocked", which is a different problem with
    // a different fix than a queue nobody has got to yet. While mining, the
    // wing counter says which slice of the run this is — always shown, even
    // for a single wing, because "w1/1" confirms the run was scoped at all.
    const label = () => {
      const s = status()
      const q = queue()
      if (s.phase === "mining") {
        if (typeof s.wingsTotal === "number" && s.wingsTotal > 0) {
          return `mining · w${(s.wingIndex ?? 0) + 1}/${s.wingsTotal}`
        }
        return PHASE_LABEL[s.phase] ?? s.phase
      }
      if (q.count > 0) return s.phase === "busy" || s.error ? "blocked" : "queue"
      return PHASE_LABEL[s.phase] ?? s.phase
    }

    // The bar itself: a gauge of the queue, lit only while a mine is running.
    const gaugeLine = () => {
      const n = queue().count
      return working(status()) ? sweep(n, tick()) : gauge(n)
    }

    // One claim, one place: the sidebar footer. A compact mirror in the prompt
    // footer was tried and removed — two bars showing the same state read as
    // noise, and the prompt line is the most visually loaded area of the TUI.
    const off = ctx.ui.slot({
      append: "sidebar.footer",
      render: () => {
        const s = status()
        const q = queue()
        return (
          <box flexDirection="column" gap={0} flexShrink={0}>
            <box flexDirection="row" gap={1}>
              <text fg={tone()}>
                <span style={{ fg: tone() }}>◆</span> MemPalace
              </text>
              <text fg={backlogged(s, q) ? skin.warning : skin.muted}>{label()}</text>
            </box>
            <text fg={tone()}>{gaugeLine()}</text>
            <text fg={skin.muted}>{summary(s, q)}</text>
          </box>
        )
      },
    })

    return () => {
      try { off?.() } catch {}
    }
  },
}
