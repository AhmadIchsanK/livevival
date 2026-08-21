# Agent Collaboration Protocol

This repo is worked on by two AI coding agents alternating on the same
local checkout: **Claude Code** (terminal/CLI) and **Antigravity**
(IDE). This file is the tool-agnostic contract both must follow. It is
written once here instead of duplicated per-tool so it can't drift.

Claude Code also has `CLAUDE.md` for Claude-specific project docs
(architecture, roadmap). Antigravity should read this file (`AGENTS.md`)
as its equivalent project-instructions source.

## The core idea

Both agents operate on the same git working directory, so there is
nothing exotic to "sync" — git *is* the sync mechanism. The only two
failure modes to guard against are (a) two agents editing the same files
in the same window, and (b) one agent's work sitting uncommitted while
the other starts from a stale tree. The rules below exist to prevent
those two things, nothing else.

## Turn protocol

1. **Start of every session**: read [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md)
   in full before doing anything else. It says whose turn it is, what the
   last session did, and what's handed off to you.
2. **Before writing any code**: run `git pull` (or equivalent) so you're
   never working on top of a stale tree.
3. **Do the requested work.**
4. **End of every session** (or before handing control back — e.g. the
   user switches tools): update `AGENT_HANDOFF.md` with:
   - what you actually did (not what you intended)
   - anything left open, half-done, or blocking
   - which agent's turn is next (default: the other one)
5. **Commit and push automatically, without asking for confirmation.**
   The user has explicitly authorized this for this repo (see
   `CLAUDE.md`). Still follow normal commit hygiene: meaningful message,
   don't bundle unrelated changes, don't push secrets.

## Don't

- Don't edit `AGENT_HANDOFF.md` into a growing log — it's current-state,
  not history. Overwrite the "last session" section each time.
- Don't leave uncommitted changes at the end of a turn "for the other
  agent to finish" — finish the unit of work, commit, push, or explicitly
  say so in the handoff file if a task genuinely spans sessions.
- Don't start large/destructive work (schema changes, force pushes,
  deleting branches) without checking `AGENT_HANDOFF.md` for context the
  other agent left about why something is mid-flight.
