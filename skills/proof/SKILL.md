---
name: proof
description: Build the proof page for the current change and publish it for the human reviewer. Use when a change is ready for review, before opening or updating a PR, or when asked for proof that a change works.
---

# Proof

The reviewer reads this page, not the diff. The script decides which proof the change needs and in which medium. Do not choose, add or drop media yourself, and do not describe the result in place of running it.

1. Commit or stage nothing extra. Run, from the repository root:

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/proof.mjs" --base <base ref> --title "<type>: <observable outcome>"`

   The base ref is the branch the PR targets. The title starts with one of feat, fix, perf, refactor, chore, docs, test.
2. Read the lines it prints. Each `MISSING` or `SCOPE` line is work still owed:
   - `SCOPE ... unrelated groups`: split the change into one PR per group.
   - `MISSING regression`: the tests pass without the change, so they prove nothing. This is a test problem, not a wording problem.
   - `MISSING visual`, `measurement`: the capture or bench command failed or is not configured in `.claude/slopgate.json`. Fix the scenario. If the command is not configured, stop and tell the user.
   - `MISSING integration`: nothing calls the new API file. Either wire the caller or remove the endpoint.
3. When it prints `PROOF COMPLETE`, publish the page it names with the Artifact tool: `file_path` is that `index.html`, `root` is its folder, and `files` lists every file under `visual/`. Give the user the link.
4. If it still prints `PROOF INCOMPLETE` after your fixes, publish the page anyway and say which proofs are missing. Never edit `index.html` or `proof.json` by hand.
