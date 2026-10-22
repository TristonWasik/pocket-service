#!/usr/bin/env bash
# Installs the packed package into a fresh consumer project (no @types/express,
# no tsconfig) and type-checks scripts/consumer-types/check.ts under each
# module resolution mode consumers commonly use. Requires a built dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS_VERSION="${CONSUMER_TS_VERSION:-~5.9.0}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$ROOT/dist/index.d.mts" ]; then
  echo "dist/ not found. Run the build first." >&2
  exit 1
fi

(cd "$ROOT" && npm pack --silent --pack-destination "$WORK" >/dev/null)
mkdir "$WORK/consumer"
cd "$WORK/consumer"
echo '{ "name": "consumer", "private": true, "type": "module" }' > package.json
npm install --silent --no-audit --no-fund \
  "$WORK"/twasik4-pocket-service-*.tgz zod "typescript@$TS_VERSION" @types/node
cp "$ROOT/scripts/consumer-types/check.ts" .

status=0
check() {
  local label="$1"
  shift
  if npx --no-install tsc --noEmit --strict --skipLibCheck --target es2022 "$@" check.ts; then
    echo "ok   $label"
  else
    echo "FAIL $label"
    status=1
  fi
}

check "node10"   --module esnext   --moduleResolution node10
check "bundler"  --module esnext   --moduleResolution bundler
check "nodenext" --module nodenext --moduleResolution nodenext

exit $status
