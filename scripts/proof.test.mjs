import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_KINDS, loadTypeScript } from "./gate.mjs";
import { buildGraph, connectedGroups, layerOf, pathAliases, resolveRoute } from "./graph.mjs";
import { fingerprint, layerOfFile, measurementVerdict, parseTitle, requiredProofs, reviewTier, scopeChecks } from "./proof.mjs";
import { countByRuleAndFile, increases } from "./ratchet.mjs";

const ts = loadTypeScript(process.cwd());
const layers = { api: ["**/app/api/**"], db: ["supabase/migrations/**"], ui: ["src/app/**/*.tsx", "src/components/**"] };
const ids = (type, signals) => requiredProofs(type, { layers: new Set(signals.layers), interaction: Boolean(signals.interaction), dependencies: false }).map(({ id, medium }) => `${id}:${medium}`);

test("files map to one layer", () => {
  assert.equal(layerOfFile("src/app/api/refresh/route.ts", layers), "api");
  assert.equal(layerOfFile("src/components/button.tsx", layers), "ui");
  assert.equal(layerOfFile("src/components/button.test.tsx", layers), "test");
  assert.equal(layerOfFile("supabase/migrations/1_init.sql", layers), "db");
  assert.equal(layerOfFile("src/lib/store.ts", layers), "lib");
  assert.equal(layerOfFile("README.md", layers), "other");
  assert.ok(".ts" in CODE_KINDS);
});

test("the title declares the type", () => {
  assert.deepEqual(parseTitle("feat(pipeline): add a refresh button"), { type: "feat", subject: "add a refresh button" });
  assert.equal(parseTitle("Add a refresh button").type, null);
  assert.equal(parseTitle("wip: stuff").type, null);
});

test("the medium follows from the type and the layers touched", () => {
  assert.deepEqual(ids("feat", { layers: ["ui", "api"], interaction: true }), ["visual:before and after video", "integration:layered call graph", "regression:red-to-green test table", "gates:pass or fail table"]);
  assert.deepEqual(ids("feat", { layers: ["ui"] })[0], "visual:before and after screenshots");
  assert.deepEqual(ids("perf", { layers: ["lib"] }), ["measurement:plot of repeated runs, base against change", "gates:pass or fail table"]);
  assert.deepEqual(ids("refactor", { layers: ["lib"] }), ["structure:module dependency graph diff", "gates:pass or fail table"]);
  assert.deepEqual(ids("fix", { layers: ["db", "api"] }).slice(0, 3), ["integration:layered call graph", "schema:table of migration statements", "regression:red-to-green test table"]);
});

test("scope rules", () => {
  const check = (overrides) => scopeChecks({ type: "feat", changes: [], layers: new Set(), addedCodeLines: 10, groups: [["a.ts"]], ...overrides }).filter(({ pass }) => !pass).map(({ rule }) => rule);
  assert.deepEqual(check({}), []);
  assert.equal(check({ type: null }).length, 1);
  assert.match(check({ groups: [["a.ts"], ["b.ts"]] })[0], /one connected slice/);
  assert.match(check({ addedCodeLines: 601 })[0], /at most 600/);
  assert.match(check({ type: "refactor", changes: [{ rel: "a.test.ts", status: "M" }] })[0], /refactor leaves existing tests/);
  assert.deepEqual(check({ type: "refactor", changes: [{ rel: "a.test.ts", status: "A" }] }), []);
});

test("a measurement improves only when the middle halves do not overlap", () => {
  assert.equal(measurementVerdict([20, 21, 22, 23], [1, 2, 2, 3]).verdict, "improved");
  assert.equal(measurementVerdict([20, 21, 22, 23], [19, 21, 22, 24]).verdict, "no measurable change");
  assert.equal(measurementVerdict([1, 2, 2, 3], [20, 21, 22, 23]).verdict, "regressed");
  assert.equal(measurementVerdict([10, 11, 12, 13], [20, 21, 22, 23], true).verdict, "improved");
});

test("requests resolve to route files and link the layers", () => {
  const texts = new Map([
    ["src/components/refresh.tsx", 'import { fmt } from "@/lib/fmt"; export const go = (id: string) => fetch(`/api/jobs/${id}/refresh`, { method: "post" });'],
    ["src/app/(app)/api/jobs/[id]/refresh/route.ts", 'import { store } from "../../../../../../lib/store"; export const POST = () => store;'],
    ["src/lib/store.ts", "export const store = 1;"],
    ["src/lib/fmt.ts", "export const fmt = 1;"],
    ["src/lib/unrelated.ts", "export const other = 2;"],
  ]);
  const aliases = pathAliases(ts, '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');
  const edges = buildGraph(ts, texts, aliases);
  assert.deepEqual(edges.map(({ from, to, label }) => [from.split("/").at(-1), to.split("/").at(-1), label ?? "import"]), [
    ["refresh.tsx", "fmt.ts", "import"],
    ["refresh.tsx", "route.ts", "POST /api/jobs/:param/refresh"],
    ["route.ts", "store.ts", "import"],
  ]);
  assert.equal(resolveRoute("/api/missing", new Set(texts.keys())), null);
  assert.equal(connectedGroups([...texts.keys()], edges).length, 2);
  assert.equal(layerOf(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }]).get("c"), 2);
});

test("the lint ratchet reports only counts that rose", () => {
  const results = [{ filePath: `${process.cwd()}/src/a.ts`, messages: [{ ruleId: "x" }, { ruleId: "x" }, { ruleId: "y" }] }];
  const current = countByRuleAndFile(results, process.cwd());
  assert.deepEqual(current, { x: { "src/a.ts": 2 }, y: { "src/a.ts": 1 } });
  assert.deepEqual(increases({ x: { "src/a.ts": 2 }, y: { "src/a.ts": 3 } }, current), []);
  assert.deepEqual(increases({ x: { "src/a.ts": 1 } }, current), [{ rule: "x", file: "src/a.ts", was: 1, now: 2 }, { rule: "y", file: "src/a.ts", was: 0, now: 1 }]);
});

test("changed interface files map to the pages that show them", async () => {
  const { pagesShowing, routeOf } = await import("./proof.mjs");
  assert.equal(routeOf("src/app/(app)/pipeline/page.tsx"), "/pipeline");
  assert.equal(routeOf("src/app/page.tsx"), "/");
  assert.equal(routeOf("src/components/button.tsx"), null);
  const edges = [
    { from: "src/app/(app)/pipeline/page.tsx", to: "src/components/outbox.tsx", kind: "import" },
    { from: "src/components/outbox.tsx", to: "src/components/button.tsx", kind: "import" },
    { from: "src/app/jobs/[id]/page.tsx", to: "src/components/button.tsx", kind: "import" },
  ];
  assert.deepEqual(pagesShowing(["src/components/button.tsx"], edges, {}, "https://preview.example/"), [
    { file: "src/app/(app)/pipeline/page.tsx", route: "/pipeline", url: "https://preview.example/pipeline" },
    { file: "src/app/jobs/[id]/page.tsx", route: "/jobs/[id]", url: null },
  ]);
});

test("graph nodes show whole names and the drawing is as wide as its content", async () => {
  const { graphSvg, funnelSvg } = await import("./render.mjs");
  const svg = graphSvg({ label: "x", nodes: [{ id: "src/components/a-very-long-component-name-for-refresh.tsx", state: "new" }, { id: "src/app/api/opportunities/refresh/route.ts", state: "new" }], edges: [{ from: "src/components/a-very-long-component-name-for-refresh.tsx", to: "src/app/api/opportunities/refresh/route.ts", label: "POST /api/opportunities/refresh", state: "added" }] });
  assert.ok(svg.includes(">components/a-very-long-component-name-for-refresh.tsx<"));
  assert.ok(!svg.includes("…"));
  const funnel = funnelSvg({ stages: [{ name: "Sent", entered: 100, wentOn: 30, left: 10 }, { name: "Replied", entered: 30 }] });
  assert.ok(funnel.includes("30% went on") && funnel.includes("60% still here") && funnel.includes("last step"));
});

test("the second provider is preferred, optional, and falls back", async () => {
  const { ask, parseReview, providerOrder } = await import("./second.mjs");
  assert.deepEqual(providerOrder({}), ["codex", "claude"]);
  assert.deepEqual(providerOrder({ secondProvider: { enabled: false } }), ["claude"]);
  assert.deepEqual(providerOrder({ secondProvider: { name: "gemini" } }), ["gemini", "claude"]);

  const provider = (available, ok) => ({ available: () => available, run: () => ({ ok, output: ok ? "answer" : "", error: "usage limit reached" }) });
  const order = ["codex", "claude"];
  assert.equal(ask(order, { codex: provider(true, true), claude: provider(true, true) }, "x", {}).provider, "codex");
  assert.deepEqual(ask(order, { codex: provider(true, false), claude: provider(true, true) }, "x", {}), { provider: "claude", output: "answer", failures: ["codex failed: usage limit reached"] });
  assert.deepEqual(ask(order, { codex: provider(false, true), claude: provider(true, true) }, "x", {}).failures, ["codex is not installed"]);
  assert.equal(ask(order, { codex: provider(false, true), claude: provider(true, false) }, "x", {}).provider, null);

  assert.deepEqual(parseReview('Here it is: {"findings": [], "verdict": "pass"}'), { findings: [], verdict: "pass" });
  assert.equal(parseReview("I could not review this."), null);
  assert.equal(parseReview('{"findings": [], "verdict": "maybe"}'), null);
});

const reviewInput = {
  type: "chore",
  layers: new Set(["ui", "api", "lib", "test", "other"]),
  dependencies: false,
  changedApi: [],
  sensitive: [],
  findings: 0,
  complete: true,
};

test("only chores, docs, and tests without findings qualify for digest only", () => {
  for (const type of ["chore", "docs", "test"]) {
    assert.deepEqual(reviewTier({ ...reviewInput, type }), { tier: "digest only", reasons: [] }, type);
    assert.deepEqual(reviewTier({ ...reviewInput, type, findings: 1 }), { tier: "view", reasons: [] }, type);
  }
  for (const type of ["feat", "fix", "perf", "refactor", null]) {
    assert.deepEqual(reviewTier({ ...reviewInput, type }), { tier: "view", reasons: [] }, String(type));
  }
});

const reviewTriggers = [
  ["database layer", { layers: new Set(["lib", "db"]) }, []],
  ["dependency changes", { dependencies: true }, []],
  ["existing API files changed", { changedApi: ["src/app/api/jobs/route.ts", "src/app/api/users/route.ts"] }, ["src/app/api/jobs/route.ts", "src/app/api/users/route.ts"]],
  ["sensitive paths changed", { sensitive: ["src/auth/session.ts", "config/permissions.json"] }, ["src/auth/session.ts", "config/permissions.json"]],
  ["incomplete proof", { complete: false }, []],
];

for (const [trigger, overrides, paths] of reviewTriggers) {
  test(`must review for ${trigger}`, () => {
    const { tier, reasons } = reviewTier({ ...reviewInput, ...overrides });
    assert.equal(tier, "must review");
    assert.ok(Array.isArray(reasons));
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /\S/);
    for (const path of paths) {
      assert.ok(reasons[0].includes(path), `reason should name ${path}`);
    }
  });
}

test("simultaneous review triggers each contribute one reason", () => {
  const overrides = Object.assign({}, ...reviewTriggers.map(([, input]) => input));
  const { tier, reasons } = reviewTier({ ...reviewInput, ...overrides });
  assert.equal(tier, "must review");
  assert.ok(Array.isArray(reasons));
  assert.equal(reasons.length, reviewTriggers.length);
  for (const reason of reasons) assert.match(reason, /\S/);
  for (const [, , paths] of reviewTriggers.filter(([, , paths]) => paths.length)) {
    assert.ok(reasons.some((reason) => paths.every((path) => reason.includes(path))));
  }
});

const fingerprintInput = {
  base: "abc123",
  title: "fix: refresh jobs",
  previewUrl: "https://preview.example/jobs",
  files: [
    { rel: "src/app/api/jobs/route.ts", status: "M", text: "export const GET = listJobs;" },
    { rel: "src/lib/jobs.ts", status: "A", text: "export const listJobs = () => [];" },
  ],
};

test("fingerprints are strings and stable across calls and file order", () => {
  const original = fingerprint(fingerprintInput);
  assert.equal(typeof original, "string");
  assert.equal(fingerprint(structuredClone(fingerprintInput)), original);
  assert.equal(fingerprint({ ...fingerprintInput, files: [...fingerprintInput.files].reverse() }), original);
});

for (const [field, value] of Object.entries({
  base: "def456",
  title: "fix: list jobs",
  previewUrl: "https://preview.example/queue",
})) {
  test(`fingerprint changes when ${field} changes`, () => {
    assert.notEqual(fingerprint({ ...fingerprintInput, [field]: value }), fingerprint(fingerprintInput));
  });
}

for (const [field, value] of Object.entries({
  rel: "src/lib/queue.ts",
  status: "D",
  text: "export const listJobs = () => loadJobs();",
})) {
  test(`fingerprint changes when any file's ${field} changes`, () => {
    for (const index of fingerprintInput.files.keys()) {
      const files = fingerprintInput.files.map((file, position) => (
        position === index ? { ...file, [field]: value } : file
      ));
      assert.notEqual(fingerprint({ ...fingerprintInput, files }), fingerprint(fingerprintInput), `file ${index + 1}`);
    }
  });
}
