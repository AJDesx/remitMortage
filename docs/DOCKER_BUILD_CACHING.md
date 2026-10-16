# Docker Build Layer Caching

CI builds the backend and frontend images with BuildKit layer caching, so a
rebuild with unchanged dependencies skips `npm ci`.

## How it works

- **Layer order.** Both Dockerfiles copy only `package.json` + the lockfile,
  run `npm ci`, and only then copy source. The dependency layer is reused until
  the lockfile changes.
- **Cache mounts.** `RUN --mount=type=cache,target=/root/.npm` keeps npm's
  download cache between builds without storing it in an image layer.
- **Registry-less CI cache.** `.github/workflows/docker-build-cache.yml` builds
  with `cache-from/cache-to type=gha,scope=<image>,mode=max`.

## Measuring

The `Cache Benchmark` job runs `scripts/docker-cache-benchmark.sh` for each
image: a cold build into an empty cache, then a rebuild after a source-only
change. Cold time, warm time and percentage saved are written to the run's
step summary (Actions → run → Summary). Run it locally with:

```bash
scripts/docker-cache-benchmark.sh backend backend src/index.ts
scripts/docker-cache-benchmark.sh frontend frontend next.config.ts
```

Numbers depend on runner and network, so they are published per run rather than
frozen in this document.

## No secrets in cached layers

`mode=max` exports every stage, so nothing sensitive may be written to any layer.

- `scripts/check-dockerfile-secrets.mjs` (CI job `Dockerfile Secret Lint`) rejects
  credential-looking `ARG`/`ENV` names, `COPY`/`ADD` of `.env`, `.npmrc`, keys
  and certificates, and build contexts whose `.dockerignore` doesn't exclude
  `.env*`.
- After each build the workflow greps `docker history` for credential-like
  `NAME=value` pairs.
- If an install ever needs a registry token, mount it:
  `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci` and pass it with
  `--secret id=npmrc,src=...`. Secret mounts are never part of a layer or the cache.
