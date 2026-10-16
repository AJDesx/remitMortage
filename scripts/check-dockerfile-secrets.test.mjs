import assert from "node:assert/strict";
import test from "node:test";
import { lintDockerfile, lintDockerignore, logicalLines } from "./check-dockerfile-secrets.mjs";

const messages = (src) => lintDockerfile(src).map((p) => p.message);

test("a plain Dockerfile with cache and secret mounts passes", () => {
  const src = `FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \\
    --mount=type=secret,id=npmrc,target=/root/.npmrc \\
    npm ci
ENV NODE_ENV=production
ENV NEXT_PUBLIC_API_URL=https://example.test
`;
  assert.deepEqual(lintDockerfile(src), []);
});

test("rejects credential-looking ARG and ENV declarations", () => {
  assert.equal(messages("ARG NPM_TOKEN").length, 1);
  assert.equal(messages("ARG NPM_TOKEN=abc").length, 1);
  assert.equal(messages("ENV DATABASE_PASSWORD=hunter2").length, 1);
  assert.equal(messages("ENV A=1 AWS_SECRET_ACCESS_KEY=x").length, 1);
});

test("allows non-credential names that happen to contain a keyword", () => {
  assert.deepEqual(lintDockerfile("ENV TOKEN_ENDPOINT_URL=https://x\nENV NEXT_PUBLIC_AUTH_URL=https://y"), []);
});

test("rejects copying env files, npmrc and private keys", () => {
  assert.equal(messages("COPY .env /app/.env").length, 1);
  assert.equal(messages("COPY .env.production ./").length, 1);
  assert.equal(messages("COPY --chown=app .npmrc /root/.npmrc").length, 1);
  assert.equal(messages("ADD deploy/server.pem /etc/ssl/").length, 1);
  assert.equal(messages("COPY id_rsa /root/.ssh/id_rsa").length, 1);
});

test("allows copying ordinary files, including .env.example-free source trees", () => {
  assert.deepEqual(lintDockerfile("COPY package.json package-lock.json ./\nCOPY src/ ./src/\nCOPY . ."), []);
});

test("reports the line of a multi-line instruction", () => {
  const problems = lintDockerfile("FROM x\n# comment\nENV A=1 \\\n    API_KEY=2\n");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 3);
});

test("comments are ignored", () => {
  assert.deepEqual(lintDockerfile("# ARG NPM_TOKEN\nFROM x"), []);
  assert.deepEqual(logicalLines("# only a comment\n"), []);
});

test(".dockerignore must exclude env files", () => {
  assert.equal(lintDockerignore("node_modules\n").length, 1);
  assert.deepEqual(lintDockerignore("node_modules\n.env\n.env.*\n"), []);
  assert.deepEqual(lintDockerignore(".env*\n"), []);
});
