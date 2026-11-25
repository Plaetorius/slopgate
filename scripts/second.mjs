#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_FILE, git, readConfig } from "./gate.mjs";

const TIMEOUT = 15 * 60 * 1000;
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const installed = (binary) => spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0;
const lastLine = (text) => (text ?? "").trim().split("\n").at(-1)?.slice(0, 200) || "no output";

export const PROVIDERS = {
  codex: {
    available: () => installed("codex"),
    run(brief, { cwd, write }) {
      const out = join(mkdtempSync(join(tmpdir(), "slopgate-codex-")), "answer.txt");
      const result = spawnSync("codex", ["exec", "-s", write ? "workspace-write" : "read-only", "--skip-git-repo-check", "-o", out, brief], { cwd, encoding: "utf8", timeout: TIMEOUT });
      const output = existsSync(out) ? readFileSync(out, "utf8").trim() : "";
      return { ok: result.status === 0 && output !== "", output, error: lastLine(result.stderr) };
    },
  },
  claude: {
    available: () => installed("claude"),
    run(brief, { cwd, write }) {
      const mode = write ? ["--permission-mode", "acceptEdits"] : ["--allowedTools", ...READ_ONLY_TOOLS];
      const result = spawnSync("claude", ["-p", "--settings", '{"disableAllHooks":true}', ...mode], { cwd, input: brief, encoding: "utf8", timeout: TIMEOUT });
      const output = (result.stdout ?? "").trim();
      return { ok: result.status === 0 && output !== "", output, error: lastLine(result.stderr || result.stdout) };
    },
  },
};

export function providerOrder(config) {
  const { enabled = true, name = "codex" } = config.secondProvider ?? {};
  return enabled && name !== "claude" ? [name, "claude"] : ["claude"];
}

export function ask(order, providers, brief, options) {
  const failures = [];
  for (const name of order) {
    const provider = providers[name];
    if (!provider?.available()) {
      failures.push(`${name} is not installed`);
      continue;
    }
    const { ok, output, error } = provider.run(brief, options);
    if (ok) return { provider: name, output, failures };
    failures.push(`${name} failed: ${error}`);
  }
  return { provider: null, output: "", failures };
}

export function parseReview(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  try {
    const { findings = [], verdict } = JSON.parse(output.slice(start, end + 1));
    return Array.isArray(findings) && ["pass", "block"].includes(verdict) ? { findings, verdict } : null;
  } catch {
    return null;
  }
}

function reviewBrief(base) {
  const rubric = readFileSync(join(root, "agents", "slop-reviewer.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  return `${rubric}\n\nThe diff to review is the output of \`git diff ${base}\` plus any untracked files. You did not write this change.\n\nReply with one JSON object and nothing else: {"findings": [{"file": "path", "line": 1, "category": "short name of the category", "consequence": "one sentence", "fix": "one sentence", "confidence": "high or medium"}], "verdict": "pass or block"}`;
}

export function reviewChange({ dir, base, providers = PROVIDERS }) {
  const order = providerOrder(readConfig(dir));
  const { provider, output, failures } = ask(order, providers, reviewBrief(base), { cwd: dir, write: false });
  const review = provider ? parseReview(output) : null;
  if (!review) return { ran: false, preferred: order[0], failures: provider ? [...failures, `${provider} returned no readable verdict`] : failures };
  return { ran: true, provider, preferred: order[0], failures, ...review };
}

function testsBrief(criterion, interfaces) {
  return `Write automated tests for this acceptance criterion, and nothing else:\n\n${criterion}\n\n${interfaces.length > 0 ? `The tests call this interface: ${interfaces.join(", ")}. Read those files for names and signatures only.\n\n` : ""}Rules. Create or edit test files only, following the naming and the test runner this repository already uses. Do not create or edit any other file, and do not implement the behaviour. Assert what a user of the code can observe, not how it is built. The tests must fail until the behaviour exists. Do not use mocks where the repository tests against the real thing. End with the list of test files you wrote.`;
}

export function writeTests({ dir, criterion, interfaces, providers = PROVIDERS }) {
  const snapshot = () => new Set(git(dir, ["status", "--porcelain"]).split("\n").filter(Boolean));
  const before = snapshot();
  const { provider, failures } = ask(providerOrder(readConfig(dir)), providers, testsBrief(criterion, interfaces), { cwd: dir, write: true });
  const touched = [...snapshot()].filter((line) => !before.has(line)).map((line) => line.slice(3));
  return { provider, failures, tests: touched.filter((rel) => TEST_FILE.test(rel)), strays: touched.filter((rel) => !TEST_FILE.test(rel)) };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dir = process.cwd();
  if (command === "review" && option("--base")) {
    process.stdout.write(`${JSON.stringify(reviewChange({ dir, base: option("--base") }), null, 2)}\n`);
    return;
  }
  if (command === "tests" && option("--criterion")) {
    const result = writeTests({ dir, criterion: option("--criterion"), interfaces: (option("--interface") ?? "").split(",").filter(Boolean) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.provider && result.tests.length > 0 && result.strays.length === 0 ? 0 : 1);
  }
  process.stderr.write('usage: second.mjs review --base <ref> | second.mjs tests --criterion "<observable outcome>" [--interface <file,file>]\n');
  process.exit(64);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
