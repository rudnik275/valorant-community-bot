#!/usr/bin/env bash
# with-secrets.sh — run any command with .env.1password resolved into env.
#
# Usage:
#   ./scripts/with-secrets.sh <command...>
#
# Examples:
#   ./scripts/with-secrets.sh bun run dev
#   ./scripts/with-secrets.sh bun run db:migrate
#   ./scripts/with-secrets.sh node -e 'console.log(process.env.PUBLIC_BASE_URL)'
#
# `op run` resolves `op://`-references at exec time, injects values into the
# child process env, and masks them in stdout/stderr — values never enter
# the host shell history nor any AI conversation transcript.

set -euo pipefail

if ! command -v op >/dev/null 2>&1; then
  echo "✗ 1Password CLI (op) not found." >&2
  echo "  Install: https://developer.1password.com/docs/cli/get-started" >&2
  exit 1
fi

if [ ! -f .env.1password ]; then
  echo "✗ .env.1password not found in $(pwd)" >&2
  echo "  Run from the repo root." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <command...>" >&2
  exit 2
fi

exec op run --env-file=.env.1password -- "$@"
