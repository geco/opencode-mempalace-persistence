#!/bin/bash
# Detached single-wing mine with lock grace. Spawned by exitSync() in
# src/index.ts (detached + unref) so a mine outlives opencode closing.
#
# Why the loop: at close time the palace lock is often still held — MCP
# servers die with opencode but take seconds to release, and a second
# opencode instance may hold it longer. A bare mine would exit on the
# first "held by" and the whole backlog would wait for the next startup.
# This retries held-by for up to 30 minutes, then gives up (logged).
# Any other failure exits immediately: only contention is retried.
#
# Usage: mine-detached.sh <mempalace-bin> <log-file> <mine args...>
# Appends all output to <log-file>. Requires bash + seq + sleep
# (linux/mac; Windows shells with git-bash qualify, bare cmd does not —
# exitSync falls back to a single direct attempt there).
set -u
bin="$1"
log="$2"
shift 2
attempt=0
while [ "$attempt" -lt 30 ]; do
  attempt=$((attempt + 1))
  out="$("$bin" "$@" 2>&1)"
  code=$?
  printf '%s\n' "$out" >> "$log"
  if [ "$code" -eq 0 ]; then exit 0; fi
  case "$out" in
    *"held by"*|*"Held by"*)
      printf '%s lock held, retry %s/30 in 60s\n' "$(date -u +%FT%TZ)" "$attempt" >> "$log"
      sleep 60
      ;;
    *) exit "$code" ;;
  esac
done
printf '%s lock still held after 30 retries, giving up\n' "$(date -u +%FT%TZ)" >> "$log"
exit 1
