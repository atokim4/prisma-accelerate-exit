#!/usr/bin/env bash
# Type-checks every TypeScript fixture against a real Prisma install, before and after --fix.
# Usage: scripts/typecheck-fixtures.sh [workdir]   (needs network for npm install; ~700 MB in workdir)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
WORK="${1:-$(mktemp -d)}"
TSCONFIG='{ "compilerOptions": { "target": "ES2023", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "skipLibCheck": true, "noEmit": true, "types": ["node"], "lib": ["ES2023", "DOM"] }, "include": ["src"] }'
failures=0

install() {
  local dir="$WORK/prisma$1"; shift
  if [ ! -d "$dir/node_modules" ]; then
    mkdir -p "$dir" && echo '{ "private": true }' > "$dir/package.json"
    (cd "$dir" && npm install --silent --no-audit --no-fund -E "$@" typescript@6.0.3 @types/node@24)
  fi
}

# check <prisma major> <fixture> <expected cli exit after fix> <fix flags...>
check() {
  local major="$1" fixture="$2" expected="$3"; shift 3
  local app="$WORK/prisma$major/app-$fixture"
  rm -rf "$app" && cp -r "$ROOT/test/fixtures/$fixture" "$app"
  ln -s ../node_modules "$app/node_modules"
  echo "$TSCONFIG" > "$app/tsconfig.json"
  (cd "$app" && PRISMA_HIDE_UPDATE_MESSAGE=1 npx prisma generate > /dev/null 2>&1)
  if ! (cd "$app" && npx tsc -p .); then echo "FAIL $fixture: does not type-check before the fix"; failures=$((failures + 1)); return; fi
  local status=0
  node "$CLI" "$app" "$@" > "$app.out" || status=$?
  if [ "$status" != "$expected" ]; then echo "FAIL $fixture $*: exit $status, expected $expected"; failures=$((failures + 1)); fi
  if (cd "$app" && npx tsc -p .); then echo "ok   prisma $major  $fixture  $*"
  else echo "FAIL $fixture $*: does not type-check after the fix"; failures=$((failures + 1)); fi
}

install 7 @prisma/client@7.10.1 prisma@7.10.1 @prisma/extension-accelerate@3.0.1 \
  @prisma/adapter-pg@7.10.1 @prisma/adapter-ppg@7.10.1 @prisma/adapter-mariadb@7.10.1
check 7 v7-app 1 --fix
check 7 v7-app 1 --fix --drop-cache
check 7 v7-app 1 --fix --drop-cache --adapter pg
check 7 v7-app 1 --fix --drop-cache --adapter ppg
check 7 v7-app 1 --fix --drop-cache --adapter mariadb
check 7 blocked 1 --fix --drop-cache --adapter pg

install 6 @prisma/client@6.19.0 prisma@6.19.0 @prisma/extension-accelerate@2.0.2
check 6 v6-app 0 --fix
check 6 worker 1 --fix
check 6 mongo 1 --fix

echo "$failures failure(s); workdir $WORK"
exit $(( failures > 0 ))
