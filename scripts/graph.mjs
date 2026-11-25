import { extname, posix } from "node:path";
import { CODE_KINDS } from "./gate.mjs";

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];
const ROUTE_FILE = /(?:^|\/)app\/(.*\/)?route\.[cm]?[jt]sx?$/;

function literalPath(ts, node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `:param${span.literal.text}`).join("");
  return null;
}

function requestMethod(ts, options) {
  if (!options || !ts.isObjectLiteralExpression(options)) return "GET";
  const method = options.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === "method");
  return method && ts.isStringLiteral(method.initializer) ? method.initializer.text.toUpperCase() : "GET";
}

export function parseModule(ts, rel, text) {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind[CODE_KINDS[extname(rel).toLowerCase()]]);
  const imports = [];
  const calls = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const [first, second] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first && ts.isStringLiteral(first)) imports.push(first.text);
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(source);
      const path = callee === "fetch" && first ? literalPath(ts, first) : null;
      if (path?.startsWith("/")) calls.push({ method: requestMethod(ts, second), path: path.split("?")[0] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, calls };
}

export function pathAliases(ts, tsconfigText) {
  const paths = ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText).config?.compilerOptions?.paths ?? {};
  return Object.entries(paths)
    .filter(([pattern, targets]) => pattern.endsWith("/*") && targets[0]?.endsWith("/*"))
    .map(([pattern, targets]) => ({ prefix: pattern.slice(0, -1), target: posix.normalize(targets[0].slice(0, -1)) }));
}

export function resolveImport(fromRel, specifier, fileSet, aliases) {
  const alias = aliases.find(({ prefix }) => specifier.startsWith(prefix));
  if (!specifier.startsWith(".") && !alias) return null;
  const stem = alias ? posix.join(alias.target, specifier.slice(alias.prefix.length)) : posix.join(posix.dirname(fromRel), specifier);
  return RESOLVE_SUFFIXES.map((suffix) => stem + suffix).find((candidate) => fileSet.has(candidate)) ?? null;
}

export function resolveRoute(path, fileSet) {
  const wanted = path.split("/").filter(Boolean);
  return (
    [...fileSet].find((rel) => {
      const match = ROUTE_FILE.exec(rel);
      if (!match) return false;
      const segments = (match[1] ?? "").split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment));
      if (segments.at(-1)?.startsWith("[...")) return wanted.length >= segments.length - 1;
      return segments.length === wanted.length && segments.every((segment, i) => segment.startsWith("[") || wanted[i].startsWith(":") || segment === wanted[i]);
    }) ?? null
  );
}

export function moduleEdges(ts, rel, text, fileSet, aliases) {
  const { imports, calls } = parseModule(ts, rel, text);
  const edges = imports.map((specifier) => ({ from: rel, to: resolveImport(rel, specifier, fileSet, aliases), kind: "import" }));
  const requests = calls.map(({ method, path }) => ({ from: rel, to: resolveRoute(path, fileSet), kind: "http", label: `${method} ${path}` }));
  return [...edges, ...requests].filter(({ to }) => to && to !== rel);
}

export function buildGraph(ts, texts, aliases) {
  const fileSet = new Set(texts.keys());
  return [...texts].flatMap(([rel, text]) => moduleEdges(ts, rel, text, fileSet, aliases));
}

export function connectedGroups(files, edges) {
  const parent = new Map(files.map((file) => [file, file]));
  const root = (file) => (parent.get(file) === file ? file : root(parent.get(file)));
  for (const { from, to } of edges) {
    if (parent.has(from) && parent.has(to)) parent.set(root(from), root(to));
  }
  const groups = new Map();
  for (const file of files) groups.set(root(file), [...(groups.get(root(file)) ?? []), file]);
  return [...groups.values()];
}

export function layerOf(nodes, edges) {
  const depth = new Map(nodes.map((node) => [node, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const { from, to } of edges) {
      if (depth.has(from) && depth.has(to) && depth.get(to) < depth.get(from) + 1 && depth.get(from) + 1 < nodes.length) {
        depth.set(to, depth.get(from) + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
}
