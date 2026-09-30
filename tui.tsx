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
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createSignal, onCleanup } from "solid-js"

const HOME = homedir()
const STATUS_FILE = join(HOME, ".mempalace/hook_state/status.json")

type Phase = "idle" | "mining" | "busy" | "error" | "unknown"
type Status = {
  ts?: string
  phase: Phase
  wing?: string
  pending: number
  last?: { kind?: string; outcome?: string; drawers?: number; wing?: string; at?: string }
  error?: string
  plugin?: string
}

const readStatus = (): Status => {
  try {
    const raw = JSON.parse(readFileSync(STATUS_FILE, "utf-8")) as Status
    return { phase: "idle", pending: 0, ...raw }
  } catch {
    return { phase: "unknown", pending: 0 }
  }
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

const ago = (iso?: string) => {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!t) return ""
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s}s fa`
  if (s < 3600) return `${Math.round(s / 60)}m fa`
  return `${Math.round(s / 3600)}h fa`
}

// "idle" means no mine is running, NOT that there is nothing to do. A queue
// waiting to be drained while the plugin sits idle is exactly the state that
// needed surfacing, and reporting it as plain idle is what made a stuck
// 16-file queue look healthy. Backlog is its own state, and it is not green.
const backlogged = (s: Status) => s.phase === "idle" && s.pending > 0

const describe = (s: Status) => {
  const l = s.last
  if (!l) return backlogged(s) ? "coda in attesa" : "nessuna attivita"
  if (l.kind === "mine") {
    if (l.outcome === "ok") return `mine ok · ${l.drawers ?? 0} drawer`
    if (l.outcome === "busy") return "palace occupato, si ritenta"
    return `mine ${l.outcome ?? "?"}`
  }
  if (l.kind === "checkpoint") return "checkpoint armato"
  if (l.kind === "search") return "ricerca"
  if (l.kind === "tool") return String(l.kind)
  return String(l.kind)
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: "idle",
  mining: "mining",
  busy: "palace occupato",
  error: "errore",
  unknown: "in attesa",
}

export default {
  id: "opencode-mempalace-persistence",
  setup(ctx: any) {
    const skin = skinOf(ctx?.theme?.current ?? ctx?.theme ?? {})

    // Signals must be created inside setup(): at module scope there is no
    // Solid owner to attach them to and the slot can render nothing.
    const [status, setStatus] = createSignal<Status>(readStatus())
    const [tick, setTick] = createSignal(0)

    // status.json is one small file: poll it once a second.
    const poll = setInterval(() => {
      setStatus(readStatus())
      syncAnim()
    }, 1000)

    // The sweep runs only while a mine is in flight; the timer is stopped
    // otherwise, so an idle TUI costs nothing. The first version spun a 140ms
    // timer forever, which is exactly the "never stops moving" feel we dropped.
    let anim: ReturnType<typeof setInterval> | null = null
    const syncAnim = () => {
      const p = status().phase
      const want = p === "mining" || p === "busy"
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
      const p = status().phase
      if (p === "error") return skin.error
      if (p === "busy") return skin.warning
      if (p === "mining") return skin.accent
      if (p === "unknown") return skin.muted
      // A drained queue is genuinely idle; a queue with work in it is not,
      // and must not be reported as if it were.
      if (backlogged(status())) return skin.warning
      return skin.success
    }

    // The line itself: a queue gauge, lit only while a mine is running.
    const gaugeLine = () => {
      const s = status()
      const active = s.phase === "mining" || s.phase === "busy"
      return active ? sweep(s.pending, tick()) : gauge(s.pending)
    }

    // One claim, one place: the sidebar footer. A compact mirror in the prompt
    // footer was tried and removed — two bars showing the same state read as
    // noise, and the prompt line is the most visually loaded area of the TUI.
    const off = ctx.ui.slot({
      append: "sidebar.footer",
      render: () => {
        const s = status()
        return (
          <box flexDirection="column" gap={0} flexShrink={0}>
            <box flexDirection="row" gap={1}>
              <text fg={tone()}>
                <span style={{ fg: tone() }}>◆</span> MemPalace
              </text>
              <text fg={backlogged(s) ? skin.warning : skin.muted}>
                {backlogged(s) ? "coda" : PHASE_LABEL[s.phase] ?? s.phase}
              </text>
            </box>
            <text fg={tone()}>{gaugeLine()}</text>
            <text fg={skin.muted}>
              {s.pending} in coda · {describe(s)} {ago(s.last?.at || s.ts)}
            </text>
          </box>
        )
      },
    })

    return () => {
      try { off?.() } catch {}
    }
  },
}
