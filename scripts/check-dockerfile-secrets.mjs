#!/usr/bin/env node
// Lints Dockerfiles and .dockerignore files so secrets cannot end up in image
// layers, and therefore not in BuildKit's layer cache either (the cache exports
// every layer, including intermediate stages, when mode=max).
//
// Rules:
//   - ARG/ENV names that look like credentials are rejected (build args are
//     recorded in image history; ENV persists in the image).
//   - COPY/ADD of .env files, private keys or .npmrc/.netrc is rejected.
//   - Credentials must be injected with `RUN --mount=type=secret`.
//   - Every build context must ignore .env files via .dockerignore.
//
// Usage: node scripts/check-dockerfile-secrets.mjs [Dockerfile ...]

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_?KEY|AUTH)/i;
// Names that merely configure behaviour and carry no credential.
const NAME_ALLOWLIST = /^(NEXT_PUBLIC_[A-Z0-9_]*|[A-Z0-9_]*_(URL|PATH|DIR|FILE|ENABLED|TTL|TIMEOUT))$/;
const SECRET_FILE = /(^|[\s/])(\.env(\.[\w.-]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519|[\w.-]*\.(pem|key|p12|pfx))(\s|$)/;

/** Joins backslash-continued lines and drops comments; keeps 1-based line numbers. */
export function logicalLines(source) {
  const out = [];
  let buf = "";
  let start = 0;
  source.split(/\r?\n/).forEach((raw, i) => {
    if (buf === "" && /^\s*#/.test(raw)) return;
    if (buf === "") start = i + 1;
    const line = raw.trimEnd();
    if (line.endsWith("\\")) {
      buf += line.slice(0, -1) + " ";
    } else {
      buf += line;
      if (buf.trim()) out.push({ line: start, text: buf.trim() });
      buf = "";
    }
  });
  if (buf.trim()) out.push({ line: start, text: buf.trim() });
  return out;
}

export function lintDockerfile(source) {
  const problems = [];
  for (const { line, text } of logicalLines(source)) {
    const [instruction, ...restParts] = text.split(/\s+/);
    const op = instruction.toUpperCase();
    const rest = restParts.join(" ");

    if (op === "ARG" || op === "ENV") {
      for (const name of declaredNames(op, rest)) {
        if (SECRET_NAME.test(name) && !NAME_ALLOWLIST.test(name)) {
          problems.push({ line, message: `${op} ${name} looks like a credential; use RUN --mount=type=secret instead` });
        }
      }
    }
    if (op === "COPY" || op === "ADD") {
      const args = rest.replace(/--\S+/g, " ");
      if (SECRET_FILE.test(` ${args} `)) {
        problems.push({ line, message: `${op} appears to copy a secret file (${args.trim()}); use RUN --mount=type=secret` });
      }
    }
  }
  return problems;
}

function declaredNames(op, rest) {
  if (rest.includes("=")) {
    return [...rest.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
  }
  const first = rest.split(/\s+/)[0];
  return first ? [first] : [];
}

/** .dockerignore must exclude env files so `COPY . .` can never pick them up. */
export function lintDockerignore(source) {
  const patterns = source.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const ignoresEnv = patterns.some((p) => /^\*{0,2}\/?\.env(\*|\.\*)?$/.test(p));
  return ignoresEnv ? [] : [{ line: 0, message: ".dockerignore must exclude .env and .env.* files" }];
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) files.push("backend/Dockerfile", "frontend/Dockerfile");
  let failed = false;
  for (const file of files) {
    const problems = lintDockerfile(readFileSync(file, "utf8")).map((p) => ({ ...p, file }));
    const ignore = join(dirname(file), ".dockerignore");
    if (!existsSync(ignore)) problems.push({ file, line: 0, message: `missing ${ignore}` });
    else problems.push(...lintDockerignore(readFileSync(ignore, "utf8")).map((p) => ({ ...p, file: ignore })));
    for (const p of problems) {
      console.error(`${p.file}${p.line ? `:${p.line}` : ""}: ${p.message}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log("no secrets can reach Docker image layers");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
