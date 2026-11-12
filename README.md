# prisma-accelerate-exit

Standalone Prisma Accelerate shuts down on **December 1, 2026**. Changing `DATABASE_URL` is the easy part. Most apps also have `cacheStrategy` arguments that stop compiling, a `prisma generate --no-engine` in CI, or an edge route that can't open a TCP connection. `prisma-accelerate-exit` finds all of these, removes the parts that are safe to remove, and lists the rest with file and line.

It runs offline. It needs no database and no network, and it never opens your real `.env` files.

```
npx github:atokim4/prisma-accelerate-exit .            # report
npx github:atokim4/prisma-accelerate-exit . --diff     # show the patch, write nothing
npx github:atokim4/prisma-accelerate-exit . --fix      # apply it
```

It follows Prisma's own migration guides:
[Keep your existing database](https://www.prisma.io/docs/accelerate/keep-your-database) and
[Connect to Prisma Postgres without Accelerate](https://www.prisma.io/docs/postgres/database/switch-from-accelerate).

## What it checks

| Rule | Finds | `--fix` |
| --- | --- | --- |
| `dependency` | `@prisma/extension-accelerate` in any `package.json` (monorepos too) | removes it |
| `extension-import` | `import { withAccelerate }` / `require()`, aliases included | removes it |
| `extends-call` | `.$extends(withAccelerate())` | removes the call and keeps the client |
| `accelerate-url-option` | `new PrismaClient({ accelerateUrl })` (ORM 7) | with `--adapter pg\|mariadb\|ppg`, swaps it for a driver adapter |
| `cache-strategy` | `cacheStrategy: { ttl, swr, tags }` on queries | only with `--drop-cache`, and lists every query it touched |
| `cache-invalidate` | `$accelerate.invalidate()` / `invalidateAll()` | only with `--drop-cache` |
| `accelerate-info` | `.withAccelerateInfo()` (changes the result shape) | never, rewrite it yourself |
| `extension-other-use` | other imports from the extension (for example `PrismaCacheStrategy`), dynamic imports | never |
| `generate-flag` | `prisma generate --no-engine / --accelerate / --data-proxy` in scripts, Dockerfiles, CI | removes it on ORM 6 and earlier; on ORM 7 it is reported as harmless |
| `edge-client-import` | `@prisma/client/edge` | switches to `@prisma/client` on ORM 6, unless the project runs on an edge runtime |
| `accelerate-url` | `prisma://…` and `prisma+postgres://accelerate.prisma-data.net` in `.env.example`, docker-compose, CI, README, source | never, the replacement URL is yours to choose (API keys are redacted in the output) |
| `edge-runtime` | `export const runtime = "edge"`, Next.js middleware and Cloudflare Workers entries that reach Prisma Client through imports | never, it's an architecture decision |
| `engine-type-client` | `engineType = "client"` in `schema.prisma` | never |
| `mongodb-on-7` | MongoDB projects (stay on ORM 6.19) | never |

It reads the Prisma ORM major from `package.json` (or `node_modules`, or a pnpm catalog) and prints the steps from the official guide for that version: driver adapters on ORM 7, the bundled engine on ORM 6 and earlier, and staying on 6.19 for MongoDB.

## How `--fix` stays safe

- **All or nothing.** If some code would stop compiling once the extension is gone (cache calls without `--drop-cache`, `.withAccelerateInfo()`, a type imported from the extension), `--fix` changes nothing and says why.
- **Minimal diffs.** Edits are made at exact positions in the original text. No reformatting, no added comments, no TODOs. Your quotes, semicolons and indentation stay as they are.
- **Behaviour changes are explicit.** Removing `cacheStrategy` means those queries hit the database every time, so it only happens with `--drop-cache`, and every removed call is printed.
- **Edge apps keep the engine-less client.** In a project that runs Prisma on an edge runtime, `@prisma/client/edge` and `--no-engine` stay until you pick a driver adapter that works there.
- **The client type changes.** Without `$extends(withAccelerate())`, TypeScript checks your queries against the plain client type, which can be stricter. In one real ORM 5 app, removing the extension surfaced 21 errors that were already in the code (for example `mode: 'insensitive'` stored in an untyped object, so it widened to `string`). The tool reports none of these as fixed. Run your type checker after `--fix`.
- `package.json` edits keep the file's own formatting. Run your package manager's install afterwards to update the lockfile.

## Tested on real code

I ran it on 35 public repositories that depend on `@prisma/extension-accelerate` (33 apps plus Prisma's own examples and tests) and read every finding in the source. In 23 of the 33 apps, removing the import and `$extends` call was not enough: 14 had an edge entry that reaches Prisma Client, 7 had a legacy `prisma generate` flag, 6 used `accelerateUrl`, and 5 used Accelerate caching APIs (31 `cacheStrategy` calls). On 20 of the 21 projects that installed and built, `tsc --noEmit` after `--fix` reported no new errors; the 21st is the type change described above.

Example on a Prisma 7 app:

```diff
 import { PrismaClient } from "@prisma/client";
-import { withAccelerate } from "@prisma/extension-accelerate";
+import { PrismaPg } from "@prisma/adapter-pg";

 const createClient = () =>
   new PrismaClient({
-    accelerateUrl: process.env.DATABASE_URL!,
+    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
     log: ["error"],
-  }).$extends(withAccelerate());
+  });
```

## Options

```
prisma-accelerate-exit [dir] [options]

  --fix              Remove withAccelerate, $extends(withAccelerate()), the
                     dependency, and (ORM 6 and earlier) --no-engine flags
  --drop-cache       With --fix: also delete cacheStrategy arguments and
                     $accelerate.invalidate() calls, and list each one
  --adapter <name>   With --fix on ORM 7: replace accelerateUrl with a driver
                     adapter (pg, mariadb, ppg)
  --diff             Print the patch as a unified diff and write nothing
  --json             Machine-readable output
```

Exit codes: `0` nothing left to do, `1` Accelerate usage remains (warnings included, info notes never fail), `2` usage error, `3` unexpected error. That makes it usable as a CI gate:

```yaml
- run: npx github:atokim4/prisma-accelerate-exit .
```

## After the tool

The tool covers the code. You still have to:

1. Pick the runtime URL: direct for a long-running server, pooled for serverless. Keep a direct URL for `prisma migrate`.
2. Set it in every environment (local, preview, production, CI). The deployed `DATABASE_URL` must not start with `prisma://`.
3. Run `prisma validate`, `prisma generate`, your type checker and tests. Then try a read, a disposable write and your transactions on a preview deploy, under realistic concurrency.
4. Keep the old Accelerate credential as a rollback until production is stable, then revoke it.

## Development

Requires Node.js 22.12 or newer.

```
npm install
npm run build
npm test                          # Vitest: fixtures for every rule, incl. non-Accelerate apps
npm run lint && npm run typecheck
scripts/typecheck-fixtures.sh     # installs Prisma 7.10.1 and 6.19.0, type-checks fixtures before and after --fix
```

Stack: TypeScript, [ts-morph](https://ts-morph.com) for the AST pass, `jsdiff` for `--diff`, Vitest.

## License

MIT © Sunnatulla E
