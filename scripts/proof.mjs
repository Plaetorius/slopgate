#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_KINDS, TEST_FILE, git, loadTypeScript, readConfig, unignored } from "./gate.mjs";
import { buildGraph, connectedGroups, moduleEdges, pathAliases } from "./graph.mjs";
import { quantile, renderPage } from "./render.mjs";
import { reviewChange } from "./second.mjs";

const TYPES = ["feat", "fix", "perf", "refactor", "chore", "docs", "test"];
const TITLE = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/;
const MAX_ADDED_LINES = 600;
const DIGEST_TYPES = ["chore", "docs", "test"];
const DEFAULT_SENSITIVE = ["**/auth/**", "**/middleware.*", "**/permissions*", "**/.env*"];
const INTERACTION = /\bon[A-Z]\w*=|addEventListener\(|<form\b/;
const MIGRATION_STATEMENT = /^\s*((?:create|alter|drop)\s+(?:unique\s+)?(?:table|index|type|policy|function|view|extension)\b[^;(]*)/i;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const DEFAULT_LAYERS = {
  api: ["**/app/api/**", "**/actions.ts", "**/actions/**"],
  db: ["supabase/migrations/**", "drizzle/**", "**/migrations/**"],
  ui: ["src/app/**/*.tsx", "app/**/*.tsx", "src/components/**", "components/**", "**/*.css"],
};

const PAGE_FILE = /(?:^|\/)app\/(.*\/)?page\.[jt]sx?$/;

export function routeOf(rel, declared = {}) {
  if (declared[rel]) return declared[rel];
  const match = PAGE_FILE.exec(rel);
  return match ? `/${(match[1] ?? "").split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment)).join("/")}` : null;
}

export function pagesShowing(files, edges, declared, previewUrl) {
  const seen = new Set(files);
  const queue = [...files];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const { from, to, kind } of edges) {
      if (to === file && kind === "import" && !seen.has(from)) {
        seen.add(from);
        queue.push(from);
      }
    }
  }
  return [...seen].filter((file) => routeOf(file, declared)).sort().map((file) => {
    const route = routeOf(file, declared);
    return { file, route, url: previewUrl && !route.includes("[") ? previewUrl.replace(/\/$/, "") + route : null };
  });
}

const isCode = (rel) => extname(rel).toLowerCase() in CODE_KINDS;
const gatePath = join(dirname(fileURLToPath(import.meta.url)), "gate.mjs");

export function layerOfFile(rel, layers) {
  if (TEST_FILE.test(rel)) return "test";
  const named = ["api", "db", "ui"].find((layer) => (layers[layer] ?? []).some((pattern) => matchesGlob(rel, pattern)));
  return named ?? (isCode(rel) ? "lib" : "other");
}

export function parseTitle(title) {
  const match = TITLE.exec(title);
  return match && TYPES.includes(match[1]) ? { type: match[1], subject: match[2] } : { type: null, subject: title };
}

export function requiredProofs(type, { layers, interaction, dependencies, review = false }) {
  const rules = [
    { id: "visual", when: layers.has("ui"), medium: interaction ? "before and after video" : "before and after screenshots", because: interaction ? "interface files changed and the change adds an interaction" : "interface files changed, with no new interaction" },
    { id: "integration", when: layers.has("api"), medium: "layered call graph", because: layers.has("ui") ? "interface and API files changed together" : "API files changed" },
    { id: "schema", when: layers.has("db"), medium: "table of migration statements", because: "migration files changed" },
    { id: "measurement", when: type === "perf", medium: "plot of repeated runs, base against change", because: "the change is declared as a performance change" },
    { id: "structure", when: type === "refactor", medium: "module dependency graph diff", because: "the change is declared as a refactor" },
    { id: "regression", when: type === "feat" || type === "fix", medium: "red-to-green test table", because: `the change is declared as a ${type === "fix" ? "bug fix" : "feature"}` },
    { id: "dependencies", when: dependencies, medium: "table", because: "package.json dependencies changed" },
    { id: "gates", when: true, medium: "pass or fail table", because: "every change" },
    { id: "review", when: review, medium: "table of findings", because: "every change, unless turned off" },
  ];
  return rules.filter(({ when }) => when).map(({ id, medium, because }) => ({ id, medium, because }));
}

export function scopeChecks({ type, changes, layers, addedCodeLines, groups }) {
  const tests = changes.filter(({ rel, status }) => TEST_FILE.test(rel) && status !== "A");
  const checks = [
    { rule: "The change declares one type", pass: type !== null, detail: type ? `Declared as ${type}.` : `The title must start with one of: ${TYPES.join(", ")}.` },
    {
      rule: "The change is one connected slice",
      pass: groups.length <= 1,
      detail: groups.length <= 1 ? "Every changed code file is linked to the others by an import or a request." : `${groups.length} unrelated groups, open one PR for each: ${groups.map((group) => `[${group.join(", ")}]`).join(" ")}`,
    },
    { rule: `The change adds at most ${MAX_ADDED_LINES} lines of non-test code`, pass: addedCodeLines <= MAX_ADDED_LINES, detail: `${addedCodeLines} lines added.` },
  ];
  if (type === "refactor") {
    checks.push({ rule: "A refactor leaves existing tests and the database untouched", pass: tests.length === 0 && !layers.has("db"), detail: tests.length > 0 ? `Changed tests: ${tests.map(({ rel }) => rel).join(", ")}` : layers.has("db") ? "Migration files changed." : "No existing test or migration changed." });
  }
  if (type === "perf") {
    checks.push({ rule: "A performance change leaves existing tests untouched", pass: tests.length === 0, detail: tests.length > 0 ? `Changed tests: ${tests.map(({ rel }) => rel).join(", ")}` : "No existing test changed." });
  }
  return checks;
}

export function measurementVerdict(base, head, higherIsBetter = false) {
  const sign = higherIsBetter ? -1 : 1;
  const [b, h] = [base, head].map((samples) => samples.map((value) => value * sign));
  const change = ((quantile(head, 0.5) - quantile(base, 0.5)) / quantile(base, 0.5)) * 100;
  if (quantile(h, 0.75) < quantile(b, 0.25)) return { verdict: "improved", change };
  if (quantile(h, 0.25) > quantile(b, 0.75)) return { verdict: "regressed", change };
  return { verdict: "no measurable change", change };
}

export function reviewTier({ type, layers, dependencies, changedApi, sensitive, findings, complete }) {
  const triggers = [
    { when: layers.has("db"), reason: "Migration files changed." },
    { when: dependencies, reason: "package.json dependencies changed." },
    { when: changedApi.length > 0, reason: `Existing API files changed: ${changedApi.join(", ")}` },
    { when: sensitive.length > 0, reason: `Sensitive paths changed: ${sensitive.join(", ")}` },
    { when: !complete, reason: "The proof is incomplete." },
  ];
  const reasons = triggers.filter(({ when }) => when).map(({ reason }) => reason);
  if (reasons.length > 0) return { tier: "must review", reasons };
  return { tier: DIGEST_TYPES.includes(type) && findings === 0 ? "digest only" : "view", reasons };
}

export function fingerprint({ base, title, previewUrl, files }) {
  const ordered = files.map(({ rel, status, text }) => [rel, status, text]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([base, title, previewUrl ?? null, ordered])).digest("hex");
}

function run(command, cwd, env = {}) {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", env: { ...process.env, ...env }, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n");
  return { code: result.status ?? 1, stdout: result.stdout ?? "", tail };
}

function textAt(dir, ref, rel) {
  try {
    return git(dir, ["show", `${ref}:${rel}`]);
  } catch {
    return "";
  }
}

function readChanges(dir, base) {
  const tracked = git(dir, ["diff", "--name-status", "--no-renames", base]).split("\n").filter(Boolean).map((line) => line.split("\t")).map(([status, rel]) => ({ status, rel }));
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).map((rel) => ({ status: "A", rel }));
  return [...tracked, ...untracked];
}

function addedLines(dir, base, { rel, status }) {
  if (status === "D") return [];
  const diff = git(dir, ["diff", "-U0", base, "--", rel]).split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1));
  return diff.length > 0 || status !== "A" ? diff : readFileSync(join(dir, rel), "utf8").split("\n");
}

function prepareBase({ dir, base, changes, config }) {
  const baseDir = mkdtempSync(join(tmpdir(), "slopgate-base-"));
  git(dir, ["worktree", "add", "--detach", baseDir, base]);
  if (existsSync(join(dir, "node_modules"))) symlinkSync(join(dir, "node_modules"), join(baseDir, "node_modules"));
  const overlay = config.overlay ?? ["proof/**"];
  for (const { rel, status } of changes) {
    if (status === "D" || !(TEST_FILE.test(rel) || overlay.some((pattern) => matchesGlob(rel, pattern)))) continue;
    mkdirSync(dirname(join(baseDir, rel)), { recursive: true });
    cpSync(join(dir, rel), join(baseDir, rel));
  }
  return baseDir;
}

const missing = (reason) => ({ ok: false, reason });

const collectors = {
  visual(ctx, { medium }) {
    if (!ctx.config.capture) return missing("No `proof.capture` command is configured in .claude/slopgate.json.");
    const sides = {};
    for (const [side, cwd] of [["before", ctx.baseDir()], ["after", ctx.dir]]) {
      const outDir = join(ctx.out, "visual", side);
      mkdirSync(outDir, { recursive: true });
      const { code, tail } = run(ctx.config.capture, cwd, { SLOPGATE_PROOF_OUT: outDir });
      sides[side] = { code, tail, files: readdirSync(outDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map(({ name }) => name).sort() };
    }
    const changedUi = ctx.changes.filter(({ rel, status }) => status !== "D" && ctx.layerOf(rel) === "ui").map(({ rel }) => rel);
    sides.pages = pagesShowing(changedUi, ctx.edges, ctx.config.pages, ctx.previewUrl ?? ctx.config.previewUrl);
    const wanted = medium.includes("video") ? ".webm" : ".png";
    if (sides.after.code !== 0) return { ...missing(`The capture command failed on this change: ${sides.after.tail}`), data: sides };
    if (!sides.after.files.some((file) => file.endsWith(wanted))) return { ...missing(`The capture command produced no ${wanted} file.`), data: sides };
    return { ok: true, data: sides };
  },

  integration(ctx) {
    const live = ctx.changes.filter(({ status }) => status !== "D").map(({ rel }) => rel);
    const api = live.filter((rel) => ctx.layerOf(rel) === "api" && isCode(rel));
    const ui = live.filter((rel) => ctx.layerOf(rel) === "ui");
    const edges = ctx.edges.filter(({ from, to, kind }) => api.includes(to) || (api.includes(from) && kind === "import") || (ui.includes(from) && kind === "http"));
    const orphans = api.filter((rel) => !edges.some(({ to }) => to === rel));
    const ids = [...new Set(edges.flatMap(({ from, to }) => [from, to]))];
    const nodes = ids.map((id) => ({ id, layer: ctx.layerOf(id), state: ctx.stateOf(id) }));
    const drawn = edges.map((edge) => ({ ...edge, state: ctx.stateOf(edge.from) === "new" || ctx.stateOf(edge.to) === "new" ? "added" : "kept" }));
    if (edges.length === 0) return missing("No request or import reaches the changed API files.");
    return { ok: orphans.length === 0, reason: orphans.length > 0 ? `Nothing in the repository calls ${orphans.join(", ")}.` : "", data: { nodes, edges: drawn, orphans } };
  },

  structure(ctx) {
    const baseFiles = new Set(git(ctx.dir, ["ls-tree", "-r", "--name-only", ctx.base]).split("\n"));
    const headFiles = new Set(ctx.texts.keys());
    const changed = ctx.changes.filter(({ rel }) => isCode(rel) && !TEST_FILE.test(rel));
    const key = ({ from, to }) => `${from}\n${to}`;
    const edges = changed.flatMap(({ rel, status }) => {
      const imports = (text, fileSet) => (text ? moduleEdges(ctx.ts, rel, text, fileSet, ctx.aliases).filter(({ kind }) => kind === "import") : []);
      const before = status === "A" ? [] : imports(textAt(ctx.dir, ctx.base, rel), baseFiles);
      const after = status === "D" ? [] : imports(ctx.texts.get(rel), headFiles);
      const [beforeKeys, afterKeys] = [before, after].map((list) => new Set(list.map(key)));
      return [...after.map((edge) => ({ ...edge, state: beforeKeys.has(key(edge)) ? "kept" : "added" })), ...before.filter((edge) => !afterKeys.has(key(edge))).map((edge) => ({ ...edge, state: "removed" }))];
    });
    const changedSet = new Set(changed.map(({ rel }) => rel));
    const shown = edges.filter(({ from, to, state }) => state !== "kept" || (changedSet.has(from) && changedSet.has(to)));
    const ids = [...new Set([...changedSet, ...shown.flatMap(({ from, to }) => [from, to])])];
    const count = (state) => changed.filter(({ status }) => status === state).length;
    const summary = { modulesAdded: count("A"), modulesRemoved: count("D"), edgesAdded: edges.filter(({ state }) => state === "added").length, edgesRemoved: edges.filter(({ state }) => state === "removed").length };
    return { ok: true, data: { nodes: ids.map((id) => ({ id, layer: ctx.layerOf(id), state: ctx.stateOf(id) })), edges: shown, summary } };
  },

  measurement(ctx) {
    if (!ctx.config.bench) return missing("No `proof.bench` command is configured in .claude/slopgate.json.");
    const measure = (cwd) => {
      const { stdout, tail } = run(ctx.config.bench, cwd);
      try {
        return JSON.parse(stdout.trim().split("\n").at(-1));
      } catch {
        return { samples: [], error: tail };
      }
    };
    const [base, head] = [measure(ctx.baseDir()), measure(ctx.dir)];
    if (base.samples.length === 0 || head.samples.length === 0) return missing(`The bench command printed no samples: ${base.error ?? head.error}`);
    const { verdict, change } = measurementVerdict(base.samples, head.samples, head.higherIsBetter);
    const data = { metric: head.metric, unit: head.unit, base: base.samples, head: head.samples, verdict, change };
    return { ok: verdict === "improved", reason: verdict === "improved" ? "" : `The measurement shows ${verdict}.`, data };
  },

  regression(ctx) {
    const tests = ctx.changes.filter(({ rel, status }) => status !== "D" && TEST_FILE.test(rel)).map(({ rel }) => rel);
    if (tests.length === 0) return missing("The change adds or modifies no test.");
    if (!ctx.config.test) return missing("No `proof.test` command is configured in .claude/slopgate.json.");
    const rows = tests.map((file) => ({ file, base: run(ctx.config.test.replace("{file}", file), ctx.baseDir()).code, head: run(ctx.config.test.replace("{file}", file), ctx.dir).code }));
    const stillFailing = rows.filter(({ head }) => head !== 0);
    if (stillFailing.length > 0) return { ...missing(`Failing on this change: ${stillFailing.map(({ file }) => file).join(", ")}`), data: { rows } };
    if (!rows.some(({ base }) => base !== 0)) return { ...missing("Every test also passes without the change, so none of them proves it."), data: { rows } };
    return { ok: true, data: { rows } };
  },

  schema(ctx) {
    const rows = ctx.changes.filter(({ rel, status }) => status !== "D" && ctx.layerOf(rel) === "db").flatMap(({ rel }) =>
      readFileSync(join(ctx.dir, rel), "utf8").split("\n").map((line) => MIGRATION_STATEMENT.exec(line)).filter(Boolean).map((match) => ({ file: rel, statement: match[1].trim() })),
    );
    return rows.length > 0 ? { ok: true, data: { rows } } : missing("No create, alter or drop statement found in the changed migrations.");
  },

  dependencies(ctx) {
    const names = (text) => {
      const manifest = text ? JSON.parse(text) : {};
      return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}));
    };
    const [before, after] = [names(textAt(ctx.dir, ctx.base, "package.json")), names(readFileSync(join(ctx.dir, "package.json"), "utf8"))];
    return { ok: true, data: { added: after.filter((name) => !before.includes(name)), removed: before.filter((name) => !after.includes(name)) } };
  },

  review(ctx) {
    const data = reviewChange({ dir: ctx.dir, base: ctx.base });
    if (!data.ran) return { ok: true, skipped: true, reason: data.failures.join("; "), data };
    return { ok: data.verdict === "pass", reason: data.verdict === "pass" ? "" : "The reviewer found a blocking problem.", data };
  },

  gates(ctx) {
    const commands = { "slopgate check": `node "${gatePath}" check --base ${ctx.base}`, ...(ctx.config.gates ?? {}) };
    const rows = Object.entries(commands).map(([name, command]) => {
      const { code, tail } = run(command, ctx.dir);
      return { name, code, output: tail };
    });
    const failed = rows.filter(({ code }) => code !== 0);
    return { ok: failed.length === 0, reason: failed.length > 0 ? `Failing: ${failed.map(({ name }) => name).join(", ")}` : "", data: { rows } };
  },
};

function stored(out) {
  try {
    return JSON.parse(readFileSync(join(out, "proof.json"), "utf8"));
  } catch {
    return null;
  }
}

export function buildProof({ dir, base, title, out, previewUrl, force = false }) {
  const config = readConfig(dir).proof ?? {};
  const layers = { ...DEFAULT_LAYERS, ...config.layers };
  const { type, subject } = parseTitle(title);
  const changes = readChanges(dir, base).filter(({ rel }) => unignored(dir)(rel));
  const baseSha = git(dir, ["rev-parse", base]).trim();
  const state = fingerprint({ base: baseSha, title, previewUrl, files: changes.map(({ rel, status }) => ({ rel, status, text: status === "D" ? "" : readFileSync(join(dir, rel), "utf8") })) });
  const previous = force ? null : stored(out);
  if (previous?.fingerprint === state) return { ...previous, reused: true };
  const statusOf = new Map(changes.map(({ rel, status }) => [rel, status]));
  const added = new Map(changes.map((change) => [change.rel, addedLines(dir, base, change)]));
  const layerOf = (rel) => layerOfFile(rel, layers);
  const touched = new Set(changes.map(({ rel }) => layerOf(rel)));
  const signals = {
    layers: touched,
    interaction: changes.some(({ rel }) => layerOf(rel) === "ui" && added.get(rel).some((line) => INTERACTION.test(line))),
    review: readConfig(dir).review !== false,
    dependencies: statusOf.has("package.json") && Object.values(collectors.dependencies({ dir, base }).data).flat().length > 0,
  };

  const ts = loadTypeScript(dir);
  const files = git(dir, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(unignored(dir)).filter((rel) => isCode(rel) && existsSync(join(dir, rel)));
  const texts = new Map(files.map((rel) => [rel, readFileSync(join(dir, rel), "utf8")]));
  const aliases = existsSync(join(dir, "tsconfig.json")) ? pathAliases(ts, readFileSync(join(dir, "tsconfig.json"), "utf8")) : [];
  const edges = buildGraph(ts, texts, aliases);

  let baseDir = null;
  const ctx = {
    dir, base, config, out, previewUrl, changes, ts, texts, aliases, edges, layerOf,
    stateOf: (rel) => ({ A: "new", D: "deleted", M: "changed" })[statusOf.get(rel)] ?? "unchanged",
    baseDir: () => (baseDir ??= prepareBase({ dir, base, changes, config })),
  };

  mkdirSync(out, { recursive: true });
  const proofs = {};
  let required;
  try {
    required = requiredProofs(type, signals).map((requirement) => {
      const { ok, reason = "", data, skipped = false } = collectors[requirement.id](ctx, requirement);
      if (data) proofs[requirement.id] = data;
      return { ...requirement, ok, reason, skipped };
    });
  } finally {
    if (baseDir) {
      git(dir, ["worktree", "remove", "--force", baseDir]);
      rmSync(baseDir, { recursive: true, force: true });
    }
  }

  const overlay = config.overlay ?? ["proof/**"];
  const slice = changes.filter(({ rel, status }) => status !== "D" && isCode(rel) && !overlay.some((pattern) => matchesGlob(rel, pattern))).map(({ rel }) => rel);
  const addedCodeLines = changes.filter(({ rel }) => isCode(rel) && !TEST_FILE.test(rel)).reduce((sum, { rel }) => sum + added.get(rel).length, 0);
  const scope = scopeChecks({ type, changes, layers: touched, addedCodeLines, groups: connectedGroups(slice, edges) });
  const dirty = git(dir, ["status", "--porcelain"]).trim() !== "";
  const verdict = required.every(({ ok }) => ok) && scope.every(({ pass }) => pass);
  const sensitive = config.sensitive ?? DEFAULT_SENSITIVE;
  const review = reviewTier({
    type, layers: touched, dependencies: signals.dependencies, complete: verdict,
    changedApi: changes.filter(({ rel, status }) => status !== "A" && layerOf(rel) === "api").map(({ rel }) => rel),
    sensitive: changes.filter(({ rel }) => sensitive.some((pattern) => matchesGlob(rel, pattern))).map(({ rel }) => rel),
    findings: proofs.review?.findings?.length ?? 0,
  });
  const manifest = {
    title: subject, type, fingerprint: state,
    tier: review.tier, tierReasons: review.reasons,
    base: git(dir, ["rev-parse", "--short", base]).trim(),
    head: `${git(dir, ["rev-parse", "--short", "HEAD"]).trim()}${dirty ? " + uncommitted" : ""}`,
    generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
    stats: { files: changes.length, addedLines: [...added.values()].reduce((sum, lines) => sum + lines.length, 0) },
    required, scope, proofs, verdict,
  };
  writeFileSync(join(out, "proof.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, "index.html"), renderPage(manifest));
  return manifest;
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const dir = process.cwd();
  const base = option("--base");
  if (!base) {
    process.stderr.write("usage: proof.mjs --base <ref> [--title <conventional title>] [--preview-url <url>] [--out <dir>] [--force]\n");
    process.exit(64);
  }
  const title = option("--title", git(dir, ["log", "-1", "--format=%s"]).trim());
  const out = resolve(option("--out", join(tmpdir(), "slopgate-proof", basename(dir))));
  const { required, scope, verdict, tier, tierReasons, reused = false } = buildProof({ dir, base, title, out, previewUrl: option("--preview-url"), force: args.includes("--force") });
  const lines = [...required.map(({ id, medium, ok, reason, skipped }) => `${skipped ? "NOT RUN" : ok ? "ok     " : "MISSING"} ${id}: ${medium}${ok && !skipped ? "" : ` (${reason})`}`), ...scope.filter(({ pass }) => !pass).map(({ rule, detail }) => `SCOPE   ${rule}: ${detail}`)];
  if (reused) lines.push("REUSED  nothing changed since this proof was built; pass --force to rebuild");
  lines.push(`TIER    ${tier}${tierReasons.length > 0 ? `: ${tierReasons.join(" ")}` : ""}`);
  process.stdout.write(`${lines.join("\n")}\n${verdict ? "PROOF COMPLETE" : "PROOF INCOMPLETE"}: ${join(out, "index.html")}\n`);
  process.exit(verdict ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
