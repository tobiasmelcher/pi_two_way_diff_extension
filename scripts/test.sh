#!/usr/bin/env bash
# Run the test suite. We use Node's built-in `node:test` runner and jiti
# (bundled with pi) as the TypeScript loader, so we don't need any extra
# npm dependencies.
#
# Usage:
#   scripts/test.sh                 # run all tests
#   scripts/test.sh --watch         # re-run on file changes
#   scripts/test.sh tests/foo.test.ts  # a single file
set -euo pipefail

# Locate jiti's register entry (ships with pi-coding-agent).
JITI_REG="$(node -e 'console.log(require.resolve("jiti/lib/jiti-register.mjs", { paths: [require("child_process").execSync("npm root -g").toString().trim() + "/@earendil-works/pi-coding-agent"] }))' 2>/dev/null || true)"

if [[ -z "${JITI_REG:-}" || ! -f "$JITI_REG" ]]; then
  # Fallback 1: local node_modules symlink used for type-checking.
  CANDIDATE="$(pwd)/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs"
  if [[ -f "$CANDIDATE" ]]; then
    JITI_REG="$CANDIDATE"
  fi
fi

if [[ -z "${JITI_REG:-}" || ! -f "$JITI_REG" ]]; then
  echo "Could not locate jiti/lib/jiti-register.mjs." >&2
  echo "Make sure pi-coding-agent is installed, e.g. via" >&2
  echo "  npm i -g @earendil-works/pi-coding-agent" >&2
  echo "or set JITI_REG manually." >&2
  exit 1
fi

TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  # Default: all *.test.ts files under tests/.
  mapfile -t TARGETS < <(find tests -name '*.test.ts' -type f | sort)
fi

exec node --import "$JITI_REG" --test "${TARGETS[@]}"
