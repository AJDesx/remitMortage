// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Restores the most recently uploaded encrypted backup into whatever
 * database DATABASE_URL points at.
 *
 * This is the "actually exercise production recovery" half of the backup
 * restore drill (docs/BACKUP_RESTORE_DRILL.md): instead of restoring a
 * freshly-seeded throwaway dump, it finds the real latest object under
 * backups/ in the configured bucket and restores exactly that — the same
 * object a real incident would restore from.
 *
 * DATABASE_URL must point at a disposable sandbox database — restoreFromBackup
 * runs `pg_restore -c`, which drops and recreates every object it finds in
 * the dump.
 *
 *   npx tsx scripts/restore-latest-backup.ts [--out <path>]
 *
 * On success, writes { backupKey, restoredAt } as JSON to --out (default
 * backup-drill-restored.json) so the sanity-check step and the drill-history
 * log can record which backup was actually drilled.
 */

import { writeFileSync } from "fs";
import { createBackupService } from "../src/services/databaseBackup.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const outPath = argValue("--out") ?? "backup-drill-restored.json";

  if (!process.env.DATABASE_URL) {
    console.error("✗ DATABASE_URL must be set to the sandbox database to restore into.");
    process.exit(2);
  }

  const decryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
  if (!decryptionKey) {
    console.error("✗ BACKUP_ENCRYPTION_KEY must be set — it's the key backups were encrypted with.");
    process.exit(2);
  }

  const backupService = createBackupService();

  const backupKey = await backupService.getLatestBackupKey();
  if (!backupKey) {
    console.error("✗ No backup objects found under backups/ in the configured bucket — nothing to drill.");
    process.exit(2);
  }

  console.log(`▶ Restoring latest backup: ${backupKey}`);
  await backupService.restoreFromBackup(backupKey, decryptionKey);

  const restoredAt = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify({ backupKey, restoredAt }, null, 2));
  console.log(`✓ Restore completed. backupKey=${backupKey} restoredAt=${restoredAt}`);
}

main().catch((error) => {
  console.error("✗ Restore drill failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
