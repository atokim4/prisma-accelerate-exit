import { structuredPatch } from "diff";
import type { Finding, ProjectInfo, ScanResult } from "./types.js";

const DOCS_KEEP_DB = "https://www.prisma.io/docs/accelerate/keep-your-database";
const DOCS_PPG = "https://www.prisma.io/docs/postgres/database/switch-from-accelerate";

const LABEL: Record<Finding["fix"], string> = {
  auto: "--fix",
  "drop-cache": "--fix --drop-cache",
  adapter: "--fix --adapter",
  manual: "manual",
};

export function adapterFor(project: ProjectInfo): string {
  switch (project.databaseProvider) {
    case "postgresql":
    case "cockroachdb":
      return "@prisma/adapter-pg (or @prisma/adapter-ppg on Prisma Postgres from an edge runtime)";
    case "mysql":
      return "@prisma/adapter-mariadb, or @prisma/adapter-planetscale on PlanetScale";
    case "mongodb":
      return "none: MongoDB is not supported on ORM 7, stay on 6.19";
    default:
      return "the driver adapter for your database (@prisma/adapter-pg, -mariadb, -planetscale, -ppg)";
  }
}

/** The branch of Prisma's official steps that matches this project's ORM version. */
export function nextSteps(project: ProjectInfo): string[] {
  const { ormMajor } = project;
  const common = [
    "Pick the runtime URL first: direct for a long-running server, pooled for serverless; keep a direct URL for migrate and introspection.",
    "Set DATABASE_URL to that URL in local, preview, production and CI. The deployed value must not start with prisma://.",
  ];
  const typeCheck =
    "Run your type checker after the fix. The client type changes once $extends(withAccelerate()) is gone, and code the extended type accepted (for example mode: string where Prisma expects \"insensitive\") can stop compiling. Fix those by hand.";
  if (ormMajor !== null && ormMajor >= 8) {
    return ["Prisma ORM 8 does not use the hosted Accelerate integration. Check the matches above; the docs guide does not apply to ORM 8.", `Docs: ${DOCS_PPG}`];
  }
  if (ormMajor !== null && ormMajor >= 7) {
    return [
      ...common,
      `ORM 7 connects through a driver adapter: ${adapterFor(project)}. Pass it as new PrismaClient({ adapter }).`,
      "Point prisma.config.ts datasource.url at the direct URL so CLI commands stop using Accelerate.",
      "Run prisma generate. --no-engine is not needed on ORM 7 and removing Accelerate adds no Rust engine to the build.",
      typeCheck,
      "Run prisma validate, your type checker and tests, then test a read, a disposable write and your transactions on a preview deploy.",
      `Docs: ${DOCS_KEEP_DB} and, on Prisma Postgres, ${DOCS_PPG}`,
    ];
  }
  if (ormMajor !== null) {
    return [
      ...common,
      ...(ormMajor === 6 && (project.ormMinor ?? 0) >= 19
        ? []
        : ["On Prisma Postgres, Prisma's guide asks for ORM 6.19 first: update prisma and @prisma/client before the switch."]),
      project.databaseProvider === "mongodb"
        ? "MongoDB: stay on 6.19. An ORM 7 upgrade is a separate migration."
        : "ORM 6 and earlier connect with the bundled query engine: new PrismaClient() with the datasource URL.",
      "Remove --no-engine, --accelerate and --data-proxy from prisma generate, then make sure your deploy bundle ships the engine file.",
      "Import Prisma Client from @prisma/client, not @prisma/client/edge.",
      typeCheck,
      "Run prisma validate, your type checker and tests, then test reads, writes and transactions on a preview deploy.",
      `Docs: ${DOCS_KEEP_DB}`,
    ];
  }
  return [...common, "Prisma ORM version not found in package.json: read both version branches in the docs.", `Docs: ${DOCS_KEEP_DB}`];
}

function formatFinding(f: Finding): string {
  const where = `${f.file}:${f.line}`;
  const snippet = f.snippet ? `\n      ${f.snippet}` : "";
  return `  [${f.severity}] ${where}  (${f.rule}, ${LABEL[f.fix]})\n      ${f.message}${snippet}`;
}

export function formatText(result: ScanResult, options: { fix: boolean; dryRun: boolean }): string {
  const { project, findings, fixed, changes, blockedBy } = result;
  const lines: string[] = [];
  const orm = project.ormMajor === null ? "not found" : `${project.ormMajor}.x (${project.ormVersionSource})`;
  lines.push(`prisma-accelerate-exit: ${result.root}`);
  lines.push(`  Prisma ORM: ${orm}   database: ${project.databaseProvider ?? "not found"}`);

  if (!project.usesAccelerate && findings.length === 0) {
    lines.push("", "No Prisma Accelerate usage found. Nothing to do before December 1, 2026.");
    return lines.join("\n");
  }

  if (fixed.length > 0) {
    lines.push("", options.dryRun ? `Would fix ${fixed.length} item(s) in ${changes.length} file(s):` : `Fixed ${fixed.length} item(s) in ${changes.length} file(s):`);
    for (const f of fixed) lines.push(`  ${f.file}:${f.line}  ${f.rule}`);
    const dropped = fixed.filter((f) => f.fix === "drop-cache");
    if (dropped.length > 0) {
      lines.push("", `Removed ${dropped.length} Accelerate cache call(s). These queries now go to the database on every call:`);
      for (const f of dropped) lines.push(`  ${f.file}:${f.line}  ${f.snippet ?? ""}`);
    }
  }

  if (blockedBy.length > 0) {
    lines.push("", "--fix changed nothing, because removing the extension now would break the build:");
    for (const reason of blockedBy) lines.push(`  - ${reason}`);
  }

  if (findings.length > 0) {
    lines.push("", options.fix ? `Left to do (${findings.length}):` : `Found ${findings.length} item(s):`);
    for (const f of findings) lines.push(formatFinding(f));
  }

  const cache = findings.filter((f) => f.rule === "cache-strategy" || f.rule === "cache-invalidate" || f.rule === "accelerate-info");
  if (cache.length > 0) {
    lines.push(
      "",
      `${cache.length} Accelerate caching call(s) found. Prisma has no replacement cache, so after removal each one either fails`,
      "type checking or, in untyped code, fails at runtime. Choose per query: drop the cache (--drop-cache) or add your own.",
    );
  }

  if (fixed.some((f) => f.rule === "dependency" || f.rule === "accelerate-url-option")) {
    lines.push("", "package.json changed: run your package manager's install to update the lockfile.");
  }
  lines.push("", "Next steps (Prisma's official guide for your version):");
  for (const step of nextSteps(project)) lines.push(`  - ${step}`);
  return lines.join("\n");
}

export function formatDiff(result: ScanResult): string {
  const out: string[] = [];
  for (const change of result.changes) {
    const patch = structuredPatch(`a/${change.file}`, `b/${change.file}`, change.before, change.after, "", "", { context: 3 });
    out.push(`diff --git a/${change.file} b/${change.file}`, `--- a/${change.file}`, `+++ b/${change.file}`);
    for (const hunk of patch.hunks) {
      out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
    }
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

export function toJson(result: ScanResult): string {
  return JSON.stringify(
    {
      root: result.root,
      project: result.project,
      findings: result.findings,
      fixed: result.fixed,
      changedFiles: result.changes.map((c) => c.file),
      blockedBy: result.blockedBy,
      nextSteps: result.project.usesAccelerate ? nextSteps(result.project) : [],
    },
    null,
    2,
  );
}

/** 0: nothing left to act on, 1: Accelerate work remains. Info-level notes never fail CI. */
export function exitCode(result: ScanResult): number {
  return result.findings.some((f) => f.severity !== "info") ? 1 : 0;
}
