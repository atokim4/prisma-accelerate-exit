import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { Project, type SourceFile } from "ts-morph";
import { walk } from "./files.js";
import {
  dependencyRange,
  detectDatabaseProvider,
  detectOrmMajor,
  EXTENSION_PACKAGE,
  type PackageJsonInfo,
  readPackageJson,
  usesDriverAdapter,
} from "./project.js";
import { ADAPTERS, analyzeSource, type SourceAnalysis, type SourceEdit } from "./source-rules.js";
import { applyEdits } from "./text-edit.js";
import { findAccelerateUrls, findGenerateFlags, schemaFindings, stripGenerateFlags } from "./text-rules.js";
import type { Finding, ScanOptions, ScanResult } from "./types.js";

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];
const EDGE_IMPORT_DEPTH = 5;
/** Only files mentioning one of these get a full AST pass; the rest are scanned as text. */
const NEEDS_AST = /withAccelerate|extension-accelerate|accelerateUrl|cacheStrategy|\$accelerate|@prisma\/client\/edge|export\s+const\s+runtime\b/;
const CLIENT_MODULE = /@prisma\/client|new\s+PrismaClient\b|generated\/prisma|extension-accelerate/;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

/** `import type … from` / `export type … from` are erased at build time and never load a module. */
const TYPE_ONLY_IMPORT = /^[ \t]*(?:import|export)[ \t]+type\b[^;]*?\bfrom\s*["'][^"'\n]+["'];?/gm;

/** Source text without type-only imports, i.e. what actually runs. */
export function runtimeImportsText(text: string): string {
  return text.replace(TYPE_ONLY_IMPORT, "");
}

function importSpecifiers(text: string): string[] {
  return [...runtimeImportsText(text).matchAll(IMPORT_SPECIFIER)].map((m) => m[1] ?? "");
}

export class UsageError extends Error {}

/** Removes `"@prisma/extension-accelerate": "...",` from package.json text, keeping its formatting. */
export function removeDependencyLine(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (new RegExp(`^\\s*"${escaped}"\\s*:\\s*"[^"]*"\\s*,?\\s*$`).test(line)) {
      if (!line.trimEnd().endsWith(",")) {
        for (let i = out.length - 1; i >= 0; i--) {
          const prev = out[i] ?? "";
          if (prev.trim() === "") continue;
          out[i] = prev.replace(/,(\s*)$/, "$1");
          break;
        }
      }
      continue;
    }
    out.push(line);
  }
  const result = out.join("\n");
  JSON.parse(result);
  return result;
}

/** Adds a dependency in alphabetical position, matching the file's indentation. */
export function addDependency(text: string, name: string, range: string): string {
  const json = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  if (json.dependencies?.[name]) return text;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*"dependencies"\s*:\s*\{\s*$/.test(l));
  if (start === -1) throw new UsageError(`cannot add ${name}: no multi-line "dependencies" block`);
  let end = start + 1;
  while (end < lines.length && !/^\s*\}/.test(lines[end] ?? "")) end++;
  const entryIndent = /^(\s*)/.exec(lines[start + 1] ?? "")?.[1] ?? "    ";
  let insertAt = end;
  for (let i = start + 1; i < end; i++) {
    const key = /^\s*"([^"]+)"/.exec(lines[i] ?? "")?.[1];
    if (key && key.localeCompare(name) > 0) {
      insertAt = i;
      break;
    }
  }
  const isLast = insertAt === end;
  const entry = `${entryIndent}"${name}": "${range}"${isLast ? "" : ","}`;
  if (isLast && end > start + 1) lines[end - 1] = `${lines[end - 1]},`;
  lines.splice(insertAt, 0, entry);
  const result = lines.join("\n");
  JSON.parse(result);
  return result;
}

function loadPathAliases(root: string): Array<{ prefix: string; targets: string[] }> {
  const aliases: Array<{ prefix: string; targets: string[] }> = [];
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|(?<![:"'])\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
      const options = (JSON.parse(raw) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions;
      const base = options?.baseUrl ?? ".";
      for (const [key, targets] of Object.entries(options?.paths ?? {})) {
        aliases.push({ prefix: key.replace(/\*$/, ""), targets: targets.map((t) => normalize(join(base, t.replace(/\*$/, "")))) });
      }
    } catch {
      // Unreadable tsconfig: fall back to the common aliases below.
    }
  }
  aliases.push({ prefix: "@/", targets: ["src/", "./"] }, { prefix: "~/", targets: ["src/", "./"] });
  return aliases;
}

export function scan(rootInput: string, options: ScanOptions): ScanResult {
  const root = normalize(rootInput);
  if (!existsSync(root)) throw new UsageError(`directory not found: ${rootInput}`);
  const files = walk(root);
  const packages = files.packageJson.map((f) => readPackageJson(root, f)).filter((p): p is PackageJsonInfo => p !== null);
  const orm = detectOrmMajor(root, packages);
  const databaseProvider = detectDatabaseProvider(root, files.schemas);
  if (options.adapter && orm.major !== null && orm.major < 7) {
    throw new UsageError(`--adapter is for Prisma ORM 7; this project is on ORM ${orm.major}, which connects with the bundled engine once Accelerate is removed`);
  }

  const findings: Finding[] = [];
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: 1 },
  });

  const sources = new Map<string, string>();
  const analyses = new Map<string, { sourceFile: SourceFile; analysis: SourceAnalysis }>();
  for (const rel of files.source) {
    const text = readFileSync(join(root, rel), "utf8");
    sources.set(rel, text);
    if (!NEEDS_AST.test(text)) continue;
    const sourceFile = project.createSourceFile(join(root, rel), text, { overwrite: true });
    const analysis = analyzeSource(sourceFile, rel, orm.major, options.adapter);
    analyses.set(rel, { sourceFile, analysis });
    findings.push(...analysis.findings);
    if (text.includes(EXTENSION_PACKAGE) && !analysis.usesAccelerate) {
      findings.push({
        rule: "extension-other-use",
        severity: "info",
        fix: "manual",
        file: rel,
        line: text.split("\n").findIndex((l) => l.includes(EXTENSION_PACKAGE)) + 1,
        message: `Names ${EXTENSION_PACKAGE} without importing it (bundler externals, mocks, config). Delete the entry once the package is gone.`,
      });
    }
  }

  const dependencyFiles = packages.filter((p) => dependencyRange(p, EXTENSION_PACKAGE) !== null);
  for (const pkg of dependencyFiles) {
    const line = pkg.text.split("\n").findIndex((l) => l.includes(`"${EXTENSION_PACKAGE}"`)) + 1;
    findings.push({
      rule: "dependency",
      severity: "action",
      fix: "auto",
      file: pkg.file,
      line,
      message: `${EXTENSION_PACKAGE} ${dependencyRange(pkg, EXTENSION_PACKAGE)} is installed.`,
    });
  }

  const urlFindings: Finding[] = [];
  const textFiles = [...new Set([...files.configText, ...files.packageJson, ...files.source])];
  for (const rel of textFiles) {
    const text = sources.get(rel) ?? readFileSync(join(root, rel), "utf8");
    for (const hit of findAccelerateUrls(text)) {
      const isDoc = /\.mdx?$/i.test(rel);
      urlFindings.push({
        rule: "accelerate-url",
        severity: isDoc ? "info" : "action",
        fix: "manual",
        file: rel,
        line: hit.line,
        message: isDoc
          ? "Docs still tell people to use an Accelerate URL."
          : "Hosted Accelerate URL. Replace it with a direct or pooled database URL in every environment.",
        snippet: hit.url,
      });
    }
  }
  findings.push(...urlFindings);

  const flagFiles = [...new Set([...files.packageJson, ...files.configText.filter((f) => !/\.mdx?$/i.test(f))])];
  const flagHits = new Map<string, Finding[]>();
  for (const rel of flagFiles) {
    const hits = findGenerateFlags(readFileSync(join(root, rel), "utf8"));
    if (hits.length === 0) continue;
    const onSix = orm.major !== null && orm.major <= 6;
    const list = hits.map(
      (hit): Finding => ({
        rule: "generate-flag",
        severity: onSix ? "action" : orm.major === null ? "warn" : "info",
        fix: onSix ? "auto" : "manual",
        file: rel,
        line: hit.line,
        message: onSix
          ? `prisma generate ${hit.flag} builds a client that can only talk to Accelerate. Remove the flag on ORM 6 and earlier.`
          : orm.major === null
            ? `prisma generate ${hit.flag}: needs removing on ORM 6 and earlier, harmless on ORM 7. ORM version not detected.`
            : `prisma generate ${hit.flag} is not needed on ORM 7 and changes nothing there; safe to delete.`,
        snippet: hit.text,
      }),
    );
    flagHits.set(rel, list);
    findings.push(...list);
  }

  const legacyFlagsOnSix = flagHits.size > 0 && (orm.major === null || orm.major <= 6);
  const usesAccelerate =
    dependencyFiles.length > 0 ||
    urlFindings.length > 0 ||
    legacyFlagsOnSix ||
    [...analyses.values()].some(({ analysis }) => analysis.usesAccelerate);

  if (usesAccelerate) {
    const hasDriverAdapter = usesDriverAdapter(packages);
    for (const rel of files.schemas) findings.push(...schemaFindings(rel, readFileSync(join(root, rel), "utf8"), hasDriverAdapter));
    const edge = edgeFindings(root, files.wrangler, analyses, sources, packages);
    findings.push(...edge);
    if (edge.length > 0) {
      keepEdgeClientImports(analyses);
      for (const hits of flagHits.values()) {
        for (const hit of hits) {
          if (hit.fix !== "auto") continue;
          hit.fix = "manual";
          hit.message =
            "Keep this flag for now: Prisma runs on an edge runtime here, which needs the engine-less client until you switch to a driver adapter. Remove it in the same change.";
        }
      }
      flagHits.clear();
    }
    if (databaseProvider === "mongodb") {
      findings.push({
        rule: "mongodb-on-7",
        severity: "warn",
        fix: "manual",
        file: files.schemas[0] ?? "schema.prisma",
        line: 1,
        message:
          orm.major !== null && orm.major >= 7
            ? "MongoDB is not supported on Prisma ORM 7. Go back to 6.19 to remove Accelerate."
            : "MongoDB: stay on Prisma ORM 6.19 while removing Accelerate; treat an ORM 7 upgrade as a separate migration.",
      });
    }
  } else {
    for (let i = findings.length - 1; i >= 0; i--) {
      const rule = findings[i]?.rule;
      if (rule === "generate-flag" || rule === "cache-strategy" || rule === "cache-invalidate" || rule === "accelerate-info") findings.splice(i, 1);
    }
    flagHits.clear();
    for (const { analysis } of analyses.values()) {
      analysis.cacheEdits = [];
      analysis.blocksExtensionRemoval = [];
    }
  }

  const result: ScanResult = {
    root,
    project: { ormMajor: orm.major, ormMinor: orm.minor, ormVersionSource: orm.source, databaseProvider, usesAccelerate },
    findings: sortFindings(findings),
    changes: [],
    blockedBy: [],
    fixed: [],
  };
  if (options.fix) applyFixes(result, options, analyses, dependencyFiles, packages, flagHits);
  return result;
}

/** An edge runtime cannot load the bundled engine, so @prisma/client/edge stays until an adapter is chosen. */
function keepEdgeClientImports(analyses: Map<string, { analysis: SourceAnalysis }>): void {
  for (const { analysis } of analyses.values()) {
    for (const edit of analysis.edgeImportEdits) {
      edit.finding.fix = "manual";
      edit.finding.message =
        "Imports @prisma/client/edge in a project that runs Prisma on an edge runtime, where the bundled engine cannot load. Keep it until you pick a driver adapter that works there.";
    }
    analysis.edgeImportEdits = [];
  }
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

function applyFixes(
  result: ScanResult,
  options: ScanOptions,
  analyses: Map<string, { sourceFile: SourceFile; analysis: SourceAnalysis }>,
  dependencyFiles: PackageJsonInfo[],
  packages: PackageJsonInfo[],
  flagHits: Map<string, Finding[]>,
): void {
  const { root } = result;
  const all = [...analyses.values()].map((a) => a.analysis);
  const blockers = all.flatMap((a) => a.blocksExtensionRemoval);
  const cacheEdits = all.flatMap((a) => a.cacheEdits);
  if (cacheEdits.length > 0 && !options.dropCache) {
    blockers.push(`${cacheEdits.length} Accelerate cache call(s) listed above: decide on a replacement cache, then rerun with --fix --drop-cache to remove them`);
  }
  result.blockedBy = blockers;
  if (blockers.length > 0) return;

  const fixed: Finding[] = [];
  const adapterUsed = new Set<string>();
  for (const [rel, { sourceFile, analysis }] of analyses) {
    const chosen: SourceEdit[] = [...analysis.extensionEdits, ...analysis.edgeImportEdits];
    if (options.dropCache) chosen.push(...analysis.cacheEdits);
    if (options.adapter && analysis.adapterEdits.length > 0) {
      chosen.push(...analysis.adapterEdits);
      adapterUsed.add(rel);
    }
    if (chosen.length === 0) continue;
    const before = sourceFile.getFullText();
    const after = applyEdits(before, chosen.flatMap((e) => e.edits));
    fixed.push(...chosen.map((e) => e.finding));
    if (after !== before) result.changes.push({ file: rel, before, after });
  }

  const packageEdits = new Map<string, { before: string; after: string }>();
  const editPackage = (pkg: PackageJsonInfo, change: (text: string) => string) => {
    const current = packageEdits.get(pkg.file) ?? { before: pkg.text, after: pkg.text };
    current.after = change(current.after);
    packageEdits.set(pkg.file, current);
  };
  for (const pkg of dependencyFiles) {
    editPackage(pkg, (text) => removeDependencyLine(text, EXTENSION_PACKAGE));
    fixed.push(...result.findings.filter((f) => f.rule === "dependency" && f.file === pkg.file));
  }
  if (options.adapter && adapterUsed.size > 0) {
    const spec = ADAPTERS[options.adapter];
    for (const rel of adapterUsed) {
      const pkg = nearestPackage(rel, packages, (p) => dependencyRange(p, "@prisma/client") !== null) ?? nearestPackage(rel, packages, () => true);
      if (!pkg) continue;
      const range = dependencyRange(pkg, "@prisma/client") ?? dependencyRange(pkg, "prisma") ?? "latest";
      editPackage(pkg, (text) => addDependency(text, spec.pkg, range));
    }
  }

  const onSix = result.project.ormMajor !== null && result.project.ormMajor <= 6;
  if (onSix) {
    for (const [rel, hits] of flagHits) {
      const pkg = packages.find((p) => p.file === rel);
      if (pkg) editPackage(pkg, stripGenerateFlags);
      else {
        const before = readFileSync(join(root, rel), "utf8");
        result.changes.push({ file: rel, before, after: stripGenerateFlags(before) });
      }
      fixed.push(...hits);
    }
  }
  for (const [file, { before, after }] of packageEdits) {
    JSON.parse(after);
    if (after !== before) result.changes.push({ file, before, after });
  }

  if (!options.dryRun) {
    for (const change of result.changes) writeFileSync(join(root, change.file), change.after);
  }
  const fixedSet = new Set(fixed);
  result.fixed = result.findings.filter((f) => fixedSet.has(f));
  result.findings = result.findings.filter((f) => !fixedSet.has(f));
  result.changes.sort((a, b) => a.file.localeCompare(b.file));
}

function nearestPackage(rel: string, packages: PackageJsonInfo[], accept: (p: PackageJsonInfo) => boolean): PackageJsonInfo | undefined {
  let best: PackageJsonInfo | undefined;
  for (const pkg of packages) {
    const dir = dirname(pkg.file);
    const contains = dir === "." || rel.startsWith(`${dir}${sep}`);
    if (contains && accept(pkg) && (!best || dir.length > dirname(best.file).length)) best = pkg;
  }
  return best;
}

const WRANGLER_SCRIPT = /\bwrangler\s+(?:dev|deploy|publish)\b(?:\s+--?[\w-]+(?:[= ]\S+)?)*?\s+([\w./-]+\.[cm]?[jt]s)\b/;

/** Cloudflare Workers entry files: wrangler `main`, else the file passed to `wrangler dev`, else src/index. */
function workerEntries(root: string, wranglerFiles: string[], packages: PackageJsonInfo[]): Map<string, string> {
  const entries = new Map<string, string>();
  const dirs = new Map<string, string>();
  for (const rel of wranglerFiles) dirs.set(dirname(rel), rel);
  for (const pkg of packages) {
    const scripts = Object.values((pkg.json.scripts as Record<string, unknown> | undefined) ?? {}).filter((v): v is string => typeof v === "string");
    const dir = dirname(pkg.file);
    const script = scripts.find((v) => /\bwrangler\s+(?:dev|deploy|publish)\b/.test(v));
    if (script && !dirs.has(dir)) dirs.set(dir, `${pkg.file} scripts`);
    const fromScript = script ? WRANGLER_SCRIPT.exec(script)?.[1] : undefined;
    if (fromScript) entries.set(normalize(join(dir, fromScript)), `is the Cloudflare Workers entry (${pkg.file} scripts)`);
  }
  for (const [dir, source] of dirs) {
    const text = source.endsWith("scripts") ? "" : readFileSync(join(root, source), "utf8");
    const main = /^\s*"?main"?\s*[=:]\s*"([^"]+)"/m.exec(text)?.[1];
    const candidates = main ? [main] : ["src/index.ts", "src/index.js", "src/index.tsx", "index.ts", "index.js"];
    for (const file of candidates) {
      const entry = normalize(join(dir, file));
      if (!existsSync(join(root, entry))) continue;
      if (![...entries.keys()].some((e) => dirname(e).startsWith(dir))) entries.set(entry, `is the Cloudflare Workers entry (${source})`);
      break;
    }
  }
  return entries;
}

function edgeFindings(
  root: string,
  wranglerFiles: string[],
  analyses: Map<string, { analysis: SourceAnalysis }>,
  sources: Map<string, string>,
  packages: PackageJsonInfo[],
): Finding[] {
  const entries = new Map<string, string>();
  for (const [rel, { analysis }] of analyses) {
    if (analysis.isEdgeEntry) entries.set(rel, "exports runtime = 'edge'");
  }
  for (const rel of sources.keys()) {
    if (/^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?middleware\.[cm]?[jt]s$/.test(rel.split(sep).join("/"))) {
      entries.set(rel, "is Next.js middleware (edge runtime unless it sets runtime = 'nodejs')");
    }
  }
  for (const [entry, why] of workerEntries(root, wranglerFiles, packages)) {
    if (sources.has(entry)) entries.set(entry, why);
  }
  if (entries.size === 0) return [];

  const aliases = loadPathAliases(root);
  const resolve = (from: string, spec: string): string | null => {
    const bases: string[] = [];
    if (spec.startsWith(".")) bases.push(normalize(join(dirname(from), spec)));
    else {
      for (const alias of aliases) {
        if (spec.startsWith(alias.prefix)) for (const target of alias.targets) bases.push(normalize(join(target, spec.slice(alias.prefix.length))));
      }
    }
    for (const base of bases) {
      for (const candidate of [base, base.replace(/\.[cm]?js$/, "")]) {
        for (const suffix of RESOLVE_SUFFIXES) {
          const path = normalize(candidate + suffix);
          if (sources.has(path)) return path;
        }
      }
    }
    return null;
  };
  const touchesClient = (rel: string): boolean => CLIENT_MODULE.test(runtimeImportsText(sources.get(rel) ?? ""));

  const out: Finding[] = [];
  for (const [entry, why] of entries) {
    const seen = new Set<string>([entry]);
    let frontier = [entry];
    let hit: string | null = touchesClient(entry) ? entry : null;
    for (let depth = 0; depth < EDGE_IMPORT_DEPTH && !hit && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const rel of frontier) {
        for (const spec of importSpecifiers(sources.get(rel) ?? "")) {
          const target = resolve(rel, spec);
          if (!target || seen.has(target)) continue;
          seen.add(target);
          if (touchesClient(target)) {
            hit = target;
            break;
          }
          next.push(target);
        }
        if (hit) break;
      }
      frontier = next;
    }
    if (!hit) continue;
    out.push({
      rule: "edge-runtime",
      severity: "warn",
      fix: "manual",
      file: entry,
      line: 1,
      message: `This file ${why} and reaches Prisma Client${hit === entry ? "" : ` through ${hit}`}. Without Accelerate, check that this runtime and driver can connect (Prisma Postgres: @prisma/adapter-ppg), or move the database call to a Node.js runtime.`,
    });
  }
  return out;
}
