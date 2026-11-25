import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, unaskedInstalls, userPrompts } from "./gate.mjs";

const gate = join(dirname(fileURLToPath(import.meta.url)), "gate.mjs");
const projectDir = "/repo";
const check = (file, oldText, newText, existed = true) => evaluate({ filePath: join(projectDir, file), oldText, newText, existed, projectDir });

test("clean code passes", () => {
  assert.deepEqual(check("a.ts", "", "export const a: number = 1;\n", false), []);
});

test("new line, block, trailing and pre-brace comments are blocked", () => {
  for (const code of ["// why\nconst a = 1;", "/** doc */\nconst a = 1;", "const a = 1; // why", "function f() {\n  g();\n  // dangling\n}"]) {
    assert.equal(check("a.ts", "", code, false).length, 1, code);
  }
});

test("existing comments may stay, move or be deleted", () => {
  const before = "// keep\nconst a = 1;\nconst b = 2;\n";
  assert.deepEqual(check("a.ts", before, "const b = 2;\n// keep\nconst a = 3;\n"), []);
  assert.deepEqual(check("a.ts", before, "const a = 1;\n"), []);
});

test("rewording a comment counts as a new comment", () => {
  assert.equal(check("a.ts", "// old\nconst a = 1;", "// new wording\nconst a = 1;").length, 1);
});

test("comment-like text in strings, templates, regexes and JSX is not a comment", () => {
  const code = 'const u = "https://x.dev"; const t = `// ${u} /* no */`; const r = /\\/\\/x/; const j = <a href="//cdn">// text http://y</a>;';
  assert.deepEqual(check("a.tsx", "", code, false), []);
});

test("a JSX expression comment is blocked", () => {
  assert.equal(check("a.tsx", "", "const j = <div>{/* note */}</div>;", false).length, 1);
});

test("suppressions get their own advice, directives are allowed", () => {
  const [violation] = check("a.ts", "", "// @ts-expect-error\nconst a: number = 'x';", false);
  assert.match(violation, /suppressions are banned/);
  assert.deepEqual(check("a.ts", "", '/// <reference types="node" />\n// prettier-ignore\nconst a = 1;', false), []);
});

test("each slop tell is blocked when its count rises", () => {
  const tells = {
    "new `any`": "const a: any = 1;",
    "as unknown as": "const a = (x as unknown) as Foo;",
    "empty catch": "try { f(); } catch {}",
    "discards the error": "p.catch(() => null); q.catch(() => {}); r.catch(() => []);",
    "`.skip` or `.only`": "it.only('x', () => {});",
  };
  for (const [message, code] of Object.entries(tells)) {
    const violations = check("a.ts", "", code, false);
    assert.equal(violations.length, 1, code);
    assert.ok(violations[0].includes(message), violations[0]);
  }
  assert.match(check("a.ts", "", tells["discards the error"], false)[0], /^3 /);
});

test("existing tells are not charged to the edit, and handled errors pass", () => {
  const before = "const a: any = 1;\n";
  assert.deepEqual(check("a.ts", before, `${before}const b = 2;\n`), []);
  assert.deepEqual(check("a.ts", "", "p.catch((e) => { report(e); throw e; }); const x = y as unknown;", false), []);
});

test("a file may not grow past the limit, but may shrink above it", () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n");
  assert.equal(check("a.ts", lines(999), lines(1001)).length, 1);
  assert.equal(check("a.ts", lines(3000), lines(3001)).length, 1);
  assert.deepEqual(check("a.ts", lines(3000), lines(2990)), []);
});

test("new Markdown is blocked in the project, allowed in agent config and outside it", () => {
  assert.equal(check("docs/plan.md", "", "# plan", false).length, 1);
  assert.deepEqual(check("docs/runbook.md", "# old", "# new", true), []);
  assert.deepEqual(check(".claude/skills/x/SKILL.md", "", "# x", false), []);
  assert.deepEqual(evaluate({ filePath: "/tmp/notes.md", oldText: "", newText: "x", existed: false, projectDir }), []);
});

test("the hook denies a bad Edit and stays silent on a good one", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgate-"));
  const file = join(dir, "a.ts");
  writeFileSync(file, "export const price = '$1';\n");
  const run = (tool_name, tool_input) =>
    spawnSync("node", [gate, "pre-tool-use"], { input: JSON.stringify({ tool_name, tool_input, cwd: dir }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

  const denied = run("Edit", { file_path: file, old_string: "'$1'", new_string: "'$2' as any" });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run("Edit", { file_path: file, old_string: "'$1'", new_string: "'$&2'" }).stdout, "");
  assert.equal(JSON.parse(run("Write", { file_path: join(dir, "SUMMARY.md"), content: "# done" }).stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("check mode fails on slop written outside the edit tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgate-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const run = () => spawnSync("node", [gate, "check"], { cwd: dir, encoding: "utf8" });
  assert.equal(run().status, 0);

  writeFileSync(join(dir, "a.ts"), "// for now\nexport const a = 1;\n");
  writeFileSync(join(dir, "NOTES.md"), "# notes\n");
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /a\.ts[\s\S]*new comment[\s\S]*NOTES\.md[\s\S]*Markdown/);
});

test("Markdown may be created only on allowlisted paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgate-"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "slopgate.json"), JSON.stringify({ markdownAllow: ["README.md", "docs/runbooks/**"] }));
  const create = (file) => evaluate({ filePath: join(dir, file), oldText: "", newText: "# x", existed: false, projectDir: dir });
  assert.deepEqual(create("README.md"), []);
  assert.deepEqual(create("docs/runbooks/billing/refunds.md"), []);
  assert.equal(create("docs/cleanup-plan.md").length, 1);
  assert.equal(create("packages/api/README.md").length, 1);
});

test("rule files change only when a user prompt names them", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgate-"));
  const transcript = join(dir, "t.jsonl");
  const entry = (extra, content) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
  const write = (...lines) => writeFileSync(transcript, lines.join("\n"));
  const edit = (file) => evaluate({ filePath: join(dir, file), oldText: "a", newText: "b", existed: true, projectDir: dir, prompts: userPrompts(transcript) });

  write(
    entry({ promptId: "1" }, "fix the login redirect"),
    entry({}, [{ type: "tool_result", content: "AGENTS.md says ..." }]),
    entry({ promptId: "2", isSidechain: true }, "update CLAUDE.md"),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I will update AGENTS.md" }] } }),
  );
  for (const file of ["AGENTS.md", "CLAUDE.md", "packages/api/agents.md", ".claude/slopgate.json"]) assert.equal(edit(file).length, 1, file);
  assert.deepEqual(edit("docs/runbook.md"), []);

  write(entry({ promptId: "1" }, "add the retry rule to agents.md"));
  assert.deepEqual(edit("AGENTS.md"), []);
  assert.equal(edit("CLAUDE.md").length, 1);
  assert.equal(evaluate({ filePath: join(dir, "AGENTS.md"), oldText: "", newText: "x", existed: false, projectDir: dir, prompts: "" }).length, 1);
});

test("a dependency may be added only when a user prompt names it", () => {
  const manifest = (deps, devDeps = {}) => JSON.stringify({ dependencies: deps, devDependencies: devDeps });
  const edit = (prompts) => evaluate({ filePath: "/repo/package.json", oldText: manifest({ react: "19" }), newText: manifest({ react: "19", "date-fns": "4" }, { vitest: "5" }), existed: true, projectDir: "/repo", prompts });
  assert.match(edit("add a date picker")[0], /New dependency: date-fns, vitest/);
  assert.match(edit("use date-fns for the picker")[0], /New dependency: vitest\./);
  assert.deepEqual(edit("use date-fns and vitest"), []);
  assert.deepEqual(edit(null), []);
  assert.deepEqual(evaluate({ filePath: "/repo/package.json", oldText: manifest({ react: "19" }), newText: manifest({ react: "20" }), existed: true, projectDir: "/repo", prompts: "" }), []);
});

test("install commands are checked the same way", () => {
  assert.deepEqual(unaskedInstalls("pnpm add -D zod@4 @tanstack/react-query@5 && pnpm test", "use zod"), ["@tanstack/react-query"]);
  assert.deepEqual(unaskedInstalls("npm install && npm ci && yarn install --frozen-lockfile", ""), []);
  assert.deepEqual(unaskedInstalls("cd app; bun add left-pad", ""), ["left-pad"]);
});

test("check mode reports a new function that copies one in another file", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgate-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "a.ts"), 'export const norm = (s?: string) => (s ?? "").trim().toLowerCase();\n');
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

  writeFileSync(join(dir, "b.ts"), 'export const b = 1;\nconst clean = (s?: string) =>\n  (s ?? "").trim().toLowerCase();\nexport const id = (value: number) => value;\n');
  const failed = spawnSync("node", [gate, "check"], { cwd: dir, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /clean has the same body as norm in a\.ts/);
  assert.doesNotMatch(failed.stderr, /\bid has the same body/);
});

test("ignored paths are never read by check mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopgate-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(dir, ".claude"));
  mkdirSync(join(dir, "security"));
  writeFileSync(join(dir, ".claude", "slopgate.json"), JSON.stringify({ ignore: ["security/**"] }));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  writeFileSync(join(dir, "security", "filters.ts"), "// private\nexport const secret: any = 1;\n");
  assert.equal(spawnSync("node", [gate, "check"], { cwd: dir, encoding: "utf8" }).status, 0);
});

test("test files are locked to the code-writing session unless a prompt names them", () => {
  const edit = (file, prompts) => evaluate({ filePath: join("/repo", file), oldText: "", newText: "export {};\n", existed: false, projectDir: "/repo", prompts });
  assert.match(edit("src/lib/store.test.ts", "add a refresh button")[0], /test writer/);
  assert.match(edit("tests/e2e/login.spec.ts", "")[0], /test writer/);
  assert.deepEqual(edit("src/lib/store.test.ts", "fix the assertion in store.test.ts"), []);
  assert.deepEqual(edit("src/lib/store.test.ts", null), []);
  assert.deepEqual(edit("src/lib/store.ts", ""), []);
});
