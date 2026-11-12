import type { Finding } from "./types.js";

const GENERATE = /\bprisma(?:@[\w.^~-]+)?\s+generate\b/g;
const LEGACY_FLAG = /\s--(no-engine|accelerate|data-proxy)(?=[\s"'`\\]|$)/g;
const COMMAND_END = /&&|\|\||[;|\n]|"\s*(?:[,}\]]|$)/;

/** Hosted Accelerate URLs. Local `prisma dev` URLs (prisma+postgres://localhost) are fine. */
const ACCELERATE_URL = /\bprisma(?:\+postgres)?:\/\/(?!localhost\b|127\.0\.0\.1\b)[^\s"'`<>)]*/g;

export interface FlagHit {
  line: number;
  flag: string;
  text: string;
}

/** `prisma generate --no-engine`, `--accelerate`, `--data-proxy`, only inside the generate command itself. */
export function findGenerateFlags(text: string): FlagHit[] {
  const hits: FlagHit[] = [];
  const lines = text.split("\n");
  lines.forEach((lineText, index) => {
    for (const segment of generateSegments(lineText)) {
      for (const match of segment.matchAll(LEGACY_FLAG)) {
        hits.push({ line: index + 1, flag: `--${match[1]}`, text: lineText.trim() });
      }
    }
  });
  return hits;
}

function generateSegments(line: string): string[] {
  const segments: string[] = [];
  for (const match of line.matchAll(GENERATE)) {
    const rest = line.slice(match.index);
    const end = rest.search(COMMAND_END);
    segments.push(end === -1 ? rest : rest.slice(0, end));
  }
  return segments;
}

/** Removes the legacy flags from every `prisma generate` command in the text. */
export function stripGenerateFlags(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      let cursor = 0;
      for (const match of line.matchAll(GENERATE)) {
        const start = match.index;
        if (start < cursor) continue;
        const rest = line.slice(start);
        const endOffset = rest.search(COMMAND_END);
        const end = endOffset === -1 ? line.length : start + endOffset;
        out += line.slice(cursor, start) + line.slice(start, end).replace(LEGACY_FLAG, "");
        cursor = end;
      }
      return out + line.slice(cursor);
    })
    .join("\n");
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.search ? "/?…" : ""}`;
  } catch {
    return url.replace(/(api_key=)[^&\s]*/i, "$1…");
  }
}

export interface UrlHit {
  line: number;
  url: string;
}

export function findAccelerateUrls(text: string): UrlHit[] {
  const hits: UrlHit[] = [];
  text.split("\n").forEach((lineText, index) => {
    for (const match of lineText.matchAll(ACCELERATE_URL)) {
      const url = match[0];
      if (!/^prisma:\/\/./.test(url) && !/accelerate\.prisma-data\.net/.test(url)) continue;
      hits.push({ line: index + 1, url: redactUrl(url) });
    }
  });
  return hits;
}

/** `hasDriverAdapter`: the project already depends on `@prisma/adapter-*`, where an engine-less client is expected. */
export function schemaFindings(file: string, text: string, hasDriverAdapter: boolean): Finding[] {
  const findings: Finding[] = [];
  if (hasDriverAdapter) return findings;
  text.split("\n").forEach((lineText, index) => {
    if (/^\s*engineType\s*=\s*"client"/.test(lineText)) {
      findings.push({
        rule: "engine-type-client",
        severity: "warn",
        fix: "manual",
        file,
        line: index + 1,
        message:
          'engineType = "client" makes an engine-less client. Keep it only if you move to a driver adapter (for example @prisma/adapter-ppg); for the bundled engine on ORM 6.19, remove it.',
        snippet: lineText.trim(),
      });
    }
  });
  return findings;
}
