import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_ROLE,
  bootstrap,
  bootstrapSql,
  connectionUrl,
  dbIdentifier,
  parseTtlHours,
  previewTags,
  provision,
  randomPassword,
  sweep,
  teardown,
} from "./preview-db.mjs";

const NOW = new Date("2026-10-01T10:00:00.000Z");
const notFound = () => Object.assign(new Error("An error occurred (DBInstanceNotFound)"), {});

/** In-memory stand-in for the slice of RDS the script uses. */
function fakeAws({ instances = {}, tags = {}, snapshots = [] } = {}) {
  const calls = [];
  const db = structuredClone(instances);
  const tagStore = structuredClone(tags);
  const aws = async (args) => {
    calls.push(args);
    const [, op] = args;
    const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const id = flag("--db-instance-identifier");
    switch (op) {
      case "describe-db-instances":
        if (id) {
          if (!db[id]) throw notFound();
          return { DBInstances: [db[id]] };
        }
        return { DBInstances: Object.values(db) };
      case "describe-db-snapshots":
        return { DBSnapshots: snapshots };
      case "restore-db-instance-from-db-snapshot": {
        db[id] = {
          DBInstanceIdentifier: id,
          DBInstanceArn: `arn:aws:rds:us-east-1:1:db:${id}`,
          DBName: "remitmortgage",
          MasterUsername: "postgres",
          Endpoint: { Address: `${id}.example.rds.amazonaws.com`, Port: 5432 },
        };
        const tagFlagAt = args.indexOf("--tags") + 1;
        tagStore[db[id].DBInstanceArn] = args.slice(tagFlagAt).filter((a) => a.startsWith("Key=")).map((a) => {
          const [k, v] = a.split(",");
          return { Key: k.slice(4), Value: v.slice(6) };
        });
        return {};
      }
      case "list-tags-for-resource":
        return { TagList: tagStore[flag("--resource-name")] ?? [] };
      case "delete-db-instance":
        if (!db[id]) throw notFound();
        delete db[id];
        return {};
      case "generate-db-auth-token":
        return "host:5432/?Action=connect&X-Amz-Signature=a/b+c=";
      default:
        return {};
    }
  };
  return { aws, calls, db, tagStore };
}

const preview = (pr, expires, extra = {}) => ({
  inst: {
    DBInstanceIdentifier: `remit-preview-pr-${pr}`,
    DBInstanceArn: `arn:aws:rds:us-east-1:1:db:remit-preview-pr-${pr}`,
    DBName: "remitmortgage",
    MasterUsername: "postgres",
    Endpoint: { Address: "h", Port: 5432 },
  },
  tags: [
    { Key: "Preview", Value: "true" },
    { Key: "PreviewPR", Value: String(pr) },
    ...(expires ? [{ Key: "PreviewExpiresAt", Value: expires }] : []),
  ],
  ...extra,
});

function seed(...previews) {
  const instances = {};
  const tags = {};
  for (const p of previews) {
    instances[p.inst.DBInstanceIdentifier] = p.inst;
    tags[p.inst.DBInstanceArn] = p.tags;
  }
  return { instances, tags };
}

// ── naming & validation ─────────────────────────────────────────────────────

test("each PR maps to its own database identifier", () => {
  assert.equal(dbIdentifier(12), "remit-preview-pr-12");
  assert.notEqual(dbIdentifier(12), dbIdentifier(13));
});

test("rejects pull request numbers that are not plain integers", () => {
  for (const bad of ["", "0", "-1", "1; rm -rf /", "12abc", "1e3", "1234567890", undefined]) {
    assert.throws(() => dbIdentifier(bad), /invalid pull request number/, String(bad));
  }
});

test("ttl defaults to 72h and is bounded", () => {
  assert.equal(parseTtlHours(undefined), 72);
  assert.equal(parseTtlHours("24"), 24);
  assert.throws(() => parseTtlHours("0"));
  assert.throws(() => parseTtlHours("169"));
  assert.throws(() => parseTtlHours("abc"));
});

test("tags carry the preview convention, TTL expiry and cost-allocation tags", () => {
  const tags = previewTags({ pr: 5, now: NOW, ttlHours: 48 });
  assert.equal(tags.Preview, "true");
  assert.equal(tags.PreviewPR, "5");
  assert.equal(tags.PreviewCreatedAt, "2026-10-01T10:00:00Z");
  assert.equal(tags.PreviewExpiresAt, "2026-10-03T10:00:00Z");
  for (const key of ["Service", "Environment", "Owner", "CostCenter"]) assert.ok(tags[key], key);
});

// ── provisioning ────────────────────────────────────────────────────────────

test("provision restores an isolated, private, IAM-auth database from the snapshot", async () => {
  const { aws, calls } = fakeAws();
  const result = await provision({ aws, now: () => NOW, pr: 7, snapshotId: "anon-snap", env: {} });

  assert.equal(result.created, true);
  assert.equal(result.id, "remit-preview-pr-7");
  const restore = calls.find((c) => c[1] === "restore-db-instance-from-db-snapshot");
  assert.ok(restore);
  assert.ok(restore.includes("--no-publicly-accessible"));
  assert.ok(restore.includes("--enable-iam-database-authentication"));
  assert.equal(restore[restore.indexOf("--db-snapshot-identifier") + 1], "anon-snap");
  assert.equal(restore[restore.indexOf("--db-instance-identifier") + 1], "remit-preview-pr-7");
  assert.ok(restore.includes("Key=PreviewExpiresAt,Value=2026-10-04T10:00:00Z"));
});

test("two PRs get two different databases", async () => {
  const fake = fakeAws();
  await provision({ aws: fake.aws, now: () => NOW, pr: 1, snapshotId: "s", env: {} });
  await provision({ aws: fake.aws, now: () => NOW, pr: 2, snapshotId: "s", env: {} });
  assert.deepEqual(Object.keys(fake.db).sort(), ["remit-preview-pr-1", "remit-preview-pr-2"]);
});

test("provision is idempotent: a second run reuses the database", async () => {
  const fake = fakeAws();
  await provision({ aws: fake.aws, now: () => NOW, pr: 3, snapshotId: "s", env: {} });
  const second = await provision({ aws: fake.aws, now: () => NOW, pr: 3, snapshotId: "s", env: {} });
  assert.equal(second.created, false);
  assert.equal(fake.calls.filter((c) => c[1] === "restore-db-instance-from-db-snapshot").length, 1);
});

test("provision picks the newest available snapshot of the source instance", async () => {
  const { aws, calls } = fakeAws({
    snapshots: [
      { DBSnapshotIdentifier: "old", Status: "available", SnapshotCreateTime: "2026-09-01T00:00:00Z" },
      { DBSnapshotIdentifier: "new", Status: "available", SnapshotCreateTime: "2026-09-20T00:00:00Z" },
      { DBSnapshotIdentifier: "creating", Status: "creating", SnapshotCreateTime: "2026-09-30T00:00:00Z" },
    ],
  });
  await provision({ aws, now: () => NOW, pr: 4, sourceInstance: "staging-db", env: {} });
  const restore = calls.find((c) => c[1] === "restore-db-instance-from-db-snapshot");
  assert.equal(restore[restore.indexOf("--db-snapshot-identifier") + 1], "new");
});

test("provision fails clearly without a snapshot source", async () => {
  await assert.rejects(provision({ aws: fakeAws().aws, pr: 9, env: {} }), /--snapshot or --source-instance/);
});

test("network placement comes from the environment", async () => {
  const { aws, calls } = fakeAws();
  await provision({
    aws, now: () => NOW, pr: 8, snapshotId: "s",
    env: { PREVIEW_DB_SUBNET_GROUP: "private", PREVIEW_DB_SECURITY_GROUP_IDS: "sg-1,sg-2", PREVIEW_DB_INSTANCE_CLASS: "db.t4g.small" },
  });
  const restore = calls.find((c) => c[1] === "restore-db-instance-from-db-snapshot");
  assert.equal(restore[restore.indexOf("--db-subnet-group-name") + 1], "private");
  assert.deepEqual(restore.slice(restore.indexOf("--vpc-security-group-ids") + 1, restore.indexOf("--vpc-security-group-ids") + 3), ["sg-1", "sg-2"]);
  assert.equal(restore[restore.indexOf("--db-instance-class") + 1], "db.t4g.small");
});

// ── credentials ─────────────────────────────────────────────────────────────

test("bootstrap SQL creates an IAM-only role and refuses unsafe identifiers", () => {
  const sql = bootstrapSql({ dbName: "remitmortgage", masterUser: "postgres" });
  assert.match(sql, /GRANT rds_iam TO preview_app/);
  assert.doesNotMatch(sql, /PASSWORD/i);
  assert.throws(() => bootstrapSql({ dbName: 'x"; DROP DATABASE y; --', masterUser: "postgres" }), /unsafe/);
});

test("bootstrap uses a one-time password, then rotates it to an unknown value", async () => {
  const fake = fakeAws(seed(preview(11, null)));
  const seen = [];
  await bootstrap({ aws: fake.aws, pr: 11, psql: async (opts) => seen.push(opts) });

  const passwords = fake.calls
    .filter((c) => c[1] === "modify-db-instance")
    .map((c) => c[c.indexOf("--master-user-password") + 1]);
  assert.equal(passwords.length, 2);
  assert.notEqual(passwords[0], passwords[1]);
  assert.equal(seen[0].password, passwords[0]);
  assert.equal(seen[0].user, "postgres");
});

test("bootstrap rotates the master password even when the SQL fails", async () => {
  const fake = fakeAws(seed(preview(12, null)));
  await assert.rejects(bootstrap({ aws: fake.aws, pr: 12, psql: async () => { throw new Error("boom"); } }), /boom/);
  assert.equal(fake.calls.filter((c) => c[1] === "modify-db-instance").length, 2);
});

test("random passwords are unique and URL/SQL safe", () => {
  const a = randomPassword();
  assert.notEqual(a, randomPassword());
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("the connection URL carries a URL-encoded IAM token, not a stored password", async () => {
  const fake = fakeAws(seed(preview(13, null)));
  const url = await connectionUrl({ aws: fake.aws, pr: 13, region: "us-east-1" });
  assert.match(url, new RegExp(`^postgresql://${APP_ROLE}:`));
  assert.ok(url.includes(encodeURIComponent("a/b+c=")));
  assert.match(url, /sslmode=require$/);
  const call = fake.calls.find((c) => c[1] === "generate-db-auth-token");
  assert.equal(call[call.indexOf("--username") + 1], APP_ROLE);
});

// ── teardown & TTL ──────────────────────────────────────────────────────────

test("teardown deletes the PR's database", async () => {
  const fake = fakeAws(seed(preview(20, "2026-12-01T00:00:00Z")));
  const result = await teardown({ aws: fake.aws, pr: 20 });
  assert.deepEqual(result.removed, [{ pr: "20", id: "remit-preview-pr-20" }]);
  assert.deepEqual(Object.keys(fake.db), []);
  const del = fake.calls.find((c) => c[1] === "delete-db-instance");
  assert.ok(del.includes("--skip-final-snapshot"));
  assert.ok(del.includes("--delete-automated-backups"));
});

test("teardown with no database is a successful no-op", async () => {
  const result = await teardown({ aws: fakeAws().aws, pr: 21 });
  assert.deepEqual(result.removed, []);
});

test("teardown refuses to delete a database that is not tagged as that PR's preview", async () => {
  const p = preview(22, null);
  p.tags = [{ Key: "Environment", Value: "production" }];
  const fake = fakeAws(seed(p));
  await assert.rejects(teardown({ aws: fake.aws, pr: 22 }), /refusing to delete/);
  assert.equal(fake.calls.some((c) => c[1] === "delete-db-instance"), false);
});

test("sweep deletes only previews whose TTL has expired", async () => {
  const fake = fakeAws(seed(
    preview(30, "2026-09-30T10:00:00Z"), // expired
    preview(31, "2026-10-02T10:00:00Z"), // still live
    preview(32, null),                   // no TTL tag: left alone
  ));
  const result = await sweep({ aws: fake.aws, now: () => NOW });
  assert.deepEqual(result.removed, [{ pr: "30", id: "remit-preview-pr-30" }]);
  assert.deepEqual(Object.keys(fake.db).sort(), ["remit-preview-pr-31", "remit-preview-pr-32"]);
});

test("sweep never touches databases outside the preview naming convention", async () => {
  const staging = {
    inst: { DBInstanceIdentifier: "staging-db", DBInstanceArn: "arn:aws:rds:us-east-1:1:db:staging-db", Endpoint: { Address: "h", Port: 5432 } },
    tags: [{ Key: "Preview", Value: "true" }, { Key: "PreviewExpiresAt", Value: "2000-01-01T00:00:00Z" }],
  };
  const fake = fakeAws(seed(staging));
  const result = await sweep({ aws: fake.aws, now: () => NOW });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(Object.keys(fake.db), ["staging-db"]);
});

test("sweep is idempotent when an instance disappears mid-run", async () => {
  const fake = fakeAws(seed(preview(40, "2026-09-30T10:00:00Z")));
  const original = fake.aws;
  const racing = async (args) => {
    if (args[1] === "delete-db-instance") throw notFound();
    return original(args);
  };
  assert.deepEqual((await sweep({ aws: racing, now: () => NOW })).removed, []);
});
