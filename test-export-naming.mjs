/**
 * Isolated end-to-end check of the export naming, against a synthetic DB.
 *
 * The bug being guarded against: the export date and the session title used to
 * be inside the hashed content AND inside the filename, so re-exporting the
 * same window on another day produced a different hash and a new file. Three
 * near-identical files for one session were the visible symptom.
 *
 * Invariants asserted here, with the real plugin code (dist/index.js), a real
 * SQLite DB and a throwaway HOME:
 *   1. the filename carries no date and no title
 *   2. re-exporting the same content yields the SAME single file (no growth)
 *   3. a window that gained a message yields a SECOND, separate file
 *   4. the two files' transcripts are disjoint (no duplicated memory)
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs"
import { join } from "node:path"

const HOME = "/tmp/octest-sync"
const PLUGIN = "/home/enrico/opencode-mempalace-persistence/dist/index.js"
const SESS = "ses_TESTEXPORT01abcdefghij"
const DIR = "/home/enrico/tradingagents"

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, ".local/share/opencode"), { recursive: true })
const db = join(HOME, ".local/share/opencode/opencode.db")

const setupDb = (rows) =>
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
db.execute("INSERT INTO session VALUES (?,?,?)", (${JSON.stringify(SESS)}, ${JSON.stringify(DIR)}, "Titolo Che Cambia"))
for i, (mid, ts, role, text) in enumerate(${JSON.stringify(rows)}):
    db.execute("INSERT INTO message VALUES (?,?,?,?)", (mid, ${JSON.stringify(SESS)}, ts,
        json.dumps({"role": role, "finish": "stop"})))
    db.execute("INSERT INTO part VALUES (?,?,?,?)", ("prt_"+mid, mid, ts, json.dumps({"type":"text","text":text})))
db.commit()
`,
  ])

// 3 messages at 10:00, one minute apart.
const base = Date.UTC(2026, 8, 29, 10, 0, 0)
setupDb([
  ["msg_aaaaaaaaaa0001", base + 0, "user", "primo messaggio"],
  ["msg_bbbbbbbbbb0002", base + 60000, "assistant", "secondo messaggio"],
  ["msg_cccccccccc0003", base + 120000, "assistant", "terzo messaggio"],
])

process.env.HOME = HOME
// No palace binary: the mine must fail fast and leave the queue untouched, so
// this test can never write to a real palace.
process.env.MEMPALACE_BIN = "/nonexistent/mempalace"
process.env.MEMPALACE_PYTHON = "/usr/bin/python3"
process.env.PATH = "/usr/bin:/bin"

const mod = await import(PLUGIN)
const hooks = await mod.default.server({})
const outDir = join(HOME, ".mempalace/oc-sessions/tradingagents")
const stateFile = join(HOME, ".mempalace/sync_state.json")

const setCursor = (ms) => {
  const fs = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf-8"))
    : { last_sync_ms: 0, wings: {}, mined_ids: {} }
  fs.wings = fs.wings || {}
  fs.wings.tradingagents = ms
  fs.last_sync_ms = ms
  writeFileSync(stateFile, JSON.stringify(fs))
}

const runSync = async () => {
  await hooks.event({ event: { type: "session.idle" } })
  await new Promise((r) => setTimeout(r, 7000))
}

const list = () => (existsSync(outDir) ? readdirSync(outDir).sort() : [])

let failures = 0
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`)
  if (!ok) failures++
}

// Run 1: first export, cursor before everything.
setCursor(0)
await runSync()
const run1 = list()
console.log("\n[1] prima esportazione")
console.log("    file:", run1.join(", ") || "(nessuno)")
check("produce esattamente 1 file", run1.length === 1, `trovati ${run1.length}`)
check("il nome non contiene una data", !/\d{4}-\d{2}-\d{2}/.test(run1[0] || ""), run1[0] || "")
check("il nome non contiene il titolo", !/Titolo/i.test(run1[0] || ""), run1[0] || "")

const body1 = existsSync(join(outDir, run1[0])) ? readFileSync(join(outDir, run1[0]), "utf-8") : ""
check("l'header dichiara 'Last verified'", body1.includes("Last verified:"))
check("l'header conserva sessione e titolo", body1.includes(SESS) && /Titolo Che Cambia/.test(body1))
check("l'header precede il transcript", body1.indexOf("Last verified") < body1.indexOf("## USER"))

// Run 2: rewind the cursor, export the very same window again. This is the
// case that used to create a second file.
console.log("\n[2] re-export della stessa finestra (cursore riavvolto)")
setCursor(0)
await runSync()
const run2 = list()
console.log("    file:", run2.join(", ") || "(nessuno)")
check("nessuna crescita della coda", run2.length === 1, `trovati ${run2.length}`)
check("stesso nome file", run2[0] === run1[0], `${run1[0]} -> ${run2[0]}`)

// Run 3: two new messages arrive, the window grows.
//
// Two, not one: the exporter deliberately skips a window holding fewer than
// two messages (src/index.ts, `if (msgList.length < 2 && ...) continue`), so a
// single new message would produce no file at all. The cursor is not advanced
// past skipped messages, so nothing is lost, it just waits for a second one.
console.log("\n[3] la finestra cresce (2 messaggi nuovi)")
execFileSync("python3", [
  "-c",
  `
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(db)})
for n, (mid, text) in enumerate([
    ("msg_dddddddddd0004", "quarto messaggio"),
    ("msg_eeeeeeeeeee0005", "quinto messaggio"),
]):
    ts = ${base + 180000} + n * 60000
    db.execute("INSERT INTO message VALUES (?,?,?,?)", (mid, ${JSON.stringify(SESS)}, ts,
        json.dumps({"role":"user","finish":"stop"})))
    db.execute("INSERT INTO part VALUES (?,?,?,?)", ("prt_"+mid, mid, ts,
        json.dumps({"type":"text","text":text})))
db.commit()
`,
])
setCursor(base + 120001)
await runSync()
const run3 = list()
console.log("    file:", run3.join(", "))
check("compare un secondo file", run3.length === 2, `trovati ${run3.length}`)
check("il primo file non è stato toccato", run3.includes(run1[0]))

// Disjointness: the messages of the first window must not reappear in the
// second, otherwise mining both would file the same memory twice.
if (run3.length === 2) {
  const other = run3.find((f) => f !== run1[0])
  const b1 = readFileSync(join(outDir, run1[0]), "utf-8")
  const b2 = readFileSync(join(outDir, other), "utf-8")
  const shared = ["primo messaggio", "secondo messaggio", "terzo messaggio"].filter(
    (t) => b1.includes(t) && b2.includes(t),
  )
  check("i due file non condividono messaggi", shared.length === 0, `condividono: ${shared.join(", ")}`)
}

// The trailer that makes the queue self-describing.
console.log("\n[4] il trailer con gli id")
const withTrailer = readFileSync(join(outDir, run1[0]), "utf-8")
check("il file contiene il trailer mp-ids", withTrailer.includes("<!-- mp-ids:"))
check(
  "il trailer elenca tutti i messaggi della finestra",
  ["msg_aaaaaaaaaa0001", "msg_bbbbbbbbbb0002", "msg_cccccccccc0003"].every((id) =>
    withTrailer.includes(id),
  ),
)
check("il trailer e' l'ultima riga", withTrailer.trimEnd().endsWith("-->"))

// Run 4: rewind again with both files still in the queue. The window is now
// fully covered, so nothing new is written — but the cursor MUST still move,
// or this wing would re-read the same window on every sync forever.
console.log("\n[5] cursore riavvolto con tutto gia' in coda")
setCursor(0)
await runSync()
const run5 = list()
check("nessun file nuovo", run5.length === 2, `trovati ${run5.length}`)
const st5 = JSON.parse(readFileSync(stateFile, "utf-8"))
check("il cursore e' comunque avanzato", st5.wings.tradingagents > 0, `cursore = ${st5.wings.tradingagents}`)

// Run 5: the queue is emptied, which is what a successful mine does. The
// messages must become exportable again — the property the state-file version
// of this set could not offer, where a file deleted by hand stranded its
// messages forever.
console.log("\n[6] la coda viene svuotata (come dopo un mine riuscito)")
for (const f of list()) unlinkSync(join(outDir, f))
rmSync(stateFile, { force: true })
setCursor(0)
await runSync()
const run6 = list()
console.log("    file:", run6.join(", ") || "(nessuno)")
check("i messaggi tornano esportabili", run6.length >= 1, `trovati ${run6.length}`)
const b6 = run6.length ? readFileSync(join(outDir, run6[0]), "utf-8") : ""
check(
  "il contenuto non e' andato perso",
  ["primo messaggio", "quarto messaggio", "quinto messaggio"].every((t) => b6.includes(t)),
)

console.log(`\n${failures === 0 ? "TUTTO OK" : failures + " CONTROLLI FALLITI"}`)
process.exit(failures === 0 ? 0 : 1)
