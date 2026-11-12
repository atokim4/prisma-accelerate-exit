import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const EXTENSION_PACKAGE = "@prisma/extension-accelerate";
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export interface PackageJsonInfo {
  file: string;
  json: Record<string, unknown>;
  text: string;
}

export function readPackageJson(root: string, rel: string): PackageJsonInfo | null {
  const text = readFileSync(join(root, rel), "utf8");
  try {
    const json = JSON.parse(text) as unknown;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      return { file: rel, json: json as Record<string, unknown>, text };
    }
  } catch {
    // An unparsable package.json is not ours to judge; skip it.
  }
  return null;
}

export function dependencyRange(pkg: PackageJsonInfo, name: string): string | null {
  for (const field of DEP_FIELDS) {
    const deps = pkg.json[field];
    if (deps && typeof deps === "object" && name in deps) {
      const range = (deps as Record<string, unknown>)[name];
      return typeof range === "string" ? range : null;
    }
  }
  return null;
}

/** Lowest major a semver range allows: "^6.19.0" → 6, "~7.1" → 7, "latest" → null. */
/** True when any package.json depends on a Prisma driver adapter (`@prisma/adapter-*`). */
export function usesDriverAdapter(packages: PackageJsonInfo[]): boolean {
  return packages.some((pkg) =>
    DEP_FIELDS.some((field) => {
      const deps = pkg.json[field];
      return !!deps && typeof deps === "object" && Object.keys(deps).some((name) => name.startsWith("@prisma/adapter-"));
    }),
  );
}

export function majorFromRange(range: string): number | null {
  const match = /(?:^|[\s^~>=<v|])(\d+)(?:\.|$|\s|x)/.exec(range.trim());
  return match ? Number(match[1]) : null;
}

/** Minor of the lowest version a range allows: "^6.19.0" → 19. */
export function minorFromRange(range: string): number | null {
  const match = /(?:^|[\s^~>=<v|])\d+\.(\d+)/.exec(range.trim());
  return match ? Number(match[1]) : null;
}

/** Version installed in node_modules, which settles "catalog:", "workspace:*" and "latest". */
function installedMajor(root: string, pkgFile: string): number | null {
  for (const name of ["@prisma/client", "prisma"]) {
    const candidates = [join(root, dirname(pkgFile), "node_modules", name, "package.json"), join(root, "node_modules", name, "package.json")];
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      try {
        const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version;
        const major = version ? majorFromRange(version) : null;
        if (major !== null) return major;
      } catch {
        // fall through to the next candidate
      }
    }
  }
  return null;
}

/** pnpm catalogs keep the real range in pnpm-workspace.yaml. */
function catalogMajor(root: string): number | null {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return null;
  const match = /["']?@prisma\/client["']?\s*:\s*["']?([^\s"']+)/.exec(readFileSync(file, "utf8"));
  return match?.[1] ? majorFromRange(match[1]) : null;
}

export function detectOrmMajor(root: string, packages: PackageJsonInfo[]): { major: number | null; minor: number | null; source: string | null } {
  let best: { major: number; minor: number | null; source: string } | null = null;
  for (const pkg of packages) {
    for (const name of ["@prisma/client", "prisma"]) {
      const range = dependencyRange(pkg, name);
      if (range === null) continue;
      let major = majorFromRange(range);
      let source = `${pkg.file} (${name} ${range})`;
      if (major === null) {
        major = installedMajor(root, pkg.file) ?? (range.startsWith("catalog:") ? catalogMajor(root) : null);
        if (major !== null) source = `${pkg.file} (${name} ${range}, resolved ${major}.x)`;
      }
      if (major !== null && (best === null || major > best.major)) best = { major, minor: minorFromRange(range), source };
    }
  }
  return best ?? { major: null, minor: null, source: null };
}

export function detectDatabaseProvider(root: string, schemas: string[]): string | null {
  for (const rel of schemas) {
    const text = readFileSync(join(root, rel), "utf8");
    const block = /datasource\s+\w+\s*\{([^}]*)\}/.exec(text);
    const provider = block?.[1] ? /provider\s*=\s*"([^"]+)"/.exec(block[1]) : null;
    if (provider?.[1]) return provider[1];
  }
  return null;
}
