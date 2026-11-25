---
name: tests
description: Have the separate test writer produce the tests for an acceptance criterion before the code is written. Use at the start of a feature or bug fix, and whenever an edit to a test file is denied.
---

# Tests

The session that writes the code does not write its own tests. A separate writer does, from the acceptance criterion alone. By default that writer is a second provider (Codex). When it is not installed, is turned off, or fails, the writer is a fresh Claude session that has not seen your work.

1. State the acceptance criterion as an observable outcome. Agree the interface first: the function, route or component name the tests will call. Create that file with the signature only if it does not exist.
2. Run, from the repository root:

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/second.mjs" tests --criterion "<observable outcome>" --interface <file,file>`

3. Read the JSON it prints. `tests` lists the files written. A non-empty `strays` means the writer touched a non-test file: show the user and stop. A non-empty `failures` with a `provider` means the preferred writer failed and the fallback was used: say so in your reply.
4. Run the new tests and confirm they fail. Then write the code until they pass.
5. If a test is wrong, do not edit it. Say what is wrong and run this skill again with a corrected criterion, or ask the user to name the test file in their prompt.
