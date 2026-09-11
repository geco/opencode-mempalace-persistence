import { execSync, exec } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, unlinkSync, appendFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import type { Plugin } from "@opencode-ai/plugin"

const HOME = homedir()
const MEMPALACE_BIN = join(HOME, ".local/bin/mempalace")
const OPENCODE_DB = join(HOME, ".local/share/opencode/opencode.db")
const STATE_FILE = join(HOME, ".mempalace/sync_state.json")
const PLUGIN_CONFIG = join(HOME, ".mempalace/plugin-config.json")
const IDENTITY_FILE = join(HOME, ".mempalace/identity.txt")
const OUT_DIR = "/tmp/oc-sessions"
const TMP_SCRIPT = "/tmp/oc-plugin-query.py"
const LOG_FILE = join(HOME, ".mempalace/logs/plugin.log")
const MAX_INJECT_CHARS = 900
const MAX_SEARCH_RESULTS = 3

// mempalace is installed via `uv tool` (pipx venv path is legacy)
function findPalacePython(): string {
  const candidates = [
    process.env.MEMPALACE_PYTHON,
    join(HOME, ".local/share/uv/tools/mempalace/bin/python3"),
    join(HOME, ".local/share/pipx/venvs/mempalace/bin/python3"),
  ].filter(Boolean) as string[]
  for (const p of candidates) {
    try {
      execSync(`"${p}" -c ""`, { stdio: "ignore" })
      return p
    } catch {}
  }
  return candidates[0] || "python3"
}
const VENV_PYTHON = findPalacePython()

function log(msg: string) {
  const ts = new Date().toISOString()
  try {
    mkdirSync(join(HOME, ".mempalace/logs"), { recursive: true })
    appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`)
  } catch {}
}

let miningLock = false
let lastSyncTs = 0
let wakeupDone = false

function runPython(code: string): string {
  writeFileSync(TMP_SCRIPT, code)
  try {
    return execSync(`${VENV_PYTHON} ${TMP_SCRIPT}`, { encoding: "utf-8", timeout: 30000 }).trim()
  } finally {
    unlinkSync(TMP_SCRIPT)
  }
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

function readIdentity(): string {
  if (!existsSync(IDENTITY_FILE)) return ""
  try { return readFileSync(IDENTITY_FILE, "utf-8").trim() } catch { return "" }
}

function mempalaceSearch(query: string): string {
  try {
    const out = execSync(`${MEMPALACE_BIN} search "${query.replace(/"/g, '\\"')}" --results ${MAX_SEARCH_RESULTS}`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim()
    if (!out || out.includes("No results")) return ""
    return out.slice(0, MAX_INJECT_CHARS)
  } catch {
    return ""
  }
}

// Native L0+L1 wake-up context (identity, essential story, recent threads)
function mempalaceWakeUp(): string {
  try {
    const out = execSync(`${MEMPALACE_BIN} wake-up`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim()
    if (!out) return ""
    // Drop the "Wake-up text (~N tokens):" banner line
    return out.replace(/^Wake-up text \([^)]+\):\s*\n/, "").slice(0, 3000)
  } catch {
    return ""
  }
}

function getLastSync(): number {
  if (!existsSync(STATE_FILE)) return 0
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")).last_sync_ms || 0 } catch { return 0 }
}

function dbSync(): void {
  if (miningLock) return
  try { doDbSync() } catch (e) { log("sync err: " + String(e)) }
}

function doDbSync(): void {
  if (lastSyncTs && Date.now() - lastSyncTs < 5000) return

  const lastSync = getLastSync()

  const sessions = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT DISTINCT s.id, s.title, p.worktree, s.directory, s.slug, s.time_created
  FROM session s
  LEFT JOIN project p ON s.project_id = p.id
  INNER JOIN message m ON m.session_id = s.id
  WHERE m.time_created > ${lastSync}
  ORDER BY s.time_created
""").fetchall()
db.close()
print(json.dumps(rows))
`)

  let sessionsArr: any[][]
  try { sessionsArr = JSON.parse(sessions) } catch { return }
  if (!sessionsArr || sessionsArr.length === 0) return

  const now = Date.now()
  const exported: string[] = []
  mkdirSync(OUT_DIR, { recursive: true })

  for (const sess of sessionsArr) {
    const [sessId, title] = sess
    const label = (title || "").replace(/[^a-zA-Z0-9 _-]/g, "_") || (sessId || "").slice(0, 12)
    const prefix = `${new Date().toISOString().slice(0, 10)}_${label.slice(0, 30)}_${(sessId || "").slice(0, 8)}`

    const msgs = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT m.id, m.time_created, m.data FROM message m
  WHERE m.session_id = ${JSON.stringify(sessId)} AND m.time_created > ${lastSync}
  ORDER BY m.time_created
""").fetchall()
texts = []
for (mid, mts, mdata_raw) in rows:
    try: mdata = json.loads(mdata_raw)
    except: mdata = {}
    role = mdata.get("role", "unknown")
    for (pdata_raw,) in db.execute("SELECT data FROM part WHERE message_id = ? ORDER BY time_created", (mid,)).fetchall():
        try:
            pdata = json.loads(pdata_raw)
            if pdata.get("type") == "text" and pdata.get("text","").strip():
                texts.append({"role": role, "text": pdata.get("text").strip(), "ts": mts})
        except: pass
db.close()
print(json.dumps(texts))
`)

    let msgList: Array<{ role: string; text: string; ts: number }>
    try { msgList = JSON.parse(msgs) } catch { continue }
    if (msgList.length < 2) continue

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
    const fname = `sync_${prefix}_${contentHash}.txt`
    writeFileSync(join(OUT_DIR, fname), content + "\n")
    exported.push(join(OUT_DIR, fname))
  }

  if (exported.length === 0) return

  writeFileSync(STATE_FILE, JSON.stringify({ last_sync_ms: now }))
  lastSyncTs = Date.now()
  miningLock = true
  log(`mining ${exported.length} sessions`)

  // No timeout here: `mempalace mine` on a large palace legitimately takes
  // far longer than 2 minutes. A hard exec timeout only killed the wrapper
  // shell, orphaning the python mine (which kept running and holding the
  // palace lock) while `miningLock` was released early — allowing duplicate
  // concurrent mines that contended for the lock and interrupted repair.
  exec(`${MEMPALACE_BIN} mine ${OUT_DIR} --mode convos`, {
    encoding: "utf-8",
  }, (err) => {
    miningLock = false
    if (err) { log(`mine err: ${err.message}`); return }
    for (const f of exported) {
      try { unlinkSync(f) } catch {}
    }
    try { rmdirSync(OUT_DIR) } catch {}
    log("mine done")
  })
}

export default (async () => {
  mkdirSync(OUT_DIR, { recursive: true })
  const autoInject = isAutoInjectEnabled()
  const identity = readIdentity()
  log(`loaded (autoInjectContext: ${autoInject})`)

  return {
    "chat.message": async (_input, output) => {
      const role = (output.message as any).role
      if (role !== "user") return
      const text = hasText(output.parts || [])
      if (!text) return
      log("user msg - queue sync")
      setTimeout(() => dbSync(), 500)
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!autoInject) return
      if (!output?.messages?.length) return

      const lastUser = [...output.messages].reverse().find((m: any) => m.info?.role === "user")
      if (!lastUser) return

      const query = hasText(lastUser.parts || [])
      if (!query) return

      const injectParts: any[] = []

      if (!wakeupDone) {
        wakeupDone = true
        // Prefer native wake-up (includes identity + L0/L1); fall back to identity file
        const ctx = mempalaceWakeUp() || (identity
          ? `[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`
          : "")
        if (ctx) {
          injectParts.push({
            id: `mp-wakeup-${Date.now()}`,
            type: "text",
            synthetic: true,
            text: `[MemPalace Context]\n${ctx}\n[/MemPalace Context]`,
          })
        }
      }

      const memories = mempalaceSearch(query)
      if (memories) {
        injectParts.push({
          id: `mp-recall-${Date.now()}`,
          type: "text",
          synthetic: true,
          text: `[MemPalace Recall]\n${memories}\n[/MemPalace Recall]`,
        })
      }

      if (injectParts.length > 0) {
        lastUser.parts.push(...injectParts)
        log(`injected ${injectParts.length} context blocks`)
      }
    },

    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return
      log("idle - queue sync")
      setTimeout(() => dbSync(), 3000)
    },
  }
}) satisfies Plugin
