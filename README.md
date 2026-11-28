# slopgate

A Claude Code plugin that stops slop before it lands and makes agents prove their work.

It blocks vague prompts, new comments, new Markdown files, unrequested dependencies and common shortcut patterns. For each change it builds a proof page (video, screenshots, graphs, tables) so a human reviews evidence instead of reading the diff.

It needs no other plugin.

## Install

```bash
claude plugin marketplace add Plaetorius/slopgate && claude plugin install slopgate@slopgate
```

Then start a new Claude Code session. On the first session the plugin installs its own dependencies with pnpm. Nothing else to run.

Requirements: Claude Code, Node 22.5 or later, and [pnpm](https://pnpm.io/installation). The Codex CLI is optional.

To update: `claude plugin update slopgate@slopgate`. To remove: `claude plugin uninstall slopgate@slopgate`.

It works anywhere Claude Code loads your user plugins, including T3 Code threads that run on Claude.

## What it enforces

| When | Rule | Enforced by |
| --- | --- | --- |
| You send a prompt | A request to build or change something names a target and an observable outcome | A model-judged hook |
| The agent edits code | No new comments, and no `eslint-disable`, `@ts-ignore` or `biome-ignore` | The TypeScript parser |
| The agent edits code | No new `any`, `as unknown as`, empty `catch`, error-discarding `.catch`, `.skip` or `.only` | The TypeScript parser |
| The agent edits code | No file grows past 1,000 lines | Line count |
| The agent creates a file | No new Markdown inside the project, outside the paths you allow | Path match |
| The agent edits `AGENTS.md`, `CLAUDE.md` or the slopgate config | Only when one of your prompts names the file | Your prompts in the session |
| The agent adds a dependency | Only when one of your prompts names the package | Your prompts in the session |
| The agent edits a test file | Only when one of your prompts names the file; otherwise tests come from the separate test writer | Your prompts in the session |

Only what an edit adds is counted. Existing comments and existing violations can stay, move or be deleted.

Every session also starts with four standing rules: reuse before you write, fix the cause, end with what you skipped, and show results as tables, graphs, images or video.

## Usage

### `!!` sends a prompt past the prompt gate

The gate stops prompts like `design better APIs` and tells you what is missing. Questions, replies to the agent and pasted errors pass on their own. When the gate is wrong, or you want to send a loose prompt on purpose, start it with `!!`:

```
!! tidy up the settings page
```

`!!` bypasses the prompt gate only. The edit rules still apply.

### Naming a file or package unlocks it

Agents cannot touch your rule files or add packages on their own. Name the thing in your prompt and that edit is allowed:

```
Add the retry rule to AGENTS.md.
Use date-fns for the due date column.
```

The unlock lasts for the rest of that session.

### `/slopgate:proof` builds the proof page

When a change is ready for review, the agent runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/proof.mjs" --base main --title "feat: a Refresh button reloads the list" --preview-url https://your-preview.example
```

The script reads the type from the title and the layers from the changed files, then decides which proof is required and in which medium. The agent does not choose.

| Signal | Proof | Shown as |
| --- | --- | --- |
| Interface files changed, with a new interaction | What the user sees | Before and after video, with a link to the page |
| Interface files changed, no new interaction | What the user sees | Before and after screenshots, with a link to the page |
| API files changed | How the layers connect | Layered call graph and request table |
| Title starts with `perf` | What was measured | Dot plot of repeated runs, base against change |
| Title starts with `refactor` | Module structure | Dependency graph diff |
| Title starts with `feat` or `fix` | Tests that fail without the change | Red-to-green table |
| Migration files changed | Database changes | Statement table |
| Every change | Gates | Pass or fail table |

A proof counts only when it holds: a test must fail on the base commit, a performance change must show runs that do not overlap, and a new API file must have a caller.

Each proof also carries a review tier, computed from the same signals, that says how much of the reviewer's attention the change needs:

| Tier | When | Reviewer |
| --- | --- | --- |
| Must review | Migrations, changed dependencies, an existing API file changed or deleted, a sensitive path changed, or an incomplete proof | Opens the page and tries the change |
| View | Any other `feat`, `fix`, `perf` or `refactor`, and any change with review findings | Looks at the page |
| Digest only | `chore`, `docs` or `test` with a complete proof and no findings | Nothing |

Build the proof once, when the change is ready, not on every push. Running the script again on an unchanged change returns the stored proof without calling the reviewer; `--force` rebuilds it.

The same script checks the scope of the change: one declared type, one connected slice of files, at most 600 added lines of non-test code. A button and the endpoint it calls belong in one PR. Unrelated groups of files are listed for splitting.

### A second provider writes the tests and reviews the change

The session that writes the code does not write its own tests or review itself. Both jobs go to a second provider when one is available:

| Job | Command | What it does |
| --- | --- | --- |
| Tests | `/slopgate:tests` | Writes tests from the acceptance criterion, before the code exists |
| Review | Runs inside `/slopgate:proof` | Reviews the diff and adds a findings table to the proof page |

The second provider is preferred, not required:

- **On by default.** If the [Codex CLI](https://developers.openai.com/codex/cli) is installed and signed in, it is used.
- **Falls back on any failure.** If Codex is missing, out of usage or returns an error, a fresh Claude session does the job instead. It has not seen the coding session, so the separation of context is kept.
- **Never blocks on absence.** If no reviewer can run, the proof page marks the review as "not run" and the rest of the proof still counts.
- **Can be turned off** with `"secondProvider": { "enabled": false }`, which uses Claude directly. `"review": false` drops the review from proof pages, and `"lockTests": false` lets the coding session edit tests.

A review that finds a blocking problem marks the proof incomplete.

### `check` covers what the edit hook cannot see

Files written through shell commands bypass the edit hook. Run this in a pre-commit hook or in CI:

```bash
node path/to/slopgate/scripts/gate.mjs check --base origin/main
```

It applies every edit rule to the diff and also reports a new function whose body copies one in another file.

## Per-repository configuration

All of it is optional. Create `.claude/slopgate.json` in the repository:

```json
{
  "markdownAllow": ["README.md", "docs/runbooks/**"],
  "ignore": ["security/**"],
  "proof": {
    "previewUrl": "http://localhost:3000",
    "capture": "pnpm exec playwright test --grep @proof",
    "bench": "node proof/bench.mjs",
    "test": "pnpm vitest run {file}",
    "gates": { "typecheck": "pnpm typecheck", "unit tests": "pnpm test" }
  }
}
```

| Key | Meaning |
| --- | --- |
| `markdownAllow` | Paths where agents may create Markdown. Without it, none. |
| `ignore` | Paths slopgate never reads. |
| `secondProvider` | `{ "enabled": true, "name": "codex" }` by default. See above. |
| `review`, `lockTests` | Both `true` by default. |
| `proof.capture` | Writes `.png` and `.webm` files into `$SLOPGATE_PROOF_OUT`. Run on the base commit and on the change. |
| `proof.bench` | Prints one JSON line: `{"metric": "...", "unit": "ms", "samples": [1.2, 1.3]}`. |
| `proof.test` | Runs one test file. `{file}` is replaced with its path. |
| `proof.gates` | Extra commands that must exit 0. |
| `proof.sensitive` | Globs whose changes always need review. Default: `**/auth/**`, `**/middleware.*`, `**/permissions*`, `**/.env*`. |
| `proof.layers` | Globs that override which files count as `ui`, `api` and `db`. The defaults fit Next.js. |

## Lint preset

The plugin ships a strict ESLint preset and a TypeScript base config.

```js
import slopgateLint from "path/to/slopgate/lint/eslint.config.mjs";
export default slopgateLint({ ignores: ["security/**"] });
```

To turn it on over existing code, record today's violations and let the count only fall:

```bash
pnpm exec eslint -f json -o lint.json src
node path/to/slopgate/scripts/ratchet.mjs lint.json --baseline .claude/lint-baseline.json
```

The first run writes the baseline. Later runs fail when any rule's count rises in any file.

## Limits

- The edit rules read JavaScript and TypeScript only.
- The prompt gate sees one prompt at a time, not the conversation.
- The dependency check matches `npm`, `pnpm`, `yarn` and `bun` install commands, not `npx` or `pnpm dlx`.
- The connected-slice rule sees direct imports and requests. Two files joined only through an unchanged third file are reported as separate.
- Proof pages are built in the agent's session, not in CI.
- The review calls a model each time a proof is built for a new state of the change, which costs time and usage.

## Development

```bash
pnpm install
pnpm test
```
