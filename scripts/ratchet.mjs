#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function countByRuleAndFile(eslintResults, rootDir) {
  const counts = {};
  for (const { filePath, messages } of eslintResults) {
    for (const { ruleId } of messages) {
      const rule = ruleId ?? "parse-error";
      const file = relative(rootDir, filePath);
      counts[rule] ??= {};
      counts[rule][file] = (counts[rule][file] ?? 0) + 1;
    }
  }
  return counts;
}

export function increases(baseline, current) {
  return Object.entries(current).flatMap(([rule, files]) =>
    Object.entries(files)
      .filter(([file, count]) => count > (baseline[rule]?.[file] ?? 0))
      .map(([file, count]) => ({ rule, file, was: baseline[rule]?.[file] ?? 0, now: count })),
  );
}

const total = (counts) => Object.values(counts).reduce((sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0), 0);

function sorted(counts) {
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((rule) => [rule, Object.fromEntries(Object.entries(counts[rule]).sort(([a], [b]) => a.localeCompare(b)))]),
  );
}

function main() {
  const [resultsPath, ...flags] = process.argv.slice(2);
  const baselinePath = resolve(flags[flags.indexOf("--baseline") + 1] ?? ".claude/lint-baseline.json");
  if (!resultsPath || !flags.includes("--baseline")) {
    process.stderr.write("usage: ratchet.mjs <eslint-results.json> --baseline <path> [--update]\n");
    process.exit(64);
  }
  const current = countByRuleAndFile(JSON.parse(readFileSync(resultsPath, "utf8")), process.cwd());
  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, `${JSON.stringify(sorted(current), null, 2)}\n`);
    process.stdout.write(`baseline created with ${total(current)} violations\n`);
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const risen = increases(baseline, current);
  if (risen.length > 0) {
    process.stderr.write(`${risen.map(({ rule, file, was, now }) => `${file}: ${rule} ${was} -> ${now}`).join("\n")}\n${risen.length} count(s) rose above the baseline. Fix the new violations; the baseline only shrinks.\n`);
    process.exit(1);
  }
  if (flags.includes("--update")) writeFileSync(baselinePath, `${JSON.stringify(sorted(current), null, 2)}\n`);
  process.stdout.write(`lint ratchet holds: ${total(current)} violations, baseline ${total(baseline)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
