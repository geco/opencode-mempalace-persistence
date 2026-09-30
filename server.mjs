// Root server entry, used when this package is loaded as a LOCAL DIRECTORY
// (a `file://` path or a symlink in ~/.config/opencode/plugins/). The host
// resolves a directory's server entry as `<dir>/server` before `<dir>/index`
// (packages/plugin/src/host.ts), so without this file a local install has no
// server entry at all. The published package is loaded by name and uses
// `main` / `exports["."]` instead, so this is only for local development.
export { default } from "./dist/index.js"
