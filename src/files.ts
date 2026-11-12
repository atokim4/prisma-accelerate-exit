import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".wrangler",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "generated",
  ".agents",
  ".claude",
  ".cursor",
  ".windsurf",
  ".codex",
  ".gemini",
]);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const MAX_FILE_BYTES = 1_000_000;

/** Real env files hold secrets: never opened. Example/sample/template files are fine. */
export function isSecretEnvFile(name: string): boolean {
  if (!/^\.env(\.|$)/.test(name)) return false;
  return !/\.(example|sample|template|dist|defaults)$/i.test(name);
}

export function isSourceFile(rel: string): boolean {
  return SOURCE_EXT.test(rel) && !rel.endsWith(".d.ts");
}

/** Files where build flags or Accelerate URLs can hide outside the source code. */
export function isConfigTextFile(rel: string): boolean {
  const name = basename(rel);
  if (isSecretEnvFile(name)) return false;
  if (/^\.env\./.test(name)) return true;
  if (/^Dockerfile|\.dockerfile$|^Containerfile/i.test(name)) return true;
  if (/^docker-compose.*\.ya?ml$|^compose\.ya?ml$/i.test(name)) return true;
  if (/^(vercel|netlify|turbo|nx|railway|app|render)\.json$|\.toml$/i.test(name)) return true;
  if (/^(Makefile|Procfile|justfile)$|\.(sh|bash)$/i.test(name)) return true;
  if (/\.(md|mdx)$/i.test(name)) return true;
  if (/\.ya?ml$/i.test(name)) {
    const parts = rel.split(sep);
    return (
      parts.includes(".github") ||
      parts.includes(".circleci") ||
      /^(\.gitlab-ci|bitbucket-pipelines|cloudbuild|fly|render|app|azure-pipelines|\.?travis)\.ya?ml$/i.test(name)
    );
  }
  return false;
}

export interface ProjectFiles {
  source: string[];
  packageJson: string[];
  schemas: string[];
  configText: string[];
  wrangler: string[];
}

export function walk(root: string): ProjectFiles {
  const out: ProjectFiles = { source: [], packageJson: [], schemas: [], configText: [], wrangler: [] };

  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs);
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      if (entry.name === "package.json") out.packageJson.push(rel);
      else if (entry.name.endsWith(".prisma")) out.schemas.push(rel);
      else if (isSourceFile(rel)) out.source.push(rel);
      if (/^wrangler\.(toml|json|jsonc)(\.sample|\.example)?$/.test(entry.name)) out.wrangler.push(rel);
      if (isConfigTextFile(rel)) out.configText.push(rel);
    }
  };

  visit(root);
  for (const list of Object.values(out)) list.sort();
  return out;
}
