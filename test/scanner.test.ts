import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitCode, formatDiff } from "../src/report.js";
import { scan } from "../src/scanner.js";
import type { ScanOptions } from "../src/types.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const CHECK: ScanOptions = { fix: false, dropCache: false, dryRun: false };
const temps: string[] = [];

function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pae-test-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  temps.push(dir);
  return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const rulesAt = (dir: string, options = CHECK) => scan(dir, options).findings.map((f) => `${f.rule} ${f.file}:${f.line}`);

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detection", () => {
  it("finds every Accelerate touchpoint in a Prisma 7 app", () => {
    const result = scan(join(FIXTURES, "v7-app"), CHECK);
    expect(result.project).toMatchObject({ ormMajor: 7, databaseProvider: "postgresql", usesAccelerate: true });
    expect(result.findings.map((f) => `${f.rule} ${f.file}:${f.line}`)).toEqual([
      "accelerate-url .env.example:1",
      "generate-flag package.json:5",
      "dependency package.json:10",
      "edge-runtime src/app/api/users/route.ts:1",
      "extension-import src/lib/prisma.ts:2",
      "extends-call src/lib/prisma.ts:5",
      "accelerate-url-option src/lib/prisma.ts:6",
      "cache-strategy src/users.ts:6",
      "cache-strategy src/users.ts:11",
      "cache-invalidate src/users.ts:16",
    ]);
    expect(exitCode(result)).toBe(1);
  });

  it("treats --no-engine as harmless on ORM 7 and as a fix on ORM 6", () => {
    const seven = scan(join(FIXTURES, "v7-app"), CHECK).findings.find((f) => f.rule === "generate-flag");
    expect(seven).toMatchObject({ severity: "info", fix: "manual" });
    const six = scan(join(FIXTURES, "v6-app"), CHECK).findings.filter((f) => f.rule === "generate-flag");
    expect(six.map((f) => `${f.file}:${f.line}`)).toEqual([".github/workflows/ci.yml:9", "Dockerfile:4", "package.json:5", "package.json:6"]);
    expect(six.every((f) => f.severity === "action" && f.fix === "auto")).toBe(true);
  });

  it("redacts the API key of Accelerate URLs", () => {
    const url = scan(join(FIXTURES, "v7-app"), CHECK).findings.find((f) => f.rule === "accelerate-url");
    expect(url?.snippet).toBe("prisma+postgres://accelerate.prisma-data.net/?…");
    expect(JSON.stringify(scan(join(FIXTURES, "v7-app"), CHECK))).not.toContain("YOUR_API_KEY");
  });

  it("follows imports from a Cloudflare Worker entry to the client", () => {
    const edge = scan(join(FIXTURES, "worker"), CHECK).findings.find((f) => f.rule === "edge-runtime");
    expect(edge?.file).toBe("src/index.ts");
    expect(edge?.message).toContain("wrangler.toml");
  });

  it("handles require(), aliased imports and MongoDB", () => {
    expect(rulesAt(join(FIXTURES, "cjs"))).toContain("extends-call lib/db.js:4");
    const mongo = scan(join(FIXTURES, "mongo"), CHECK);
    expect(mongo.findings.map((f) => f.rule)).toEqual(["dependency", "mongodb-on-7", "extension-import", "extends-call"]);
  });
});

describe("package names outside imports", () => {
  it("notes bundler config that lists the extension, without failing CI", () => {
    const dir = copyFixture("v6-app");
    writeFileSync(join(dir, "vite.config.js"), 'export default { build: { rollupOptions: { external: ["@prisma/extension-accelerate"] } } };\n');
    const result = scan(dir, { ...CHECK, fix: true });
    expect(result.findings.map((f) => `${f.rule} ${f.severity} ${f.file}`)).toEqual(["accelerate-url info README.md", "extension-other-use info vite.config.js"]);
    expect(exitCode(result)).toBe(0);
  });
});

describe("no false positives", () => {
  it("ignores a Prisma app without Accelerate that uses the word everywhere", () => {
    const result = scan(join(FIXTURES, "no-accelerate"), CHECK);
    expect(result.project.usesAccelerate).toBe(false);
    expect(result.findings).toEqual([]);
    expect(exitCode(result)).toBe(0);
  });

  it("never opens a real .env file", () => {
    const dir = copyFixture("no-accelerate");
    writeFileSync(join(dir, ".env"), 'DATABASE_URL="prisma://accelerate.prisma-data.net/?api_key=SECRET"\n');
    writeFileSync(join(dir, ".env.production"), 'DATABASE_URL="prisma://accelerate.prisma-data.net/?api_key=SECRET"\n');
    expect(scan(dir, CHECK).findings).toEqual([]);
  });

  it("ignores local prisma dev URLs and generate commands without legacy flags", () => {
    const dir = copyFixture("no-accelerate");
    writeFileSync(join(dir, "Dockerfile"), "RUN npx prisma generate && echo --no-engine-cache\n");
    expect(scan(dir, CHECK).findings).toEqual([]);
  });
});

describe("--fix", () => {
  it("removes the extension, dependency, flags and edge import on ORM 6", () => {
    const dir = copyFixture("v6-app");
    const result = scan(dir, { ...CHECK, fix: true });
    expect(result.blockedBy).toEqual([]);
    expect(read(dir, "src/db.ts")).toBe(
      'import { PrismaClient } from "@prisma/client";\n\nexport const prisma = new PrismaClient();\n\nexport async function latestPosts() {\n  return prisma.post.findMany({ take: 10, orderBy: { id: "desc" } });\n}\n',
    );
    const pkg = JSON.parse(read(dir, "package.json")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.dependencies).toEqual({ "@prisma/client": "6.19.0" });
    expect(pkg.scripts).toEqual({ postinstall: "prisma generate", build: "npx prisma generate && tsc" });
    expect(read(dir, "Dockerfile")).toContain("RUN npm ci && npx prisma generate && npm run build");
    expect(read(dir, ".github/workflows/ci.yml")).toContain("- run: npx prisma generate\n");
    expect(result.findings.map((f) => f.rule)).toEqual(["accelerate-url"]);
    expect(exitCode(result)).toBe(0);
  });

  it("collapses a flag-guarded $extends instead of leaving identical branches", () => {
    const dir = copyFixture("v6-app");
    writeFileSync(
      join(dir, "src/db.ts"),
      [
        'import { PrismaClient } from "@prisma/client";',
        'import { withAccelerate } from "@prisma/extension-accelerate";',
        "",
        "const useAccelerate = process.env.USE_ACCELERATE === \"1\";",
        "const prisma = new PrismaClient();",
        "export const db = (useAccelerate ? prisma.$extends(withAccelerate()) : prisma) as PrismaClient;",
        "export const other = config.cache ? (prisma) : prisma.$extends(withAccelerate());",
        "",
      ].join("\n"),
    );
    scan(dir, { ...CHECK, fix: true });
    const lines = read(dir, "src/db.ts").split("\n");
    expect(lines).toContain("export const db = prisma as PrismaClient;");
    expect(lines).toContain("export const other = prisma;");
    expect(read(dir, "src/db.ts")).not.toContain("withAccelerate");
  });

  it("refuses to remove the extension while cache calls remain", () => {
    const dir = copyFixture("v7-app");
    const before = read(dir, "src/lib/prisma.ts");
    const result = scan(dir, { ...CHECK, fix: true });
    expect(result.changes).toEqual([]);
    expect(result.blockedBy).toHaveLength(1);
    expect(result.blockedBy[0]).toContain("--drop-cache");
    expect(read(dir, "src/lib/prisma.ts")).toBe(before);
  });

  it("drops cache calls only with --drop-cache and lists each one", () => {
    const dir = copyFixture("v7-app");
    const result = scan(dir, { ...CHECK, fix: true, dropCache: true, adapter: "pg" });
    expect(result.fixed.filter((f) => f.fix === "drop-cache").map((f) => f.line)).toEqual([6, 11, 16]);
    const users = read(dir, "src/users.ts");
    expect(users).not.toMatch(/cacheStrategy|\$accelerate/);
    expect(users).toContain("return prisma.user.count();");
    expect(users).toContain("    where: { name: { not: null } },\n  });");
  });

  it("swaps accelerateUrl for a driver adapter with --adapter", () => {
    const dir = copyFixture("v7-app");
    scan(dir, { ...CHECK, fix: true, dropCache: true, adapter: "pg" });
    expect(read(dir, "src/lib/prisma.ts")).toBe(
      [
        'import { PrismaClient } from "@prisma/client";',
        'import { PrismaPg } from "@prisma/adapter-pg";',
        "",
        "const createClient = () =>",
        "  new PrismaClient({",
        "    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),",
        '    log: ["error"],',
        "  });",
        "",
      ].join("\n") + read(join(FIXTURES, "v7-app"), "src/lib/prisma.ts").split("\n").slice(8).join("\n"),
    );
    const deps = (JSON.parse(read(dir, "package.json")) as { dependencies: Record<string, string> }).dependencies;
    expect(Object.keys(deps)).toEqual(["@prisma/adapter-pg", "@prisma/client", "next"]);
    expect(deps["@prisma/adapter-pg"]).toBe("^7.10.1");
  });

  it("keeps accelerateUrl on ORM 7 without --adapter and says why", () => {
    const dir = copyFixture("v7-app");
    const result = scan(dir, { ...CHECK, fix: true, dropCache: true });
    expect(read(dir, "src/lib/prisma.ts")).toContain("accelerateUrl: process.env.DATABASE_URL!");
    expect(result.findings.find((f) => f.rule === "accelerate-url-option")?.fix).toBe("adapter");
  });

  it("leaves the code alone when withAccelerateInfo or indirect cacheStrategy is used", () => {
    const dir = copyFixture("blocked");
    const result = scan(dir, { ...CHECK, fix: true, dropCache: true, adapter: "pg" });
    expect(result.changes).toEqual([]);
    expect(result.blockedBy).toEqual(["src/db.ts:9 cacheStrategy outside a query call", "src/db.ts:10 .withAccelerateInfo() changes the result shape"]);
  });

  it("does not swap @prisma/client/edge in a project that runs on an edge runtime", () => {
    const dir = copyFixture("worker");
    scan(dir, { ...CHECK, fix: true });
    expect(read(dir, "src/db.ts")).toBe(
      'import { PrismaClient } from "@prisma/client/edge";\n\nexport const getPrisma = (url: string) => new PrismaClient({ datasourceUrl: url });\n',
    );
  });

  it("keeps --no-engine in a project that runs Prisma on an edge runtime", () => {
    const dir = copyFixture("worker");
    const result = scan(dir, { ...CHECK, fix: true });
    expect(read(dir, "package.json")).toContain('"deploy": "prisma generate --no-engine && wrangler deploy"');
    expect(result.findings.find((f) => f.rule === "generate-flag")?.fix).toBe("manual");
  });

  it("rewrites require() and aliased imports", () => {
    const dir = copyFixture("cjs");
    scan(dir, { ...CHECK, fix: true });
    expect(read(dir, "lib/db.js")).toBe('const { PrismaClient } = require("@prisma/client");\n\nconst prisma = new PrismaClient();\n\nmodule.exports = { prisma };\n');
    const mongo = copyFixture("mongo");
    scan(mongo, { ...CHECK, fix: true });
    expect(read(mongo, "src/db.ts")).toBe('import { PrismaClient } from "@prisma/client";\n\nexport const prisma = new PrismaClient();\n');
  });

  it("--diff writes nothing and prints a patch", () => {
    const dir = copyFixture("v6-app");
    const before = read(dir, "src/db.ts");
    const result = scan(dir, { ...CHECK, fix: true, dryRun: true });
    expect(read(dir, "src/db.ts")).toBe(before);
    const diff = formatDiff(result);
    expect(diff).toContain("+++ b/src/db.ts");
    expect(diff).toContain("-export const prisma = new PrismaClient().$extends(withAccelerate());");
  });

  it("rejects --adapter on ORM 6", () => {
    expect(() => scan(join(FIXTURES, "v6-app"), { ...CHECK, fix: true, adapter: "pg" })).toThrow(/ORM 7/);
  });

  it("adds no comments or TODOs", () => {
    const dir = copyFixture("v7-app");
    const result = scan(dir, { ...CHECK, fix: true, dropCache: true, adapter: "pg" });
    const added = result.changes.flatMap((c) => c.after.split("\n").filter((l) => !c.before.includes(l)));
    expect(added.some((l) => /\/\/|\/\*|TODO/.test(l))).toBe(false);
  });
});
