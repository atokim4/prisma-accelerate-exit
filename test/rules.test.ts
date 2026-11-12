import { describe, expect, it } from "vitest";
import { majorFromRange } from "../src/project.js";
import { addDependency, removeDependencyLine, runtimeImportsText } from "../src/scanner.js";
import { findAccelerateUrls, findGenerateFlags, redactUrl, schemaFindings, stripGenerateFlags } from "../src/text-rules.js";

describe("generate flags", () => {
  it("only matches flags of the prisma generate command itself", () => {
    expect(findGenerateFlags("npx prisma generate --no-engine && next build --accelerate").map((h) => h.flag)).toEqual(["--no-engine"]);
    expect(findGenerateFlags('"build": "prisma generate", "x": "tool --no-engine"')).toEqual([]);
    expect(findGenerateFlags("pnpm db-generate:no-engine")).toEqual([]);
    expect(findGenerateFlags("bunx prisma@6.19.0 generate --data-proxy")).toHaveLength(1);
  });

  it("strips them without touching the rest of the line", () => {
    expect(stripGenerateFlags('    "postinstall": "prisma generate --no-engine --schema prisma/schema.prisma",')).toBe(
      '    "postinstall": "prisma generate --schema prisma/schema.prisma",',
    );
    expect(stripGenerateFlags("RUN prisma generate --no-engine && node build.js --accelerate")).toBe("RUN prisma generate && node build.js --accelerate");
  });
});

describe("Accelerate URLs", () => {
  it("finds hosted URLs and skips local prisma dev URLs", () => {
    const text = [
      'DATABASE_URL="prisma://accelerate.prisma-data.net/?api_key=abc"',
      'DATABASE_URL="prisma+postgres://localhost:51213/?api_key=abc"',
      'PULSE_URL="prisma+postgres://accelerate.prisma-data.net/?api_key=abc"',
      "See https://www.prisma.io/docs/accelerate",
    ].join("\n");
    expect(findAccelerateUrls(text)).toEqual([
      { line: 1, url: "prisma://accelerate.prisma-data.net/?…" },
      { line: 3, url: "prisma+postgres://accelerate.prisma-data.net/?…" },
    ]);
  });

  it("never returns the key", () => {
    expect(redactUrl("prisma://accelerate.prisma-data.net/?api_key=eyJsecret")).not.toContain("eyJ");
  });
});

describe("package.json edits", () => {
  const pkg = '{\n  "dependencies": {\n    "@prisma/client": "^7.10.1",\n    "@prisma/extension-accelerate": "^3.0.1"\n  }\n}\n';

  it("removes the last dependency and its comma", () => {
    expect(removeDependencyLine(pkg, "@prisma/extension-accelerate")).toBe('{\n  "dependencies": {\n    "@prisma/client": "^7.10.1"\n  }\n}\n');
  });

  it("adds a dependency in alphabetical order", () => {
    expect(addDependency(pkg, "@prisma/adapter-pg", "^7.10.1")).toContain('"@prisma/adapter-pg": "^7.10.1",\n    "@prisma/client"');
    expect(addDependency(pkg, "zod", "4.0.0")).toContain('"@prisma/extension-accelerate": "^3.0.1",\n    "zod": "4.0.0"\n  }');
  });
});

describe("version ranges", () => {
  it.each([
    ["^6.19.0", 6],
    ["~7.1", 7],
    ["7", 7],
    [">=5.0.0 <7", 5],
    ["latest", null],
    ["workspace:*", null],
  ])("%s → %s", (range, major) => {
    expect(majorFromRange(range)).toBe(major);
  });
});

describe("edge import graph", () => {
  it("ignores type-only imports, which never load Prisma Client at runtime", () => {
    const text = [
      'import type { Prisma } from "../../generated/prisma/client";',
      "export type {",
      "  User,",
      '} from "@prisma/client";',
      'import { z } from "zod";',
      'import { db } from "./db";',
    ].join("\n");
    const kept = runtimeImportsText(text);
    expect(kept).not.toMatch(/prisma/);
    expect(kept).toContain('import { z } from "zod";');
    expect(kept).toContain('import { db } from "./db";');
  });
});

describe("schema.prisma", () => {
  const schema = 'generator client {\n  provider   = "prisma-client"\n  engineType = "client"\n}\n';

  it('warns about engineType = "client" when no driver adapter is installed', () => {
    expect(schemaFindings("prisma/schema.prisma", schema, false).map((f) => `${f.rule}:${f.line}`)).toEqual(["engine-type-client:3"]);
  });

  it("stays quiet when the project already uses a driver adapter", () => {
    expect(schemaFindings("prisma/schema.prisma", schema, true)).toEqual([]);
  });
});
