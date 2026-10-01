// Regression test for reapDetachedMines(): stale detached mines from previous
// opencode sessions must be terminated on startup, and ONLY those.
//
// The functions under test are extracted from the COMPILED dist/index.js by
// name (not copied here) so this test cannot drift from what ships. Requires
// `npm run build` first. Linux-only: it reads /proc, which is also the only
// platform the reap acts on.
//
// Cases:
//  - orphan wrapper (ppid 1) is killed, and its child (the python mine that
//    holds the palace lock) is killed BEFORE the wrapper
//  - wrapper whose parent is alive (another live session) is untouched
//  - a bare `mempalace mine` on our queue dir is untouched: it could be a
//    manual run, and a manual run is the user's to kill, not ours
//  - unrelated orphans, pid 1 and ourselves are never signalled
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "fs"
import { spawn } from "child_process"
import { tmpdir } from "os"
import { join } from "path"
import { fileURLToPath } from "url"

const ROOT = fileURLToPath(new URL(".", import.meta.url))
const DIST = join(ROOT, "dist/index.js")
const MINE_BIN = "/home/enrico/.local/bin/mempalace"
const OUT_DIR = "/home/enrico/.mempalace/oc-sessions"

if (!existsSync(DIST)) {
  console.error("dist/index.js mancante: esegui `npm run build` prima")
  process.exit(1)
}

const src = readFileSync(DIST, "utf-8")
function sliceFn(name) {
  const start = src.indexOf(`\nfunction ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found in dist`)
  let depth = 0
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}
const body = ["procArgv", "procState", "procAlive", "procParent", "reapDetachedMines"].map(sliceFn).join("\n\n")
const reapDetachedMines = new Function(
  "readFileSync",
  "readdirSync",
  "existsSync",
  "process",
  `${body}\nreturn reapDetachedMines`,
)(readFileSync, readdirSync, existsSync, process)

// --- fixtures in a throwaway dir -----------------------------------------
const dir = join(tmpdir(), `mp-reap-${process.pid}`)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const FAKE_WRAPPER = join(dir, "mine-detached.sh") // same suffix as the real one
const childPidFile = join(dir, "child.pid")
writeFileSync(
  FAKE_WRAPPER,
  ['#!/bin/bash', 'sleep 600 &', `echo $! > ${childPidFile}`, 'wait', ""].join("\n"),
  { mode: 0o755 },
)
chmodSync(FAKE_WRAPPER, 0o755)

// --- helpers --------------------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const readOr = (p) => {
  try {
    return readFileSync(p, "utf-8")
  } catch {
    return ""
  }
}
// EPERM means the process exists but belongs to another user — same rule the
// code under test uses, and the reason pid 1 reads as alive here.
const alive = (pid) => {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return e?.code === "EPERM"
  }
  const st = readOr(`/proc/${pid}/stat`)
  const end = st.lastIndexOf(")")
  if (end >= 0 && st.slice(end + 1).trim().split(/\s+/)[0] === "Z") return false
  return true
}
const ppidOf = (pid) => {
  const st = readOr(`/proc/${pid}/stat`)
  const end = st.lastIndexOf(")")
  if (end < 0) return null
  return parseInt(st.slice(end + 1).trim().split(/\s+/)[1], 10)
}
const argvOf = (pid) => readOr(`/proc/${pid}/cmdline`).split("\0").filter(Boolean)
// Match on the joined argv: `exec -a` puts a whole fake command line in argv[0].
const findOrphan = (needle) => {
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue
    const pid = parseInt(n, 10)
    if (pid <= 1 || pid === process.pid) continue
    const argv = argvOf(pid)
    if (argv.length && argv.join(" ").includes(needle) && ppidOf(pid) === 1) return pid
  }
  return 0
}
// Double-fork so init reparents the survivor: node's own children keep node as
// their parent, and the reap deliberately requires ppid 1.
function orphanize(argv0, ...cmd) {
  const argv = [argv0, ...(cmd.length ? cmd : [argv0])]
  const inner = `exec -a ${JSON.stringify(argv[0])} ${argv.slice(1).map((a) => JSON.stringify(a)).join(" ")}`
  spawn("bash", ["-c", `nohup setsid bash -c ${JSON.stringify(inner)} >/dev/null 2>&1 & exit 0`], { stdio: "ignore" })
}
async function waitFor(needle, ms = 20000) {
  const t0 = Date.now()
  for (;;) {
    const pid = findOrphan(needle)
    if (pid) return pid
    if (Date.now() - t0 > ms) return 0
    await wait(250)
  }
}

// --- arrange --------------------------------------------------------------
orphanize(FAKE_WRAPPER) // 1. orphan wrapper with a child (the "mine")
orphanize(`${MINE_BIN} mine ${OUT_DIR}/enrico --mode convos`, "sleep", "600") // 3. manual mine, orphan
orphanize("/usr/bin/python3 some_other_thing.py", "sleep", "600") // 4. unrelated orphan

const tree = await waitFor("/mine-detached.sh")
const bare = await waitFor("mempalace mine")
const other = await waitFor("some_other_thing.py")
let treeChild = 0
for (let i = 0; i < 40 && !treeChild; i++) {
  treeChild = parseInt(readOr(childPidFile).trim() || "0", 10)
  if (!treeChild) await wait(250)
}
// 2. wrapper attached to a LIVE parent (this test): not ours to kill
const live = spawn("bash", [FAKE_WRAPPER], { stdio: "ignore" })
await wait(500)

console.log(`fixture (ppid 1 = orfano, ${process.pid} = vivo):`)
console.log(`  wrapper orfano + figlio : ${tree} (ppid ${ppidOf(tree)}) / ${treeChild} (ppid ${ppidOf(treeChild)})`)
console.log(`  wrapper con padre vivo  : ${live.pid} (ppid ${ppidOf(live.pid)})`)
console.log(`  mine manuale orfano     : ${bare} (ppid ${ppidOf(bare)})`)
console.log(`  altro processo orfano   : ${other} (ppid ${ppidOf(other)})`)

// --- act ------------------------------------------------------------------
const t0 = Date.now()
const killed = reapDetachedMines()
await wait(400)
console.log(`\nreap -> [${killed.join(",")}] in ${Date.now() - t0}ms`)

const checks = [
  ["fixture: wrapper orfano trovato", tree > 0],
  ["fixture: figlio trovato", treeChild > 0],
  ["fixture: mine manuale trovato", bare > 0],
  ["fixture: altro trovato", other > 0],
  ["wrapper orfano ucciso", tree > 0 && !alive(tree)],
  ["figlio (mine) ucciso", treeChild > 0 && !alive(treeChild)],
  ["wrapper con padre vivo intatto", alive(live.pid)],
  ["mine manuale intatto", bare > 0 && alive(bare)],
  ["altro processo intatto", other > 0 && alive(other)],
  ["pid 1 intatto", alive(1)],
  ["wrapper e figlio riportati", killed.includes(tree) && killed.includes(treeChild)],
  ["nessun kill estraneo", killed.every((p) => p === tree || p === treeChild)],
]

// --- cleanup --------------------------------------------------------------
// The live-parented wrapper was spared on purpose, so its child (the fake
// "mine") is still running: kill it too, or this test leaks a sleeper per run.
// pid 0 means "my own process group" to kill(): never pass an unfound pid.
const liveChild = parseInt(readOr(childPidFile).trim() || "0", 10)
for (const p of [live.pid, liveChild, bare, other]) {
  if (!(p > 1)) continue
  try {
    process.kill(p, "SIGKILL")
  } catch {}
}
await wait(200)
try {
  rmSync(dir, { recursive: true, force: true })
} catch {}

let ok = true
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "OK  " : "FAIL"} ${name}`)
  if (!pass) ok = false
}
console.log(ok ? "\nTUTTO OK" : "\nFALLITO")
process.exit(ok ? 0 : 1)