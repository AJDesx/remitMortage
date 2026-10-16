#!/usr/bin/env node
// Ephemeral per-pull-request preview databases.
//
// Each PR preview gets its own RDS instance restored from the latest anonymized
// staging snapshot, so conflicting migrations and test data can no longer
// collide between PRs on a shared staging database.
//
//   provision  --pr <n> [--snapshot <id> | --source-instance <id>] [--ttl-hours 72]
//   bootstrap  --pr <n>     create the IAM-auth application role (one-time)
//   url        --pr <n>     print a DATABASE_URL with a 15-minute IAM token
//   teardown   --pr <n>     delete the PR's database (idempotent)
//   sweep                   delete every preview database past its TTL
//
// Credentials: nothing long-lived is ever stored. The application role signs in
// with RDS IAM authentication tokens (valid 15 minutes). The master password is
// randomised for the one-off bootstrap, held in memory only, then rotated to a
// second random value that is discarded.
//
// Every instance is tagged Preview/PreviewPR/PreviewCreatedAt/PreviewExpiresAt
// (the convention scripts/teardown-preview-env.sh uses) plus the standard
// cost-allocation tags, and is only ever deleted when those tags confirm it is
// a preview database. See docs/EPHEMERAL_PREVIEW_DATABASES.md.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const APP_ROLE = "preview_app";
export const DEFAULT_TTL_HOURS = 72;
export const MAX_TTL_HOURS = 168;
export const DEFAULT_INSTANCE_CLASS = "db.t4g.micro";

const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function dbIdentifier(pr) {
  if (!/^[1-9][0-9]{0,8}$/.test(String(pr))) throw new Error(`invalid pull request number: ${JSON.stringify(pr)}`);
  return `remit-preview-pr-${pr}`;
}

export function parseTtlHours(value) {
  const hours = value === undefined ? DEFAULT_TTL_HOURS : Number(value);
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_TTL_HOURS) {
    throw new Error(`ttl-hours must be between 1 and ${MAX_TTL_HOURS}`);
  }
  return Math.floor(hours);
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function previewTags({ pr, now, ttlHours, owner = "platform-team", costCenter = "remitmortgage-core" }) {
  return {
    Preview: "true",
    PreviewPR: String(pr),
    PreviewCreatedAt: iso(now),
    PreviewExpiresAt: iso(new Date(now.getTime() + ttlHours * 3_600_000)),
    Service: "preview-db",
    Environment: "preview",
    Owner: owner,
    CostCenter: costCenter,
  };
}

const tagArgs = (tags) => Object.entries(tags).map(([Key, Value]) => `Key=${Key},Value=${Value}`);
const tagMap = (list) => Object.fromEntries((list ?? []).map((t) => [t.Key, t.Value]));
const isNotFound = (err) => /DBInstanceNotFound/.test(String(err?.message ?? err));

/** A password nobody ever sees: random, in memory, URL/SQL-safe. */
export function randomPassword(bytes = 24, rng = randomBytes) {
  return rng(bytes).toString("base64url");
}

export function bootstrapSql({ dbName, masterUser }) {
  for (const [label, v] of [["database", dbName], ["master user", masterUser]]) {
    if (!SQL_IDENT.test(v)) throw new Error(`unsafe ${label} name for SQL: ${JSON.stringify(v)}`);
  }
  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} LOGIN; END IF; END $$;`,
    `GRANT rds_iam TO ${APP_ROLE};`,
    `GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO ${APP_ROLE};`,
    `GRANT ALL ON SCHEMA public TO ${APP_ROLE};`,
    // Prisma migrations ALTER existing tables, which requires ownership.
    `REASSIGN OWNED BY "${masterUser}" TO ${APP_ROLE};`,
  ].join("\n");
}

// ── operations (AWS access is injected so tests never touch AWS) ───────────

/**
 * @param {object} ctx
 * @param {(args: string[], opts?: {json?: boolean}) => Promise<any>|any} ctx.aws
 * @param {() => Date} ctx.now
 */
async function describeInstance(aws, id) {
  try {
    const out = await aws(["rds", "describe-db-instances", "--db-instance-identifier", id]);
    return out.DBInstances?.[0] ?? null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function tagsOf(aws, instance) {
  const out = await aws(["rds", "list-tags-for-resource", "--resource-name", instance.DBInstanceArn]);
  return tagMap(out.TagList);
}

async function resolveSnapshot({ aws, snapshotId, sourceInstance }) {
  if (snapshotId) return snapshotId;
  if (!sourceInstance) throw new Error("provide --snapshot or --source-instance");
  const out = await aws(["rds", "describe-db-snapshots", "--db-instance-identifier", sourceInstance, "--snapshot-type", "automated"]);
  const ready = (out.DBSnapshots ?? [])
    .filter((s) => s.Status === "available")
    .sort((a, b) => String(b.SnapshotCreateTime).localeCompare(String(a.SnapshotCreateTime)));
  if (ready.length === 0) throw new Error(`no available snapshot for ${sourceInstance}`);
  return ready[0].DBSnapshotIdentifier;
}

export async function provision({ aws, now = () => new Date(), pr, snapshotId, sourceInstance, ttlHours, env = process.env }) {
  const id = dbIdentifier(pr);
  const ttl = parseTtlHours(ttlHours);

  const existing = await describeInstance(aws, id);
  if (existing) {
    await aws(["rds", "wait", "db-instance-available", "--db-instance-identifier", id], { json: false });
    const current = await describeInstance(aws, id);
    return { id, created: false, endpoint: current.Endpoint.Address, port: current.Endpoint.Port };
  }

  const snapshot = await resolveSnapshot({ aws, snapshotId, sourceInstance });
  const tags = previewTags({ pr, now: now(), ttlHours: ttl, owner: env.PREVIEW_DB_OWNER, costCenter: env.PREVIEW_DB_COST_CENTER });
  const args = [
    "rds", "restore-db-instance-from-db-snapshot",
    "--db-instance-identifier", id,
    "--db-snapshot-identifier", snapshot,
    "--db-instance-class", env.PREVIEW_DB_INSTANCE_CLASS || DEFAULT_INSTANCE_CLASS,
    "--no-publicly-accessible",
    "--no-multi-az",
    "--enable-iam-database-authentication",
    "--no-deletion-protection",
    "--copy-tags-to-snapshot",
    "--tags", ...tagArgs(tags),
  ];
  if (env.PREVIEW_DB_SUBNET_GROUP) args.push("--db-subnet-group-name", env.PREVIEW_DB_SUBNET_GROUP);
  if (env.PREVIEW_DB_SECURITY_GROUP_IDS) args.push("--vpc-security-group-ids", ...env.PREVIEW_DB_SECURITY_GROUP_IDS.split(","));
  await aws(args);
  await aws(["rds", "wait", "db-instance-available", "--db-instance-identifier", id], { json: false });

  const instance = await describeInstance(aws, id);
  return { id, created: true, snapshot, expiresAt: tags.PreviewExpiresAt, endpoint: instance.Endpoint.Address, port: instance.Endpoint.Port };
}

export async function bootstrap({ aws, psql, pr, rng = randomBytes }) {
  const id = dbIdentifier(pr);
  const instance = await describeInstance(aws, id);
  if (!instance) throw new Error(`${id} does not exist`);

  const setPassword = async (password) => {
    await aws(["rds", "modify-db-instance", "--db-instance-identifier", id, "--master-user-password", password, "--apply-immediately"]);
    await aws(["rds", "wait", "db-instance-available", "--db-instance-identifier", id], { json: false });
  };

  const oneTime = randomPassword(24, rng);
  await setPassword(oneTime);
  try {
    await psql({
      host: instance.Endpoint.Address,
      port: instance.Endpoint.Port,
      user: instance.MasterUsername,
      database: instance.DBName,
      password: oneTime,
      sql: bootstrapSql({ dbName: instance.DBName, masterUser: instance.MasterUsername }),
    });
  } finally {
    // Rotate to a value nobody holds, whether or not the bootstrap succeeded.
    await setPassword(randomPassword(24, rng));
  }
  return { id, role: APP_ROLE };
}

export async function connectionUrl({ aws, pr, region }) {
  const id = dbIdentifier(pr);
  const instance = await describeInstance(aws, id);
  if (!instance) throw new Error(`${id} does not exist`);
  const { Address: host, Port: port } = instance.Endpoint;
  const token = String(
    await aws(
      ["rds", "generate-db-auth-token", "--hostname", host, "--port", String(port), "--username", APP_ROLE, ...(region ? ["--region", region] : [])],
      { json: false },
    ),
  ).trim();
  return `postgresql://${APP_ROLE}:${encodeURIComponent(token)}@${host}:${port}/${instance.DBName}?sslmode=require`;
}

async function deleteInstance(aws, id) {
  try {
    await aws(["rds", "delete-db-instance", "--db-instance-identifier", id, "--skip-final-snapshot", "--delete-automated-backups"]);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export async function teardown({ aws, pr }) {
  const id = dbIdentifier(pr);
  const instance = await describeInstance(aws, id);
  if (!instance) return { removed: [] };
  const tags = await tagsOf(aws, instance);
  if (tags.Preview !== "true" || tags.PreviewPR !== String(pr)) {
    throw new Error(`refusing to delete ${id}: it is not tagged as the preview database for PR ${pr}`);
  }
  return { removed: (await deleteInstance(aws, id)) ? [{ pr: String(pr), id }] : [] };
}

export async function sweep({ aws, now = () => new Date() }) {
  const out = await aws(["rds", "describe-db-instances"]);
  const removed = [];
  for (const instance of out.DBInstances ?? []) {
    if (!/^remit-preview-pr-\d+$/.test(instance.DBInstanceIdentifier)) continue;
    const tags = await tagsOf(aws, instance);
    if (tags.Preview !== "true" || !tags.PreviewExpiresAt) continue;
    if (new Date(tags.PreviewExpiresAt).getTime() > now().getTime()) continue;
    if (await deleteInstance(aws, instance.DBInstanceIdentifier)) {
      removed.push({ pr: tags.PreviewPR ?? "unknown", id: instance.DBInstanceIdentifier });
    }
  }
  return { removed };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function realAws(args, { json = true } = {}) {
  const region = process.env.AWS_REGION;
  const full = [...args, ...(region && !args.includes("--region") ? ["--region", region] : []), "--output", json ? "json" : "text"];
  try {
    const out = execFileSync("aws", full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
    return json ? (out.trim() ? JSON.parse(out) : {}) : out;
  } catch (err) {
    // Never echo argv: it can contain a one-time password.
    throw new Error(String(err.stderr || err.message).trim());
  }
}

function realPsql({ host, port, user, database, password, sql }) {
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-h", host, "-p", String(port), "-U", user, "-d", database, "-c", sql], {
    env: { ...process.env, PGPASSWORD: password, PGSSLMODE: "require" },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith("--") || rest[i + 1] === undefined) throw new Error(`bad argument: ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, opts };
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const aws = realAws;
  switch (command) {
    case "provision": {
      const r = await provision({
        aws,
        pr: opts.pr,
        snapshotId: opts.snapshot ?? process.env.PREVIEW_DB_SNAPSHOT_ID,
        sourceInstance: opts["source-instance"] ?? process.env.PREVIEW_DB_SOURCE_INSTANCE,
        ttlHours: opts["ttl-hours"] ?? process.env.PREVIEW_DB_TTL_HOURS,
      });
      console.log(`PREVIEW_DB id=${r.id} created=${r.created} endpoint=${r.endpoint}`);
      break;
    }
    case "bootstrap":
      await bootstrap({ aws, psql: realPsql, pr: opts.pr });
      console.log(`PREVIEW_DB bootstrapped role=${APP_ROLE}`);
      break;
    case "url":
      process.stdout.write(await connectionUrl({ aws, pr: opts.pr, region: process.env.AWS_REGION }));
      break;
    case "teardown": {
      const r = await teardown({ aws, pr: opts.pr });
      for (const x of r.removed) console.log(`PREVIEW_TEARDOWN ${x.pr} rds ${x.id}`);
      break;
    }
    case "sweep": {
      const r = await sweep({ aws });
      for (const x of r.removed) console.log(`PREVIEW_TEARDOWN ${x.pr} rds ${x.id}`);
      break;
    }
    default:
      throw new Error("usage: preview-db.mjs provision|bootstrap|url|teardown|sweep [--pr <n>] [options]");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
