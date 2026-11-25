#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_LINES = 1000;
export const CODE_KINDS = { ".ts": "TS", ".mts": "TS", ".cts": "TS", ".tsx": "TSX", ".js": "JSX", ".mjs": "JS", ".cjs": "JS", ".jsx": "JSX" };
const MARKDOWN = new Set([".md", ".mdx", ".markdown"]);
const AGENT_CONFIG_DIRS = new Set([".claude", ".agents", ".cursor", ".codex"]);
const CONFIG_PATH = join(".claude", "slopgate.json");
const RULE_FILES = [CONFIG_PATH, join(".claude", "lint-baseline.json")];
const INSTRUCTION_FILE = /^(AGENTS|CLAUDE)\.md$/i;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const INSTALL_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b([^\n;&|]*)/g;
export const TEST_FILE = /[./](test|spec)\.|(^|\/)(tests?|__tests__)\//;
const MIN_CLONE_CHARS = 30;
const DEPENDENCY_ADVICE =
  "The user has not named it in this session. Use what the repository, the platform or an installed dependency already provides. If nothing does, stop and ask the user for the dependency by name.";
const ALLOWED_COMMENT = /^\/\/\/\s*<reference|prettier-ignore|@license|@preserve|SPDX-License|Copyright|webpack[A-Z]\w+:|@vite-ignore/;
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore/;

const COMMENT_ADVICE =
  "Comments are banned in this codebase. Do not move the text into another comment, a doc file or a string. If the comment explained what the code does, rename or restructure until the code says it. If it justified a workaround, a fallback or a shortcut, the workaround is the defect: fix the cause, or stop and tell the user what blocks the proper fix.";
const SUPPRESSION_ADVICE = "Lint and type suppressions are banned. Fix what the rule reports.";
const TELL_ADVICE = {
  any: "new `any`. Give the value its real type, or parse it at the boundary.",
  doubleCast: "new `as unknown as` cast. Fix the type that disagrees instead of forcing it.",
  emptyCatch: "new empty catch block. Handle the error or let it propagate.",
  swallowedRejection: "new `.catch` that discards the error. Handle it, or let it propagate to a caller that can.",
  focusedTest: "new `.skip` or `.only` on a test. Fix the test or the code under test.",
};

const pluginRequire = createRequire(import.meta.url);

export function loadTypeScript(fromDir) {
  for (const req of [createRequire(join(fromDir, "noop.js")), pluginRequire]) {
    try {
      return req("typescript");
    } catch {
      continue;
    }
  }
  return null;
}

function multiset(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function added(before, after) {
  const remaining = multiset(before);
  return after.filter((item) => {
    const left = remaining.get(item) ?? 0;
    if (left > 0) remaining.set(item, left - 1);
    return left === 0;
  });
}

function lineHeuristicComments(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("//") || line.startsWith("/*") || line.startsWith("* "));
}

function isDiscardedValue(ts, node) {
  let body = node;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (ts.isBlock(body)) return body.statements.length === 0;
  if (body.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(body)) return body.text === "undefined";
  if (ts.isArrayLiteralExpression(body)) return body.elements.length === 0;
  if (ts.isObjectLiteralExpression(body)) return body.properties.length === 0;
  return false;
}

function unwrapParens(ts, node) {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

function scan(ts, filePath, text) {
  const kind = ts.ScriptKind[CODE_KINDS[extname(filePath).toLowerCase()]];
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
  const commentsByPos = new Map();
  const jsxTextRanges = [];
  const tells = { any: 0, doubleCast: 0, emptyCatch: 0, swallowedRejection: 0, focusedTest: 0 };
  const functions = [];
  const compact = (code) => code.replace(/\s+/g, "");
  const collect = (ranges) => {
    for (const range of ranges ?? []) commentsByPos.set(range.pos, text.slice(range.pos, range.end));
  };

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxTextRanges.push([node.getFullStart(), node.getEnd()]);
      return;
    }
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));

    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.push({ name: node.name.text, body: compact(text.slice(node.parameters.pos, node.end)) });
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.push({ name: node.name.text, body: compact(node.initializer.getText(source)) });
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) tells.any += 1;
    if (ts.isAsExpression(node) && node.type.kind !== ts.SyntaxKind.UnknownKeyword) {
      const inner = unwrapParens(ts, node.expression);
      if (ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) tells.doubleCast += 1;
    }
    if (ts.isCatchClause(node) && node.block.statements.length === 0) tells.emptyCatch += 1;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const handler = node.arguments[0];
      if (method === "catch" && handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && isDiscardedValue(ts, handler.body)) {
        tells.swallowedRejection += 1;
      }
      const receiver = node.expression.expression;
      if ((method === "skip" || method === "only") && ts.isIdentifier(receiver) && ["it", "test", "describe"].includes(receiver.text)) {
        tells.focusedTest += 1;
      }
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);

  const comments = [...commentsByPos]
    .filter(([pos]) => !jsxTextRanges.some(([start, end]) => pos >= start && pos < end))
    .map(([, comment]) => comment);
  return { comments, tells, functions: functions.filter(({ body }) => body.length >= MIN_CLONE_CHARS) };
}

function insideProject(filePath, projectDir) {
  const rel = relative(projectDir, filePath);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

export function readConfig(projectDir) {
  const configPath = join(projectDir, CONFIG_PATH);
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
}

export function unignored(projectDir) {
  const ignore = readConfig(projectDir).ignore ?? [];
  return (rel) => rel !== "" && !ignore.some((pattern) => matchesGlob(rel, pattern));
}

function markdownAllowlist(projectDir) {
  return readConfig(projectDir).markdownAllow ?? [];
}

function isRuleFile(filePath, projectDir) {
  return INSTRUCTION_FILE.test(basename(filePath)) || RULE_FILES.some((rel) => filePath === join(projectDir, rel));
}

function dependencyNames(packageJson) {
  try {
    const manifest = JSON.parse(packageJson);
    return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}));
  } catch {
    return [];
  }
}

const unnamed = (prompts) => (dependency) => !prompts.toLowerCase().includes(dependency.toLowerCase());

export function unaskedInstalls(command, prompts) {
  return [...command.matchAll(INSTALL_COMMAND)]
    .flatMap(([, args]) => args.split(/\s+/).filter((arg) => arg && !arg.startsWith("-")))
    .map((spec) => spec.replace(/(?!^)@.*$/, ""))
    .filter(unnamed(prompts));
}

export function userPrompts(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  return readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "user" && entry.promptId && !entry.isSidechain && !entry.isMeta)
    .map(({ message: { content } }) => (typeof content === "string" ? content : content.map((block) => block.text ?? "").join("\n")))
    .join("\n");
}

export function evaluate({ filePath, oldText, newText, existed, projectDir, prompts = null }) {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath);
  const violations = [];

  if (isRuleFile(filePath, projectDir)) {
    if (prompts !== null && !prompts.toLowerCase().includes(name.toLowerCase())) {
      violations.push(
        `${name} holds the rules for agents and only the user changes it. The user has not named ${name} in this session. Do not record preferences, lessons or remarks there. If a rule is worth keeping, propose it in your reply as a type, a test or a lint rule.`,
      );
    }
    return violations;
  }

  if (MARKDOWN.has(ext) && !existed && insideProject(filePath, projectDir)) {
    const rel = relative(projectDir, filePath);
    const allowed = rel.split(sep).some((segment) => AGENT_CONFIG_DIRS.has(segment)) || markdownAllowlist(projectDir).some((pattern) => matchesGlob(rel, pattern));
    if (!allowed) {
      violations.push(
        `Creating Markdown files is banned outside the paths listed in ${CONFIG_PATH} (${rel}). Put plans, summaries and findings in your reply to the user.`,
      );
    }
  }

  if (name === "package.json" && prompts !== null) {
    const unasked = added(dependencyNames(oldText), dependencyNames(newText)).filter(unnamed(prompts));
    if (unasked.length > 0) violations.push(`New dependency: ${unasked.join(", ")}. ${DEPENDENCY_ADVICE}`);
  }

  if (!(ext in CODE_KINDS)) return violations;

  const ts = loadTypeScript(dirname(filePath));
  const before = ts ? scan(ts, filePath, oldText) : { comments: lineHeuristicComments(oldText), tells: {} };
  const after = ts ? scan(ts, filePath, newText) : { comments: lineHeuristicComments(newText), tells: {} };

  const newComments = added(before.comments.map((c) => c.trim()), after.comments.map((c) => c.trim())).filter((c) => !ALLOWED_COMMENT.test(c));
  if (newComments.length > 0) {
    const hasSuppression = newComments.some((c) => SUPPRESSION.test(c));
    const hasProse = newComments.some((c) => !SUPPRESSION.test(c));
    const shown = newComments.slice(0, 5).map((c) => `  ${c.split("\n")[0].slice(0, 120)}`).join("\n");
    violations.push(`${newComments.length} new comment(s):\n${shown}\n${[hasProse && COMMENT_ADVICE, hasSuppression && SUPPRESSION_ADVICE].filter(Boolean).join(" ")}`);
  }

  for (const [tell, advice] of Object.entries(TELL_ADVICE)) {
    const increase = (after.tells[tell] ?? 0) - (before.tells[tell] ?? 0);
    if (increase > 0) violations.push(`${increase} ${advice}`);
  }

  const oldLines = oldText === "" ? 0 : oldText.split("\n").length;
  const newLines = newText.split("\n").length;
  if (newLines > MAX_FILE_LINES && newLines > oldLines) {
    violations.push(
      `${basename(filePath)} would grow from ${oldLines} to ${newLines} lines; the limit is ${MAX_FILE_LINES}. Put the new code in a module with one responsibility, or extract an existing responsibility first.`,
    );
  }
  return violations;
}

function applyEdit(text, { old_string, new_string, replace_all }) {
  return replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
}

function fromToolCall({ tool_name, tool_input, cwd, transcript_path }) {
  const filePath = resolve(cwd, tool_input.file_path);
  const existed = existsSync(filePath);
  const oldText = existed ? readFileSync(filePath, "utf8") : "";
  const edits = tool_input.edits ?? [tool_input];
  const newText = tool_name === "Write" ? tool_input.content : edits.reduce(applyEdit, oldText);
  return { filePath, oldText, newText, existed, projectDir: process.env.CLAUDE_PROJECT_DIR ?? cwd, prompts: userPrompts(transcript_path) };
}

export function git(projectDir, args) {
  return execFileSync("git", args, { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

function functionOwners(projectDir, ts) {
  const owners = new Map();
  const files = git(projectDir, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(unignored(projectDir));
  for (const rel of files) {
    const filePath = join(projectDir, rel);
    if (!(extname(rel).toLowerCase() in CODE_KINDS) || TEST_FILE.test(rel) || !existsSync(filePath)) continue;
    for (const { name, body } of scan(ts, filePath, readFileSync(filePath, "utf8")).functions) {
      owners.set(body, [...(owners.get(body) ?? []), { rel, name }]);
    }
  }
  return owners;
}

function cloneViolations(ts, owners, rel, filePath, oldText, newText) {
  if (!(extname(rel).toLowerCase() in CODE_KINDS) || TEST_FILE.test(rel)) return [];
  const before = scan(ts, filePath, oldText).functions.map(({ body }) => body);
  return scan(ts, filePath, newText)
    .functions.filter(({ body }) => !before.includes(body))
    .flatMap(({ name, body }) => {
      const twin = (owners.get(body) ?? []).find((owner) => owner.rel !== rel);
      return twin ? [`${name} has the same body as ${twin.name} in ${twin.rel}. Import that one, or move it to a shared module and import it from both.`] : [];
    });
}

function checkWorkingTree(projectDir, base) {
  const ts = loadTypeScript(projectDir);
  const owners = ts ? functionOwners(projectDir, ts) : new Map();
  const changed = git(projectDir, ["diff", "--name-only", "--diff-filter=AM", base]).split("\n");
  const untracked = git(projectDir, ["ls-files", "--others", "--exclude-standard"]).split("\n");
  const failures = [];
  for (const rel of new Set([...changed, ...untracked].filter(unignored(projectDir)))) {
    const filePath = join(projectDir, rel);
    if (!existsSync(filePath)) continue;
    let oldText = "";
    let existed = true;
    try {
      oldText = git(projectDir, ["show", `${base}:${rel}`]);
    } catch {
      existed = false;
    }
    const newText = readFileSync(filePath, "utf8");
    const violations = evaluate({ filePath, oldText, newText, existed, projectDir });
    if (ts) violations.push(...cloneViolations(ts, owners, rel, filePath, oldText, newText));
    if (violations.length > 0) failures.push(`${rel}\n${violations.map((v) => `- ${v}`).join("\n")}`);
  }
  return failures;
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "check") {
    const baseFlag = rest.indexOf("--base");
    const failures = checkWorkingTree(process.cwd(), baseFlag === -1 ? "HEAD" : rest[baseFlag + 1]);
    if (failures.length === 0) return;
    process.stderr.write(`${failures.join("\n\n")}\n`);
    process.exit(1);
  }
  if (mode !== "pre-tool-use") {
    process.stderr.write("usage: gate.mjs pre-tool-use < hook-input.json | gate.mjs check [--base <ref>]\n");
    process.exit(64);
  }
  const call = JSON.parse(readFileSync(0, "utf8"));
  const unasked = call.tool_name === "Bash" ? unaskedInstalls(call.tool_input.command, userPrompts(call.transcript_path)) : [];
  const violations = call.tool_name === "Bash" ? (unasked.length > 0 ? [`New dependency: ${unasked.join(", ")}. ${DEPENDENCY_ADVICE}`] : []) : evaluate(fromToolCall(call));
  if (violations.length === 0) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `slopgate blocked this call.\n${violations.map((v) => `- ${v}`).join("\n")}`,
      },
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
