// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { loadConfig } from "../config.js";
import { prisma } from "../services/db.js";
import { sendEmail, getBrandedHtml } from "../services/email.js";
import { sendWebhook } from "../services/webhook.js";
import logger from "../utils/logger.js";

export type DataQualityCheck = { name: string; count: number };
export type DataQualityReport = {
  timestamp: string;
  status: "PASS" | "ALERT";
  threshold: number;
  totalViolations: number;
  checks: DataQualityCheck[];
  newViolations: DataQualityCheck[];
  previousTotal: number | null;
};

const ACTION = "SCHEDULED_DATA_QUALITY_AUDIT";
const safePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

/** Run read-only SQL checks against the live application schema. */
export async function runDataQualityChecks(
  client: typeof prisma = prisma,
  stuckHours = safePositiveInt(process.env.DATA_QUALITY_STUCK_HOURS, 72)
): Promise<DataQualityCheck[]> {
  const queries: Array<[string, Promise<Array<{ count: bigint | number }>>]> = [
    ["orphaned_loan_applications", client.$queryRaw`
      SELECT COUNT(*)::bigint AS count
      FROM "LoanApplication" l LEFT JOIN "Applicant" a ON a.id = l."applicantId"
      WHERE a.id IS NULL
    `],
    ["orphaned_borrower_events", client.$queryRaw`
      SELECT COUNT(*)::bigint AS count FROM (
        SELECT d."borrowerId" FROM "EscrowDeposit" d LEFT JOIN "Borrower" b ON b.id = d."borrowerId" WHERE b.id IS NULL
        UNION ALL
        SELECT w."borrowerId" FROM "EscrowWithdrawal" w LEFT JOIN "Borrower" b ON b.id = w."borrowerId" WHERE b.id IS NULL
        UNION ALL
        SELECT d."borrowerId" FROM "LoanDisbursement" d LEFT JOIN "Borrower" b ON b.id = d."borrowerId" WHERE b.id IS NULL
        UNION ALL
        SELECT r."borrowerId" FROM "LoanRepayment" r LEFT JOIN "Borrower" b ON b.id = r."borrowerId" WHERE b.id IS NULL
      ) orphaned
    `],
    ["impossible_loan_state", client.$queryRaw`
      SELECT COUNT(*)::bigint AS count FROM "LoanApplication"
      WHERE ("status" IN ('Approved', 'Disbursing', 'Repaying', 'Completed') AND "principal" <= 0)
         OR ("status" IN ('Draft', 'Pending') AND "autoRejectedAt" IS NOT NULL)
    `],
    ["negative_borrower_balances", client.$queryRaw`
      SELECT COUNT(*)::bigint AS count FROM "Borrower"
      WHERE (CASE WHEN "escrowBalance" ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN "escrowBalance"::numeric < 0 ELSE false END)
         OR (CASE WHEN "loanOutstanding" ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN "loanOutstanding"::numeric < 0 ELSE false END)
         OR (CASE WHEN "totalDeposited" ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN "totalDeposited"::numeric < 0 ELSE false END)
         OR (CASE WHEN "totalDisbursed" ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN "totalDisbursed"::numeric < 0 ELSE false END)
         OR (CASE WHEN "totalRepaid" ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN "totalRepaid"::numeric < 0 ELSE false END)
    `],
    ["stuck_loan_statuses", client.$queryRaw`
      SELECT COUNT(*)::bigint AS count FROM "LoanApplication"
      WHERE "deletedAt" IS NULL
        AND "status" IN ('Pending', 'Approved', 'Disbursing', 'Repaying')
        AND "statusUpdatedAt" < NOW() - (${stuckHours} * INTERVAL '1 hour')
    `],
  ];

  const results = await Promise.all(queries.map(([, query]) => query));
  return queries.map(([name], index) => ({
    name,
    count: Number(results[index][0]?.count ?? 0),
  }));
}

export async function runDataQualityAuditJob(): Promise<DataQualityReport> {
  const threshold = safePositiveInt(process.env.DATA_QUALITY_ALERT_THRESHOLD, 1);
  const checks = await runDataQualityChecks();
  const totalViolations = checks.reduce((sum, check) => sum + check.count, 0);

  let previousChecks: DataQualityCheck[] | null = null;
  try {
    const previous = await prisma.auditLog.findFirst({ where: { action: ACTION }, orderBy: { createdAt: "desc" } });
    const metadata = previous?.metadata as { checks?: DataQualityCheck[] } | null;
    if (Array.isArray(metadata?.checks)) previousChecks = metadata.checks;
  } catch (error) {
    logger.warn("[dataQualityAudit] Could not load previous run for trend comparison", { error });
  }

  const previousCounts = new Map((previousChecks ?? []).map((check) => [check.name, check.count]));
  const newViolations = checks.filter((check) => check.count > (previousCounts.get(check.name) ?? 0));
  const report: DataQualityReport = {
    timestamp: new Date().toISOString(),
    status: totalViolations >= threshold && totalViolations > 0 ? "ALERT" : "PASS",
    threshold,
    totalViolations,
    checks,
    newViolations,
    previousTotal: previousChecks ? previousChecks.reduce((sum, check) => sum + check.count, 0) : null,
  };

  // Persist both clean and failing summaries so operators can compare runs over time.
  await prisma.auditLog.create({
    data: {
      action: ACTION,
      actorAddress: "system:scheduler",
      metadata: report as any,
    },
  });

  if (report.status === "ALERT") {
    logger.warn("[dataQualityAudit] Data quality threshold exceeded", report);
    if (newViolations.length > 0) await dispatchDataQualityAlert(report);
  } else {
    logger.info("[dataQualityAudit] Data quality audit passed", report);
  }
  return report;
}

async function dispatchDataQualityAlert(report: DataQualityReport): Promise<void> {
  const config = loadConfig();
  const findings = report.checks.filter((check) => check.count > 0);
  const htmlRows = findings.map((check) => `<li><strong>${check.name}</strong>: ${check.count}</li>`).join("");
  const html = getBrandedHtml("Scheduled database data quality alert", `
    <h2>Data quality threshold exceeded</h2>
    <p>${report.totalViolations} violation(s) were detected; alert threshold is ${report.threshold}.</p>
    <ul>${htmlRows}</ul>
    <p>New or increased findings: ${report.newViolations.map((check) => `${check.name} (${check.count})`).join(", ") || "none"}.</p>
    <p>No data was modified. Review and remediate findings through the normal operational process.</p>
  `);
  const recipient = config.complianceAlertEmail || config.opsFallbackAlertEmail;
  if (recipient) {
    try {
      await sendEmail(recipient, `[Ops] Data quality audit: ${report.totalViolations} violation(s)`, html);
    } catch (error) {
      logger.error("[dataQualityAudit] Failed to send email alert", { error });
    }
  }
  const webhook = config.complianceSlackWebhookUrl || config.opsSlackWebhookUrl || config.alertWebhookUrl;
  if (webhook) {
    try {
      await sendWebhook(webhook, {
        text: `Database data quality audit detected ${report.totalViolations} violation(s).`,
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Database data quality alert" } },
          { type: "section", text: { type: "mrkdwn", text: findings.map((check) => `• *${check.name}*: ${check.count}`).join("\n") || "No findings" } },
          { type: "context", elements: [{ type: "mrkdwn", text: `Run: ${report.timestamp} · threshold: ${report.threshold} · new/increased: ${report.newViolations.map((check) => check.name).join(", ") || "none"}` }] },
        ],
      });
    } catch (error) {
      logger.error("[dataQualityAudit] Failed to send webhook alert", { error });
    }
  }
}
