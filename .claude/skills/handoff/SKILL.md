---
name: handoff
description: Coordinate turn-based work with Antigravity IDE on this same repo. Use proactively at the start of a session (or when the user says things like "sync with antigravity", "lanjutkan dari antigravity", "giliran siapa") to read the shared handoff state, and at the end of a session or logical unit of work to update it, commit, and push automatically.
---

# Handoff protocol (Claude Code ↔ Antigravity)

This repo is worked on by both Claude Code and Antigravity, alternating
on the same local checkout. Full protocol lives in `AGENTS.md` — read it
if this is your first time seeing this skill. This file is the
operational checklist.

## At the start of a session

1. Read `AGENT_HANDOFF.md`. Note: whose turn it was, what the last
   session did, what's handed off to you, any open blockers.
2. Run `git pull` before editing anything.
3. If `AGENT_HANDOFF.md` says the other agent left work mid-flight
   (uncommitted, half-done), surface that to the user before proceeding
   — don't silently plow ahead over it.

## At the end of a session / logical unit of work

1. Update `AGENT_HANDOFF.md`:
   - overwrite "Current turn" to the other agent (Antigravity), unless
     the user says they're staying in Claude Code next
   - overwrite "Last session summary" with what actually happened
   - update "Open threads / blockers" and "In-flight branch / commits"
2. Stage and commit the actual work plus the updated `AGENT_HANDOFF.md`
   in the same commit (or a trailing `docs: update agent handoff`
   commit if the work commit already landed).
3. `git push` — **do not ask for confirmation first**. The user has
   explicitly authorized automatic push for this repo (see the "Auto
   Push" section in `CLAUDE.md`). Still use judgment: never push if
   there's a merge conflict, failing build you introduced, or anything
   that looks like it needs the user's eyes first — in that case, stop
   and say why instead of pushing broken state.

## Notes

- Keep `AGENT_HANDOFF.md` short — it's current-state, not a changelog.
  Detailed technical history for specific initiatives (e.g. the
  reconstruction engine work) belongs in its own doc
  (`LIVEVIVAL_AI_EXECUTION_STATE.md` is the existing example), not here.
- If the user is bouncing between tools rapidly in one sitting, still
  update the handoff file at each real handoff point — it's cheap and
  it's the whole point of the protocol.
