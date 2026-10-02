// Regression test for MCP auto-registration (zero-config).
//
// The functions under test are extracted from the COMPILED dist/index.js by
// name (not copied here) so this test cannot drift from what ships.
// Requires `npm run build` first.
//
// Cases:
//  - no manual entry + binary present -> read-only entry with absolute cmd
//  - manual entry present (even a writer one) -> untouched, never overridden
//  - no binary anywhere -> no entry, with a reason (never a broken command)
//  - entry always carries MEMPALACE_MCP_READ_ONLY=1 (the whole point: no tab
//    may ever hold the writer lease and starve mines)
import { readFileSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { fileURLToPath } from "url"

const ROOT = fileURLToPath(new URL(".", import.meta.url))
const DIST = join(ROOT, "dist/index.js")
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

// resolveMcpBin reads process.env + HOME at call time, so scope them per case.
// It also uses its module-level memo (`let resolvedMcpBin`), redeclared here
// so every case starts uncached.
const body =
  "let resolvedMcpBin;\n" + ["resolveMcpBin", "mcpServerEntry", "registerMcpServer"].map(sliceFn).join("\n\n")
const factory = new Function(
  "process",
  "existsSync",
  "execSync",
  "join",
  "HOME",
  `${body}\nreturn { resolveMcpBin, mcpServerEntry, registerMcpServer }`,
)

const realFs = await import("fs")
const realCp = await import("child_process")
// execSync inherits the REAL environment unless told otherwise — force the
// fixture env through, or PATH-based resolution escapes the sandbox.
const runWith = (env, home) => {
  const merged = { ...process.env, ...env }
  const execSync = (cmd, opts) => realCp.execSync(cmd, { ...opts, env: merged })
  return factory(
    { ...process, env: merged, platform: process.platform },
    realFs.existsSync,
    execSync,
    join,
    home,
  )
}

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

// 1. fresh install shape: no entry, binary present -> read-only entry ------
{
  const { resolveMcpBin, registerMcpServer } = runWith({}, fakeHome)
  const bin = resolveMcpBin()
  check("binary resolved to the fixture", bin === fakeBin, bin)
  const { entry, reason } = registerMcpServer(undefined, bin)
  check("entry produced when none exists", !!entry, reason)
  check("type is local", entry?.type === "local")
  check("command is absolute", entry?.command?.[0] === fakeBin, JSON.stringify(entry?.command))
  check("read-only env set", entry?.environment?.MEMPALACE_MCP_READ_ONLY === "1")
  check("enabled", entry?.enabled === true)
}

// 2. manual entry wins, even a writer one -----------------------------------
{
  const { registerMcpServer } = runWith({}, fakeHome)
  const manual = { type: "local", command: ["mempalace-mcp"], enabled: true }
  const { entry, reason } = registerMcpServer(manual, fakeBin)
  check("manual entry untouched", entry === null, reason)
}

// 3. no binary anywhere -> no entry, never a broken command -----------------
{
  const emptyHome = join(tmpdir(), `mp-autoreg-empty-${process.pid}`)
  mkdirSync(emptyHome, { recursive: true, mode: 0o700 })
  // PATH without mempalace-mcp: narrow to dirs that cannot contain it.
  const { registerMcpServer, resolveMcpBin } = runWith(
    { PATH: "/usr/bin:/bin", MEMPALACE_MCP_BIN: "" },
    emptyHome,
  )
  const bin = resolveMcpBin()
  const { entry, reason } = registerMcpServer(undefined, bin)
  check("no binary -> no entry", entry === null && bin === "", `${reason} (bin=${JSON.stringify(bin)})`)
  rmSync(emptyHome, { recursive: true, force: true })
}

// 4. MEMPALACE_MCP_BIN override ---------------------------------------------
{
  const { resolveMcpBin } = runWith({ MEMPALACE_MCP_BIN: fakeBin }, "/nonexistent-home")
  check("MEMPALACE_MCP_BIN wins", resolveMcpBin() === fakeBin)
}

rmSync(fakeHome, { recursive: true, force: true })
const ok = checks.every(Boolean)
console.log(ok ? "\nTUTTO OK" : "\nFALLITO")
process.exit(ok ? 0 : 1)