// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Help Center content and search.
 *
 * Articles are authored in Markdown (see `body`) and indexed by
 * {@link searchArticles}, which ranks exact title matches above title
 * keyword matches and body matches. Contextual flows embed deep links to
 * specific articles via {@link CONTEXTUAL_HELP}.
 */

export type HelpCategory = "Borrowing" | "Verification" | "Contractor" | "Admin";

export interface HelpArticle {
  slug: string;
  title: string;
  category: HelpCategory;
  /** Short plain-text summary shown in search results and listings. */
  summary: string;
  /** Search keywords beyond title and body content. */
  keywords: string[];
  /** Article content, written in Markdown. */
  body: string;
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: "apply-for-a-loan",
    title: "How to apply for a loan",
    category: "Borrowing",
    summary:
      "Submit a loan application from the Apply page, track its status, and understand what reviewers need.",
    keywords: ["loan", "application", "apply", "borrow", "financing", "request"],
    body: `## Before you start

Make sure your escrow savings target is set and your identity verification is complete. Applications from unverified wallets are returned without review.

## Submit an application

1. Open the **Apply** page from the main navigation.
2. Enter the amount you want to request in USDC.
3. Press **Submit application**.

You will see a confirmation message under the form and the request will appear in *Application history* with its current status.

## After you submit

- **Pending** — your application is in the reviewer queue.
- **Approved** — underwriting accepted the request; disbursement follows.
- **Rejected** — a reviewer left a reason; you can fix the issue and re-apply.

> Tip: the admin review team can see your verification score, so completing KYC early speeds things up.

## Need more help?

If the form shows an error you don't understand, check the field guidance in the form itself, or browse the Verification articles.`,
  },
  {
    slug: "verification-requirements",
    title: "Verification and KYC requirements",
    category: "Verification",
    summary:
      "What identity data we collect, why underwriting needs it, and how to fix a failed verification.",
    keywords: ["kyc", "identity", "verification", "verify", "aml", "documents", "failed"],
    body: `## Why verification exists

RemitMortgage is a regulated lending protocol. Every borrower completes identity verification (KYC) before a loan application can be reviewed.

## What you need

- A government-issued identity document.
- A liveness selfie match.
- A wallet address you control.

## Fixing a failed verification

1. Open the **Verify** page.
2. Review the status shown for each check.
3. Re-submit any check marked *Failed* with clearer documents.

Most failures come from glare on the document photo or an expired document. Re-uploading usually fixes it within one review cycle.`,
  },
  {
    slug: "upload-contractor-documents",
    title: "Uploading contractor documents",
    category: "Contractor",
    summary:
      "Upload inspection evidence and license documents from the Contractor portal and track review status.",
    keywords: ["contractor", "upload", "documents", "evidence", "inspection", "ipfs", "license"],
    body: `## Where to upload

Open the **Contractor** portal. Each milestone shows an upload area for inspection evidence. Files are pinned to IPFS and the content identifier (CID) is recorded on-chain.

## Accepted documents

- Signed inspection reports (PDF).
- Photos of completed work (JPG/PNG, up to 10 MB).
- Municipal permits and license certificates.

## After uploading

A reviewer validates the evidence before a disbursement vote opens. You can follow the review state on the **Onboarding checklist** page under *Documents*.

> Keep file names descriptive — reviewers often search by property address or milestone name.`,
  },
  {
    slug: "payout-setup",
    title: "Setting up USDC payouts",
    category: "Contractor",
    summary: "Connect a payout wallet, confirm the asset, and test a small transfer first.",
    keywords: ["payout", "wallet", "usdc", "disbursement", "setup", "bank", "transfer"],
    body: `## Connect your payout wallet

1. Open **Contractor → Payouts**.
2. Add the Stellar address that should receive disbursements.
3. Confirm the asset code is **USDC** on Testnet before going live.

## Recommended first step

Send yourself a small test payout and confirm it arrives before the first milestone disbursement.

## Troubleshooting

- **Payout shows pending** — the multisig vote for the milestone has not closed yet.
- **Wrong network** — switch your wallet to the network shown in the app banner.`,
  },
  {
    slug: "admin-review-process",
    title: "How the admin review process works",
    category: "Admin",
    summary:
      "Reviewer queue stages, bulk actions, reassignment, and what each status change means for applicants.",
    keywords: ["admin", "review", "approval", "queue", "underwriting", "bulk", "reassign"],
    body: `## The reviewer queue

Admins manage pending applications on the **Admin** page. Loans move through *submitted → underwriting → approved → disbursing*.

## Taking action on a loan

- **Approve** — accepts the application and moves it to the next stage. Confirm in the dialog.
- **Reject** — returns the application with a reason the applicant can see.
- **Discuss** — open the comment panel to leave internal notes tied to the application.

## Bulk actions

Select several loans with the checkboxes, then use the sticky toolbar to bulk approve, bulk reject, or reassign them to another reviewer wallet.

## Expectations for applicants

Applicants receive in-app notifications for every status change, so always leave a reason when rejecting.`,
  },
  {
    slug: "repayments-and-statements",
    title: "Repayments and statements",
    category: "Borrowing",
    summary: "Make a repayment, download CSV/PDF statements, and reconcile them at tax time.",
    keywords: ["repay", "repayment", "statement", "csv", "pdf", "tax", "interest", "history"],
    body: `## Making a repayment

Open the **Repay** page, enter the amount, and confirm the transaction in your wallet. Overpayment is applied to the next scheduled cycle.

## Statements

- The **History** page exports your transaction ledger as CSV.
- The **Statements** section generates interest statements as PDF for tax time.

Both exports reflect the filters currently applied on screen, so set your date range before exporting.`,
  },
];

/**
 * Contextual help mapping: flows embed a {@link HelpLink} keyed by context so
 * forms and review screens point at the right article.
 */
export const CONTEXTUAL_HELP: Record<string, string> = {
  "loan-application": "apply-for-a-loan",
  "identity-verification": "verification-requirements",
  "document-upload": "upload-contractor-documents",
  "payout-setup": "payout-setup",
  "admin-review": "admin-review-process",
  repayments: "repayments-and-statements",
};

export function findHelpArticle(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((article) => article.slug === slug);
}

/** Resolve the article slug for a contextual help key, if one exists. */
export function contextualHelpSlug(context: string): string | undefined {
  return CONTEXTUAL_HELP[context];
}

export interface HelpSearchResult {
  article: HelpArticle;
  score: number;
}

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function tokenize(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

/**
 * Rank articles for a query. Scoring favours exact title matches, then title
 * keyword matches, then summary/keyword matches, then body matches. Results
 * are returned best-first; an empty query returns no results.
 */
export function searchArticles(
  query: string,
  articles: HelpArticle[] = HELP_ARTICLES
): HelpSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: HelpSearchResult[] = [];

  for (const article of articles) {
    const title = normalize(article.title);
    const summary = normalize(article.summary);
    const keywords = article.keywords.map(normalize);
    const body = normalize(article.body);

    let score = 0;

    for (const token of tokens) {
      if (title === token) score += 100;
      else if (title.startsWith(token)) score += 60;
      else if (title.includes(token)) score += 40;

      if (keywords.includes(token)) score += 30;
      else if (keywords.some((k) => k.includes(token))) score += 15;

      if (summary.includes(token)) score += 10;
      if (body.includes(token)) score += 5;
    }

    // A result must match at least one token somewhere to be listed.
    if (score > 0) results.push({ article, score });
  }

  return results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.article.title.localeCompare(b.article.title);
  });
}
