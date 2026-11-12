#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { exitCode, formatDiff, formatText, toJson } from "./report.js";
import { scan, UsageError } from "./scanner.js";
import type { AdapterName } from "./types.js";

const HELP = `Usage: prisma-accelerate-exit [dir] [options]

Finds everything that still depends on Prisma Accelerate (retired December 1, 2026)
and removes what can be removed safely. Offline: no database, no network, never
reads .env files.

Options:
  --fix              Remove withAccelerate, $extends(withAccelerate()), the
                     dependency, and (ORM 6 and earlier) --no-engine flags
  --drop-cache       With --fix: also delete cacheStrategy arguments and
                     $accelerate.invalidate() calls, and list each one
  --adapter <name>   With --fix on ORM 7: replace accelerateUrl with a driver
                     adapter (pg, mariadb, ppg)
  --diff             Print the patch as a unified diff and write nothing
  --json             Machine-readable output
  -h, --help         Show this help
  -v, --version      Show the version

Exit codes: 0 nothing left to do, 1 Accelerate usage remains, 2 usage error,
3 unexpected error.`;

const ADAPTER_NAMES: readonly AdapterName[] = ["pg", "mariadb", "ppg"];

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      fix: { type: "boolean", default: false },
      "drop-cache": { type: "boolean", default: false },
      adapter: { type: "string" },
      diff: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(version());
    return 0;
  }
  if (positionals.length > 1) throw new UsageError("pass at most one directory");
  if (values.adapter !== undefined && !ADAPTER_NAMES.includes(values.adapter as AdapterName)) {
    throw new UsageError(`--adapter must be one of: ${ADAPTER_NAMES.join(", ")}`);
  }
  const fix = values.fix || values.diff;
  if (!fix && (values["drop-cache"] || values.adapter)) throw new UsageError("--drop-cache and --adapter only work with --fix or --diff");

  const dir = resolve(positionals[0] ?? ".");
  const result = scan(dir, {
    fix,
    dropCache: values["drop-cache"],
    adapter: values.adapter as AdapterName | undefined,
    dryRun: values.diff,
  });

  if (values.json) console.log(toJson(result));
  else if (values.diff) {
    process.stdout.write(formatDiff(result));
    console.error(formatText(result, { fix, dryRun: true }));
  } else console.log(formatText(result, { fix, dryRun: false }));
  return exitCode(result);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prisma-accelerate-exit: ${message}`);
  process.exitCode = error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? 2 : 3;
}
