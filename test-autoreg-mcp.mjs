// Regression test for MCP auto-registration (zero-config).
//
// Imports the real functions from the COMPILED dist/index.js (named exports
// kept for exactly this — no `new Function`, no eval, scanner-clean).
// Requires `npm run build` first.
//
// Cases:
//  - no manual entry + binary present -> read-only entry with absolute cmd
//  - manual entry present -> repaired, never merely "respected"
//  - already-correct entry -> untouched (no churn)
//  - broken command -> repointed to the working binary
//  - MEMPALACE_MCP_MANUAL=1 -> fully untouched, even a writer
//  - no binary anywhere -> no entry, with a reason (never a broken command)
//  - entry always carries MEMPALACE_MCP_READ_ONLY=1 (the whole point: no tab
//    may ever hold the writer lease and starve mines)
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { fileURLToPath } from "url"

const ROOT = fileURLToPath(new URL(".", import.meta.url))
const { resolveMcpBin, mcpServerEntry, registerMcpServer } = await import(
  join(ROOT, "dist/index.js")
)

const checks = []
const check = (name, pass, extra = "") => {
  checks.push(pass)
  console.log(`  ${pass ? "OK  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`)
}

// --- fixture HOME with a fake mempalace-mcp binary -------------------------
const fakeHome = join(tmpdir(), `mp-autoreg-${process.pid}`)
const fakeBinDir = join(fakeHome, ".local/bin")
mkdirSync(fakeBinDir, { recursive: true, mode: 0o700 })
const fakeBin = join(fakeBinDir, "mempalace-mcp")
writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n")
chmodSync(fakeBin, 0o755)
const fx = (extraEnv = {}) => ({ env: { PATH: "/usr/bin:/bin", ...extraEnv }, home: fakeHome })

// 1. fresh install shape: no entry, binary present -> read-only entry ------
{
  const bin = resolveMcpBin(fx())
  check("binary resolved to the fixture", bin === fakeBin, bin)
  const { entry, reason } = registerMcpServer(undefined, bin)
  check("entry produced when none exists", !!entry, reason)
  check("type is local", entry?.type === "local")
  check("command is absolute", entry?.command?.[0] === fakeBin, JSON.stringify(entry?.command))
  check("read-only env set", entry?.environment?.MEMPALACE_MCP_READ_ONLY === "1")
  check("enabled", entry?.enabled === true)
  const direct = mcpServerEntry(fakeBin)
  check("mcpServerEntry shape", direct.type === "local" && direct.enabled === true)
}

// 2. manual entry: repaired, not just respected -----------------------------
{
  // 2a. writer entry without the env -> read-only added, command kept
  const writer = { type: "local", command: [fakeBin], enabled: true }
  const r1 = registerMcpServer(writer, fakeBin)
  check(
    "writer entry repaired (read-only added)",
    !!r1.entry && r1.entry.environment?.MEMPALACE_MCP_READ_ONLY === "1",
    r1.reason,
  )
  check("repair keeps working command", r1.entry?.command?.[0] === fakeBin)
  check("repair keeps other keys", r1.entry?.type === "local" && r1.entry?.enabled === true)
  // 2b. already-correct entry -> no churn
  const r2 = registerMcpServer(r1.entry, fakeBin)
  check("already-correct entry untouched", r2.entry === null, r2.reason)
  // 2c. bare/broken command -> repointed to the working binary
  const r3 = registerMcpServer({ type: "local", command: ["mempalace-mcp"], enabled: true }, fakeBin)
  check("broken command repointed", r3.entry?.command?.[0] === fakeBin, r3.reason)
  // 2d. opt-out -> fully untouched, even a writer
  const r4 = registerMcpServer(writer, fakeBin, { manual: "1" })
  check("MEMPALACE_MCP_MANUAL=1 skips repair", r4.entry === null, r4.reason)
}

// 3. no binary anywhere -> no entry, never a broken command -----------------
{
  const emptyHome = join(tmpdir(), `mp-autoreg-empty-${process.pid}`)
  mkdirSync(emptyHome, { recursive: true, mode: 0o700 })
  const bin = resolveMcpBin({ env: { PATH: "/usr/bin:/bin", MEMPALACE_MCP_BIN: "" }, home: emptyHome })
  const { entry, reason } = registerMcpServer(undefined, bin)
  check("no binary -> no entry", entry === null && bin === "", `${reason} (bin=${JSON.stringify(bin)})`)
  rmSync(emptyHome, { recursive: true, force: true })
}

// 4. MEMPALACE_MCP_BIN override ---------------------------------------------
{
  const bin = resolveMcpBin({ env: { MEMPALACE_MCP_BIN: fakeBin }, home: "/nonexistent-home" })
  check("MEMPALACE_MCP_BIN wins", bin === fakeBin)
}

rmSync(fakeHome, { recursive: true, force: true })
const ok = checks.every(Boolean)
console.log(ok ? "\nTUTTO OK" : "\nFALLITO")
process.exit(ok ? 0 : 1)