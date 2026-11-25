# slopgate

A Claude Code plugin that stops slop before it lands and makes agents prove their work.

It blocks vague prompts, new comments, new Markdown files, unrequested dependencies and common shortcut patterns. For each change it builds a proof page (video, screenshots, graphs, tables) so a human reviews evidence instead of reading the diff.

It needs no other plugin.

## Install

```bash
claude plugin marketplace add Plaetorius/slopgate && claude plugin install slopgate@slopgate
```

Then start a new Claude Code session. On the first session the plugin installs its own dependencies with pnpm. Nothing else to run.

Requirements: Claude Code, Node 22.5 or later, and [pnpm](https://pnpm.io/installation).

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

The same script checks the scope of the change: one declared type, one connected slice of files, at most 600 added lines of non-test code. A button and the endpoint it calls belong in one PR. Unrelated groups of files are listed for splitting.

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
| `proof.capture` | Writes `.png` and `.webm` files into `$SLOPGATE_PROOF_OUT`. Run on the base commit and on the change. |
| `proof.bench` | Prints one JSON line: `{"metric": "...", "unit": "ms", "samples": [1.2, 1.3]}`. |
| `proof.test` | Runs one test file. `{file}` is replaced with its path. |
| `proof.gates` | Extra commands that must exit 0. |
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

## Development

```bash
pnpm install
pnpm test
```
