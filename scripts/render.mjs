import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layerOf } from "./graph.mjs";

const NODE = { minWidth: 170, height: 46, gapX: 90, gapY: 16, pad: 14, lane: 36 };
const FUNNEL = { width: 900, nameColumn: 120, countColumn: 64, row: 38, top: 26, bar: 26 };
const PLOT = { width: 720, gutter: 96, right: 24, row: 64, top: 8, axis: 46 };
const SECTION_TITLES = {
  visual: "What the user sees",
  integration: "How the layers connect",
  structure: "How the module structure changed",
  measurement: "What was measured",
  regression: "Tests that fail without the change",
  schema: "What changes in the database",
  dependencies: "Dependencies",
  gates: "Automatic gates",
  review: "Independent review",
};

const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const round = (value) => (Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2));
const humanize = (file) => file.replace(/^\d+-/, "").replace(/\.\w+$/, "").replace(/-/g, " ");
const status = (ok, yes, no) => `<span class="status ${ok ? "good" : "bad"}"><span aria-hidden="true">${ok ? "✓" : "✕"}</span> ${esc(ok ? yes : no)}</span>`;

export function quantile(samples, q) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (position - low);
}

function niceMax(max) {
  const raw = max / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw);
  return { step, top: Math.ceil((max * 1.02) / step) * step };
}

export function graphSvg({ nodes, edges, label }) {
  const depth = layerOf(nodes.map(({ id }) => id), edges);
  const columns = [];
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) (columns[depth.get(node.id)] ??= []).push(node);
  const text = new Map(nodes.map(({ id, layer }) => {
    const segments = id.split("/");
    return [id, { name: segments.slice(-2).join("/"), where: segments.slice(0, -2).join("/") || layer || "" }];
  }));
  const nodeWidth = Math.max(NODE.minWidth, ...nodes.map(({ id }) => Math.max(text.get(id).name.length * 7.6, text.get(id).where.length * 6 + 72) + 22));
  const gaps = columns.slice(1).map((_, c) => Math.max(NODE.gapX, ...edges.filter(({ from, label: caption }) => caption && depth.get(from) === c).map(({ label: caption }) => caption.length * 7 + 40)));
  const columnX = columns.map((_, c) => NODE.pad + c * nodeWidth + gaps.slice(0, c).reduce((sum, gap) => sum + gap, 0));
  const tallest = Math.max(...columns.map((column) => column.length));
  const lane = edges.some(({ from, to }) => depth.get(to) - depth.get(from) > 1) ? NODE.lane : 0;
  const width = columnX.at(-1) + nodeWidth + NODE.pad;
  const height = lane + NODE.pad * 2 + tallest * (NODE.height + NODE.gapY) - NODE.gapY;
  const at = new Map();
  columns.forEach((column, c) => {
    const offset = lane + (height - lane - (column.length * (NODE.height + NODE.gapY) - NODE.gapY)) / 2;
    column.forEach((node, r) => at.set(node.id, { x: columnX[c], y: offset + r * (NODE.height + NODE.gapY) }));
  });

  const drawnEdges = edges
    .map(({ from, to, state = "kept", label: caption }) => {
      const a = at.get(from);
      const b = at.get(to);
      const x1 = a.x + nodeWidth;
      const y1 = a.y + NODE.height / 2;
      const x2 = b.x - 7;
      const y2 = b.y + NODE.height / 2;
      const bend = Math.max(40, (x2 - x1) / 2);
      const skips = depth.get(to) - depth.get(from) > 1;
      const curve = skips ? `M${a.x + nodeWidth / 2},${a.y} C${a.x + nodeWidth / 2},8 ${b.x + nodeWidth / 2},8 ${b.x + nodeWidth / 2},${b.y - 7}` : `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
      const path = `<path class="edge e-${state}" d="${curve}" marker-end="url(#arrow-${state})" fill="none"/>`;
      return path + (caption ? `<text class="edge-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 7}" text-anchor="middle">${esc(caption)}</text>` : "");
    })
    .join("");

  const drawnNodes = nodes
    .map(({ id, state }) => {
      const { x, y } = at.get(id);
      const { name, where } = text.get(id);
      const tag = state === "unchanged" ? "" : `<text class="node-tag" x="${x + nodeWidth - 10}" y="${y + 34}" text-anchor="end">${esc(state)}</text>`;
      return `<g class="node n-${state}"><title>${esc(id)}</title><rect x="${x}" y="${y}" width="${nodeWidth}" height="${NODE.height}" rx="6"/><text class="node-name" x="${x + 10}" y="${y + 19}">${esc(name)}</text><text class="node-where" x="${x + 10}" y="${y + 34}">${esc(where)}</text>${tag}</g>`;
    })
    .join("");

  const markers = ["kept", "added", "removed"].map((state) => `<marker id="arrow-${state}" class="m-${state}" viewBox="0 0 8 8" refX="1" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker>`).join("");
  return `<svg class="graph" viewBox="0 0 ${width} ${height}" style="max-width:${width}px" role="img" aria-label="${esc(label)}"><defs>${markers}</defs>${drawnEdges}${drawnNodes}</svg>`;
}

export function funnelSvg({ stages }) {
  const { width, nameColumn, countColumn, row, top, bar } = FUNNEL;
  const barX = nameColumn + countColumn + 18;
  const barWidth = width - barX - 8;
  const height = top + stages.length * row;
  const head = `<text class="tick" x="${nameColumn}" y="14" text-anchor="end">Step</text><text class="tick" x="${nameColumn + countColumn}" y="14" text-anchor="end">Entered</text><text class="tick" x="${barX}" y="14">Share of those who entered the step</text>`;
  const rows = stages
    .map(({ name, entered, wentOn = 0, left = 0 }, i) => {
      const y = top + i * row;
      const labels = `<text class="row-label" x="${nameColumn}" y="${y + bar / 2 + 4}" text-anchor="end">${esc(name)}</text><text class="value count" x="${nameColumn + countColumn}" y="${y + bar / 2 + 4}" text-anchor="end">${entered}</text>`;
      if (i === stages.length - 1) return `${labels}<text class="tick" x="${barX}" y="${y + bar / 2 + 4}">last step</text>`;
      const parts = [["on", "went on", wentOn], ["still", "still here", entered - wentOn - left], ["left", "left", left]].filter(([, , count]) => count > 0);
      let x = barX;
      const segments = parts
        .map(([key, word, count]) => {
          const share = count / entered;
          const w = Math.max(share * barWidth - 2, 1);
          const caption = `${Math.round(share * 100)}% ${word}`;
          const inside = w > caption.length * 6.4 + 10;
          const drawn = `<rect class="f-${key}" x="${x}" y="${y}" width="${w}" height="${bar}" rx="3"><title>${esc(name)}: ${count} of ${entered} ${word} (${(share * 100).toFixed(1)}%)</title></rect>${inside ? `<text class="f-text f-text-${key}" x="${x + 7}" y="${y + bar / 2 + 4}">${caption}</text>` : ""}`;
          x += share * barWidth;
          return drawn;
        })
        .join("");
      return labels + segments;
    })
    .join("");
  return `<svg class="funnel" viewBox="0 0 ${width} ${height}" style="max-width:${width}px" role="img" aria-label="Share of people who went on, are still at the step, or left, for each step">${head}${rows}</svg>`;
}

export function measurementSvg({ metric, unit, base, head }) {
  const rows = [
    { name: "base", series: "s-base", samples: base },
    { name: "this change", series: "s-head", samples: head },
  ];
  const { step, top } = niceMax(Math.max(...base, ...head));
  const plotWidth = PLOT.width - PLOT.gutter - PLOT.right;
  const x = (value) => PLOT.gutter + (value / top) * plotWidth;
  const height = PLOT.top + rows.length * PLOT.row + PLOT.axis;
  const single = base.length === 1 && head.length === 1;

  const ticks = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    ticks.push(`<line class="grid" x1="${x(value)}" x2="${x(value)}" y1="${PLOT.top}" y2="${height - PLOT.axis}"/><text class="tick" x="${x(value)}" y="${height - PLOT.axis + 16}" text-anchor="middle">${Number(value.toPrecision(6))}</text>`);
  }

  const marks = rows
    .map(({ name, series, samples }, r) => {
      const mid = PLOT.top + r * PLOT.row + PLOT.row / 2 + 8;
      const median = quantile(samples, 0.5);
      const rowLabel = `<text class="row-label" x="${PLOT.gutter - 12}" y="${mid + 4}" text-anchor="end">${esc(name)}</text>`;
      if (single) {
        return `${rowLabel}<rect class="${series}" x="${PLOT.gutter}" y="${mid - 9}" width="${x(median) - PLOT.gutter}" height="18" rx="4"><title>${esc(name)}: ${round(median)} ${esc(unit)}</title></rect><text class="value" x="${x(median) + 8}" y="${mid + 4}">${round(median)} ${esc(unit)}</text>`;
      }
      const dots = samples.map((value, i) => `<circle class="${series}" cx="${x(value)}" cy="${mid + (((i * 37) % 21) - 10)}" r="5"><title>${esc(name)} run ${i + 1}: ${round(value)} ${esc(unit)}</title></circle>`).join("");
      const anchor = x(median) > PLOT.width - 110 ? "end" : "start";
      const medianMark = `<line class="median" x1="${x(median)}" x2="${x(median)}" y1="${mid - 20}" y2="${mid + 16}"/><text class="value" x="${x(median) + (anchor === "end" ? -6 : 6)}" y="${mid - 22}" text-anchor="${anchor}">median ${round(median)} ${esc(unit)}</text>`;
      return rowLabel + dots + medianMark;
    })
    .join("");

  const axisLabel = `<text class="tick" x="${PLOT.width - PLOT.right}" y="${height - 6}" text-anchor="end">${esc(metric)} (${esc(unit)})</text>`;
  return `<svg class="plot" viewBox="0 0 ${PLOT.width} ${height}" style="max-width:${PLOT.width}px" role="img" aria-label="${esc(`${metric}: base against this change`)}">${ticks.join("")}${marks}${axisLabel}</svg>`;
}

const figure = (body, caption) => `<figure><div class="scroll">${body}</div><figcaption>${caption}</figcaption></figure>`;

function mediaTag(side, file) {
  const src = `visual/${side}/${encodeURIComponent(file)}`;
  return file.endsWith(".webm") ? `<video src="${src}" controls muted playsinline preload="metadata"></video>` : `<img src="${src}" alt="${esc(`${humanize(file)}, ${side}`)}" loading="lazy">`;
}

const sections = {
  visual({ before, after, pages }) {
    const links = pages.map(({ route, file, url }) => `<tr><td>${url ? `<a class="open" href="${esc(url)}">Open ${esc(route)}</a>` : `<code>${esc(route)}</code>`}</td><td><code>${esc(file)}</code></td></tr>`).join("");
    const pageTable = links ? `<div class="scroll"><table><thead><tr><th>Page showing the change</th><th>File</th></tr></thead><tbody>${links}</tbody></table></div>` : "";
    const pairs = after.files
      .map((file) => {
        const had = before.files.includes(file);
        const left = had ? mediaTag("before", file) : `<p class="absent">Not present before this change.</p>`;
        return `<div class="pair"><h3>${esc(humanize(file))}</h3><div class="sides"><div><p class="side">Before</p>${left}</div><div><p class="side">After</p>${mediaTag("after", file)}</div></div></div>`;
      })
      .join("");
    return pageTable + pairs + `<p class="note">Captured by the repository's capture command, run once on the base commit and once on this change.</p>`;
  },
  integration({ nodes, edges, orphans }) {
    const requests = edges.filter(({ kind }) => kind === "http");
    const rows = requests.map(({ from, to, label }) => `<tr><td><code>${esc(label)}</code></td><td><code>${esc(from)}</code></td><td><code>${esc(to)}</code></td></tr>`).join("");
    const table = rows ? `<div class="scroll"><table><thead><tr><th>Request</th><th>Sent from</th><th>Handled by</th></tr></thead><tbody>${rows}</tbody></table></div>` : "";
    const warning = orphans.length > 0 ? `<div class="scroll"><table><thead><tr><th>API file</th><th>Caller in the repository</th></tr></thead><tbody>${orphans.map((file) => `<tr><td><code>${esc(file)}</code></td><td>${status(false, "", "none found")}</td></tr>`).join("")}</tbody></table></div>` : "";
    return figure(graphSvg({ nodes, edges, label: "Call path from interface files through API handlers to the modules they use" }), "Read left to right: a labelled arrow is an HTTP request, an unlabelled arrow is an import. Blue outlines are files this change adds.") + table + warning;
  },
  structure({ nodes, edges, summary }) {
    const counts = `<ul class="counts"><li><b>${summary.modulesAdded}</b> modules added</li><li><b>${summary.modulesRemoved}</b> removed</li><li><b>${summary.edgesAdded}</b> imports added</li><li><b>${summary.edgesRemoved}</b> imports removed</li></ul>`;
    return counts + figure(graphSvg({ nodes, edges, label: "Imports added and removed between the changed modules" }), "An arrow points from a module to one it imports. Blue arrows are new imports, red dashed arrows are imports this change removes, grey arrows are unchanged.");
  },
  measurement({ metric, unit, base, head, verdict, change }) {
    const rows = [["base", base], ["this change", head]].map(([name, samples]) => `<tr><td>${name}</td><td>${samples.length}</td><td>${round(Math.min(...samples))}</td><td>${round(quantile(samples, 0.5))}</td><td>${round(Math.max(...samples))}</td></tr>`).join("");
    const headline = `<p class="headline"><b>${change > 0 ? "+" : ""}${round(change)}%</b> on the median, judged <b>${esc(verdict)}</b>.</p>`;
    const caption = base.length === 1 ? "One measurement on each side." : "Each dot is one run. The vertical line is the median. The change counts as an improvement only when the middle half of the new runs does not overlap the middle half of the base runs.";
    return headline + figure(measurementSvg({ metric, unit, base, head }), caption) + `<details><summary>Numbers</summary><div class="scroll"><table><thead><tr><th>Side</th><th>Runs</th><th>Min</th><th>Median</th><th>Max</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  },
  regression({ rows }) {
    const cell = (code) => status(code === 0, "passes", "fails");
    const body = rows.map(({ file, base, head }) => `<tr><td><code>${esc(file)}</code></td><td>${cell(base)}</td><td>${cell(head)}</td><td>${status(base !== 0 && head === 0, "proves the change", head !== 0 ? "still failing" : "passed before too")}</td></tr>`).join("");
    return `<div class="scroll"><table><thead><tr><th>Test file</th><th>On base</th><th>On this change</th><th>Reading</th></tr></thead><tbody>${body}</tbody></table></div><p class="note">Each test file from this change was run against the base commit and against the change.</p>`;
  },
  schema({ rows }) {
    const body = rows.map(({ file, statement }) => `<tr><td><code>${esc(statement)}</code></td><td><code>${esc(file)}</code></td></tr>`).join("");
    return `<div class="scroll"><table><thead><tr><th>Statement</th><th>Migration</th></tr></thead><tbody>${body}</tbody></table></div>`;
  },
  dependencies({ added, removed }) {
    const body = [...added.map((name) => ["added", name]), ...removed.map((name) => ["removed", name])].map(([change, name]) => `<tr><td>${change}</td><td><code>${esc(name)}</code></td></tr>`).join("");
    return `<div class="scroll"><table><thead><tr><th>Change</th><th>Package</th></tr></thead><tbody>${body}</tbody></table></div>`;
  },
  review({ ran, provider, preferred, failures, findings = [] }) {
    const neutral = (text) => `<span class="status">${esc(text)}</span>`;
    const who = `<div class="scroll"><table><thead><tr><th>Reviewer</th><th>Preferred</th><th>Note</th></tr></thead><tbody><tr><td>${ran ? status(true, provider, "") : neutral("– not run")}</td><td>${esc(preferred)}</td><td>${esc(failures.join("; ") || "none")}</td></tr></tbody></table></div>`;
    if (!ran) return who;
    const rows = findings.map(({ file, line, category, consequence, fix, confidence }) => `<tr><td><code>${esc(file)}:${esc(line)}</code></td><td>${esc(category)}</td><td>${esc(consequence)}</td><td>${esc(fix)}</td><td>${esc(confidence)}</td></tr>`).join("");
    const table = rows ? `<table><thead><tr><th>Where</th><th>Kind</th><th>Consequence</th><th>Right change</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>` : `<table><thead><tr><th>Findings</th></tr></thead><tbody><tr><td>${status(true, "none", "")}</td></tr></tbody></table>`;
    return who + `<div class="scroll">${table}</div>`;
  },
  gates({ rows }) {
    const body = rows.map(({ name, code, output }) => `<tr><td>${esc(name)}</td><td>${status(code === 0, "passes", "fails")}${code === 0 || !output ? "" : `<pre>${esc(output)}</pre>`}</td></tr>`).join("");
    return `<div class="scroll"><table><thead><tr><th>Gate</th><th>Result</th></tr></thead><tbody>${body}</tbody></table></div>`;
  },
};

export function renderPage(manifest) {
  const { title, type, base, head, generatedAt, stats, required, scope, proofs, verdict } = manifest;
  const passed = required.filter(({ ok, skipped }) => ok && !skipped).length;
  const requiredRows = required.map(({ id, medium, because, ok, reason, skipped }) => `<tr><td><a href="#${id}">${esc(SECTION_TITLES[id])}</a></td><td>${esc(because)}</td><td>${esc(medium)}</td><td>${skipped ? `<span class="status">– not run</span><div class="why">${esc(reason)}</div>` : status(ok, "shown", "missing")}${ok ? "" : `<div class="why">${esc(reason)}</div>`}</td></tr>`).join("");
  const scopeRows = scope.map(({ rule, pass, detail }) => `<tr><td>${esc(rule)}</td><td>${status(pass, "holds", "broken")}</td><td>${esc(detail)}</td></tr>`).join("");
  const body = required
    .map(({ id, ok, reason }) => {
      const content = proofs[id] ? sections[id](proofs[id]) : "";
      return `<section id="${id}"><h2>${esc(SECTION_TITLES[id])}</h2>${ok ? "" : `<p class="reason">${esc(reason)}</p>`}${content}</section>`;
    })
    .join("");
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "proof", "page.css"), "utf8");

  return `<title>Proof: ${esc(title.length > 40 ? `${title.slice(0, 39)}…` : title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${css}</style>
<main>
<header>
  <p class="eyebrow">Proof of change · ${esc(type ?? "no declared type")}</p>
  <h1>${esc(title[0].toUpperCase() + title.slice(1))}</h1>
  <div class="stamp ${verdict ? "good" : "bad"}"><span aria-hidden="true">${verdict ? "✓" : "✕"}</span> ${verdict ? "Proof complete" : "Proof incomplete"}<small>${passed} of ${required.length} proofs shown · scope ${scope.every(({ pass }) => pass) ? "holds" : "broken"}</small></div>
  <dl class="meta"><div><dt>Base</dt><dd>${esc(base)}</dd></div><div><dt>Change</dt><dd>${esc(head)}</dd></div><div><dt>Files</dt><dd>${stats.files}</dd></div><div><dt>Lines added</dt><dd>${stats.addedLines}</dd></div><div><dt>Generated</dt><dd>${esc(generatedAt)}</dd></div></dl>
</header>
<section id="required"><h2>Proof this change must show</h2>
<p class="note">The list comes from fixed rules applied to the declared type and the files changed. The author does not choose it.</p>
<div class="scroll"><table><thead><tr><th>Proof</th><th>Required because</th><th>Shown as</th><th>Status</th></tr></thead><tbody>${requiredRows}</tbody></table></div></section>
${body}
<section id="scope"><h2>Scope of the change</h2><div class="scroll"><table><thead><tr><th>Rule</th><th>Result</th><th>Detail</th></tr></thead><tbody>${scopeRows}</tbody></table></div></section>
</main>`;
}
