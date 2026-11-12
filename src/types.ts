export type Severity = "action" | "warn" | "info";

/**
 * How a finding can be resolved:
 * - auto: `--fix` changes it
 * - drop-cache: `--fix --drop-cache` removes it (behaviour change, listed explicitly)
 * - adapter: `--fix --adapter <name>` rewrites it (Prisma ORM 7)
 * - manual: needs a human decision, never touched
 */
export type FixKind = "auto" | "drop-cache" | "adapter" | "manual";

export type RuleId =
  | "dependency"
  | "extension-import"
  | "extends-call"
  | "accelerate-url-option"
  | "extension-other-use"
  | "cache-strategy"
  | "cache-invalidate"
  | "accelerate-info"
  | "edge-client-import"
  | "generate-flag"
  | "accelerate-url"
  | "engine-type-client"
  | "edge-runtime"
  | "mongodb-on-7";

export interface Finding {
  rule: RuleId;
  severity: Severity;
  fix: FixKind;
  file: string;
  line: number;
  message: string;
  /** Short excerpt of the matched code, secrets redacted. */
  snippet?: string;
}

export type AdapterName = "pg" | "mariadb" | "ppg";

export interface ScanOptions {
  fix: boolean;
  dropCache: boolean;
  adapter?: AdapterName;
  /** Write nothing, only compute the patch. */
  dryRun: boolean;
}

export interface FileChange {
  file: string;
  before: string;
  after: string;
}

export interface ProjectInfo {
  ormMajor: number | null;
  /** Lowest minor the declared range allows, when it is a plain semver range. */
  ormMinor: number | null;
  ormVersionSource: string | null;
  databaseProvider: string | null;
  usesAccelerate: boolean;
}

export interface ScanResult {
  root: string;
  project: ProjectInfo;
  findings: Finding[];
  changes: FileChange[];
  /** Why `--fix` left the extension in place, if it did. */
  blockedBy: string[];
  /** Findings `--fix` resolved (only filled when fixing). */
  fixed: Finding[];
}
