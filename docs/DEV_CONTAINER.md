# Dev Container — One-Command Local Setup

Setting up the full stack by hand (Node, Rust with the wasm target,
PostgreSQL, Redis, migrations, seed data) is slow and differs per machine. The
dev container pins all of that into one image and brings up the backing
services, so a new contributor runs the app and the tests with one command.

## What you get

| Tool | Version / detail |
|------|------------------|
| Node.js | 22 (matches `backend/Dockerfile`) + npm |
| Rust | stable, with `clippy`, `rustfmt` and the `wasm32-unknown-unknown` / `wasm32v1-none` targets |
| PostgreSQL | 16 (service `postgres`, port `5432`) |
| Redis | 7 (service `redis`, port `6379`) |
| Extras | `psql`, `redis-cli`, `make`, `jq`, git, a C toolchain |

The database is migrated and seeded automatically on first start, and the
standard ports are forwarded to your host.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose v2)
- [VS Code](https://code.visualstudio.com/) with the
  [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

## Open it

1. Clone the repository and open the folder in VS Code.
2. Run **Dev Containers: Reopen in Container** (or the "Reopen in Container"
   prompt). The first build installs the toolchains and takes a few minutes.
3. On first start the container runs
   [`.devcontainer/post-create.sh`](../.devcontainer/post-create.sh), which
   installs backend/frontend dependencies, applies the Prisma schema, seeds the
   database, and builds the contracts to wasm.

## Run the app and the tests

Inside the container:

```bash
make dev    # backend on http://localhost:4000, frontend on http://localhost:3000
make test   # backend + frontend + smart-contract tests
```

`make help` lists every target (`setup`, `db-migrate`, `db-seed`, `backend`,
`frontend`, `build`, `up`, `down`, `logs`).

## Ports

| Port | Service | Forwarded |
|------|---------|-----------|
| 3000 | Frontend (Next.js) | yes |
| 4000 | Backend API | yes |
| 5432 | PostgreSQL | yes |
| 6379 | Redis | yes |

## How it is wired

- [`.devcontainer/Dockerfile`](../.devcontainer/Dockerfile) — the image
  (Node + Rust + wasm targets + clients).
- [`.devcontainer/docker-compose.yml`](../.devcontainer/docker-compose.yml) —
  the `workspace` service plus `postgres` and `redis`.
- [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json) —
  forwards ports, pre-installs editor extensions, and runs the setup script.
- [`.devcontainer/post-create.sh`](../.devcontainer/post-create.sh) — the
  idempotent setup steps (safe to re-run).
- [`.github/workflows/devcontainer.yml`](../.github/workflows/devcontainer.yml)
  — builds the image on every change to `.devcontainer/`, so it can never
  silently stop building.

## Keeping it working

CI (`.github/workflows/devcontainer.yml`) builds the image on any change under
`.devcontainer/` and once a week. If a change to the Dockerfile, compose file,
or devcontainer config breaks the build, the job fails and blocks the PR.
Run the same check locally with:

```bash
docker compose -f .devcontainer/docker-compose.yml config -q
docker build -f .devcontainer/Dockerfile -t remitmortgage-devcontainer:ci .
```

## Without VS Code

You can build and enter the image manually:

```bash
docker build -f .devcontainer/Dockerfile -t remitmortgage-devcontainer .
docker run --rm -it -v "$PWD:/workspaces/remitMortgage" \
  -w /workspaces/remitMortgage remitmortgage-devcontainer bash
```

Start PostgreSQL and Redis separately (for example `docker compose up -d
postgres redis`), then run `make setup` and `make dev`.
