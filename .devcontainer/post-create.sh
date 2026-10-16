#!/usr/bin/env bash
#
# One-command local setup (issue #878): runs automatically when the dev
# container is created. Installs dependencies, prepares the database with seed
# data, and warms the contract build. Everything is idempotent so re-running is
# safe (e.g. `bash .devcontainer/post-create.sh`).
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo /workspaces/remitMortgage)"
echo "==> Setting up RemitMortgage in $(pwd)"

echo "==> Installing backend dependencies"
npm --prefix backend ci

echo "==> Generating Prisma client"
(cd backend && npx prisma generate)

echo "==> Applying database schema"
if ! (cd backend && npx prisma migrate deploy); then
  echo "    migrate deploy unavailable — falling back to db push"
  (cd backend && npx prisma db push --skip-generate)
fi

echo "==> Seeding the database"
(cd backend && npm run db:seed) || echo "    seed skipped (non-fatal)"

echo "==> Installing frontend dependencies"
npm --prefix frontend ci

echo "==> Building contracts to wasm (may take a few minutes)"
(cd contracts && cargo build --target wasm32-unknown-unknown --release) \
  || echo "    contract build skipped (non-fatal)"

cat <<'EOF'

==> Dev container ready.

  make dev    # run backend (:4000) and frontend (:3000)
  make test   # run backend + contracts tests

EOF
