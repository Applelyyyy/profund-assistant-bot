#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/backup.ts "${1:-backups}"
