/**
 * Queue-drain check: the mine must cover STALE pending files, not just fresh
 * exports (see the fix commit). Plus trailer-id commit on delete.
 *
 * Setup: a synthetic DB, one stale queue file placed by hand (as a failed run
 * would have left it) with the cursor already past its messages, and a fake
 * `mempalace` that succeeds instantly. One sync must then mine the stale file
 * (delete it) and record its ids — even though the export selects nothing.
 *
 * A second part adds genuinely new messages: the same run must export AND
 * mine them, leaving the queue empty with every id recorded.
 */
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"

const HOME = "/tmp/octest-drain"
const PLUGIN = "/home/enrico/opencode-mempalace-persistence/dist/index.js"
const SESS = "ses_TESTDRAIN01abcdefghij"
const DIR = "/home/enrico/detachtest"
const WING = "detachtest"

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, ".local/share/opencode"), { recursive: true })
const db = join(HOME, ".local/share/opencode/opencode.db")
const outDir = join(HOME, ".mempalace/oc-sessions", WING)
const stateFile = join(HOME, ".mempalace/sync_state.json")

execFileSync("python3", [
  "-c",
  `
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(db)})
db.executescript("""
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
""")
db.execute("INSERT INTO session VALUES (?,?,?)", (${JSON.stringify(SESS)}, ${JSON.stringify(DIR)}, "Drain probe"))
base = 1789000000000
rows = [("msg_old00001", "user", "vecchio uno"), ("msg_old00002", "assistant", "vecchio due"),
        ("msg_new00003", "user", "nuovo uno"), ("msg_new00004", "assistant", "nuovo due")]
for i, (mid, role, text) in enumerate(rows):
    ts = base + i * 60000
    db.execute("INSERT INTO message VALUES (?,?,?,?)", (mid, ${JSON.stringify(SESS)}, ts,
        json.dumps({"role": role, "finish": "stop"})))
    db.execute("INSERT INTO part VALUES (?,?,?,?)", ("prt_" + mid, mid, ts, json.dumps({"type": "text", "text": text})))
db.commit()
`,
])

// Fake mine: succeeds instantly (no palace, no lock, no work).
mkdirSync(join(HOME, "bin"), { recursive: true })
writeFileSync(
  join(HOME, "bin/fake-mine.sh"),
  '#!/bin/bash\necho "Drawers filed: 4"\nexit 0\n',
  { mode: 0o755 },
)

process.env.HOME = HOME
process.env.MEMPALACE_BIN = join(HOME, "bin/fake-mine.sh")
process.env.MEMPALACE_PYTHON = "/usr/bin/python3"
process.env.PATH = "/usr/bin:/bin"

// A stale file, as a failed run leaves it: real trailer, cursor past it.
mkdirSync(outDir, { recursive: true, mode: 0o700 })
writeFileSync(
  join(outDir, "sync_ses_TEST_aaaabbbbcccc.txt"),
  "# Drain probe\nSession: " +
    SESS +
    "\nLast verified: 2026-09-01\n\n## USER — 10:00\n\nvecchio uno\n\n<!-- mp-ids: msg_old00001,msg_old00002 -->\n",
  { mode: 0o600 },
)
// Cursor past the two old messages, before the two new ones
// (old at +0/+60000, new at +120000/+180000).
const cursor = 1789000000000 + 60000 + 1
mkdirSync(join(HOME, ".mempalace"), { recursive: true })
writeFileSync(
  stateFile,
  JSON.stringify({ last_sync_ms: cursor, wings: { [WING]: cursor }, mined_ids: {} }),
)

const mod = await import(PLUGIN)
const hooks = await mod.default.server({})

let failures = 0
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`)
  if (!ok) failures++
}

await hooks.event({ event: { type: "session.idle" } })
await new Promise((r) => setTimeout(r, 9000))

const leftovers = existsSync(outDir) ? readdirSync(outDir).filter((n) => n.endsWith(".txt")) : []
console.log("\n[1] stale + fresh in one run")
console.log("    file rimasti:", leftovers.join(", ") || "(nessuno)")
check("la coda e svuotata", leftovers.length === 0, `restano ${leftovers.length}`)

const st = JSON.parse(readFileSync(stateFile, "utf-8"))
const ids = st.mined_ids || {}
const want = ["msg_old00001", "msg_old00002", "msg_new00003", "msg_new00004"]
const missing = want.filter((id) => !(id in ids))
check("tutti gli id registrati (stale da trailer + fresh da export)", missing.length === 0, `mancano: ${missing.join(", ")}`)

console.log(`\n${failures === 0 ? "TUTTO OK" : failures + " CONTROLLI FALLITI"}`)
process.exit(failures === 0 ? 0 : 1)
