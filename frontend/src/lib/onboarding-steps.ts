// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Contractor onboarding checklist model.
 *
 * A contractor must complete five steps before they can receive milestone
 * disbursements: profile, documents, license, payout setup, and finally the
 * admin review. This module owns the step definitions, the per-step status
 * vocabulary, and the pure helpers that derive the overall state from the
 * individual step statuses.
 */

export type OnboardingStepStatus =
  "not_started" | "in_progress" | "pending_review" | "approved" | "rejected";

/** Who acts next on a step. */
export type OnboardingStepOwner = "contractor" | "admin";

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  /** The party responsible for the next action on this step. */
  owner: OnboardingStepOwner;
  /** Human-readable turnaround expectation, e.g. "1–2 business days". */
  expectedTurnaround: string;
  status: OnboardingStepStatus;
  /** The concrete next action the reader should take, or null when done. */
  nextAction: string | null;
  /** In-app route (or anchor) for completing the step, when one exists. */
  linkHref: string | null;
  linkLabel: string | null;
  /** Reviewer notes left when a step is approved or rejected. */
  reviewNotes: string | null;
  /** ISO timestamp of the last status change. */
  updatedAt: string;
}

export interface OnboardingState {
  steps: OnboardingStep[];
}

/** Overall checklist state derived from the individual step statuses. */
export type OnboardingOverallStatus =
  "in_progress" | "action_required" | "ready_for_review" | "complete";

export const ONBOARDING_STEP_IDS = [
  "profile",
  "documents",
  "license",
  "payout",
  "admin-review",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const STATUS_LABELS: Record<OnboardingStepStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  pending_review: "Pending review",
  approved: "Approved",
  rejected: "Needs changes",
};

/**
 * The default checklist shown to a brand-new contractor: profile started,
 * everything else waiting.
 */
export function defaultOnboardingState(now: string = new Date().toISOString()): OnboardingState {
  return {
    steps: [
      {
        id: "profile",
        title: "Complete your contractor profile",
        description:
          "Legal name, business details, and contact information used for agreements and tax documents.",
        owner: "contractor",
        expectedTurnaround: "10–15 minutes",
        status: "in_progress",
        nextAction: "Finish the remaining profile fields and save.",
        linkHref: "/settings",
        linkLabel: "Open profile settings",
        reviewNotes: null,
        updatedAt: now,
      },
      {
        id: "documents",
        title: "Upload inspection documents",
        description:
          "Signed inspection reports and work photos for each active milestone, pinned to IPFS.",
        owner: "contractor",
        expectedTurnaround: "1–2 business days for review",
        status: "not_started",
        nextAction: "Upload at least one inspection document to submit for review.",
        linkHref: "/contractor",
        linkLabel: "Go to document uploads",
        reviewNotes: null,
        updatedAt: now,
      },
      {
        id: "license",
        title: "Verify your contractor license",
        description: "License number and issuing authority, validated against the public register.",
        owner: "contractor",
        expectedTurnaround: "2–3 business days for review",
        status: "not_started",
        nextAction: "Add your license number and upload the certificate.",
        linkHref: "/identity",
        linkLabel: "Open license verification",
        reviewNotes: null,
        updatedAt: now,
      },
      {
        id: "payout",
        title: "Set up USDC payout details",
        description:
          "Stellar payout address and asset confirmation used for milestone disbursements.",
        owner: "contractor",
        expectedTurnaround: "5–10 minutes",
        status: "not_started",
        nextAction: "Add and confirm your USDC payout address.",
        linkHref: "/contractor/payouts",
        linkLabel: "Set up payouts",
        reviewNotes: null,
        updatedAt: now,
      },
      {
        id: "admin-review",
        title: "Admin review and approval",
        description: "A protocol admin reviews your profile, documents, license, and payout setup.",
        owner: "admin",
        expectedTurnaround: "3–5 business days",
        status: "not_started",
        nextAction: "Complete every step above — review starts automatically.",
        linkHref: null,
        linkLabel: null,
        reviewNotes: null,
        updatedAt: now,
      },
    ],
  };
}

/** Steps the contractor must finish before admin review can begin. */
export function contractorOwnedSteps(state: OnboardingState): OnboardingStep[] {
  return state.steps.filter((step) => step.owner === "contractor");
}

/**
 * Derive the overall checklist status.
 *
 * - `action_required` — at least one step was rejected and needs rework.
 * - `complete` — every step (including admin review) is approved.
 * - `ready_for_review` — all contractor-owned steps are approved but the
 *   admin review has not finished yet.
 * - `in_progress` — anything else.
 */
export function getOverallStatus(state: OnboardingState): OnboardingOverallStatus {
  if (state.steps.some((step) => step.status === "rejected")) return "action_required";
  if (state.steps.length > 0 && state.steps.every((step) => step.status === "approved")) {
    return "complete";
  }
  const contractorDone = contractorOwnedSteps(state).every((step) => step.status === "approved");
  if (contractorDone) return "ready_for_review";
  return "in_progress";
}

/** Human-readable summary of the overall state, e.g. "2 of 4 steps complete". */
export function getOverallSummary(state: OnboardingState): string {
  const status = getOverallStatus(state);
  const contractorSteps = contractorOwnedSteps(state);
  const done = contractorSteps.filter((step) => step.status === "approved").length;

  switch (status) {
    case "complete":
      return "All steps complete — you are fully onboarded.";
    case "ready_for_review":
      return "Ready for review — all your steps are complete.";
    case "action_required":
      return "Action needed — some steps were sent back for changes.";
    case "in_progress":
    default:
      return `${done} of ${contractorSteps.length} steps complete.`;
  }
}

/**
 * Apply a status change (as an administrator would record it) and return the
 * new state. Rejected steps always carry reviewer notes explaining the change.
 */
export function applyStatusChange(
  state: OnboardingState,
  stepId: string,
  status: OnboardingStepStatus,
  options: { reviewNotes?: string | null; now?: string } = {}
): OnboardingState {
  const now = options.now ?? new Date().toISOString();
  return {
    steps: state.steps.map((step) => {
      if (step.id !== stepId) return step;

      const reviewNotes =
        status === "rejected"
          ? (options.reviewNotes ?? "Please review the feedback and resubmit.")
          : status === "approved"
            ? (options.reviewNotes ?? null)
            : null;

      return {
        ...step,
        status,
        reviewNotes,
        nextAction: nextActionForStatus(step, status),
        updatedAt: now,
      };
    }),
  };
}

/** Recompute a step's `nextAction` text for a given status. */
export function nextActionForStatus(
  step: OnboardingStep,
  status: OnboardingStepStatus
): string | null {
  switch (status) {
    case "approved":
      return null;
    case "rejected":
      return "Review the feedback below and resubmit this step.";
    case "pending_review":
      return step.owner === "admin"
        ? "An admin will review this step shortly."
        : "Submitted — waiting for admin review.";
    case "in_progress":
      return "Finish this step and submit it for review.";
    case "not_started":
    default:
      return step.owner === "admin"
        ? "Starts automatically once all contractor steps are complete."
        : "Start this step to continue onboarding.";
  }
}
