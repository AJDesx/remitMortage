"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, FileText, Loader2, UserRound } from "lucide-react";
import {
  getOverallStatus,
  getOverallSummary,
  STATUS_LABELS,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingStepStatus,
} from "@/lib/onboarding-steps";

const STATUS_STYLES: Record<OnboardingStepStatus, string> = {
  not_started: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  in_progress: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  pending_review: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/10 text-red-400 border-red-500/30",
};

const STATUS_ICONS: Record<OnboardingStepStatus, React.ReactNode> = {
  not_started: <Clock className="w-3.5 h-3.5" aria-hidden="true" />,
  in_progress: <Loader2 className="w-3.5 h-3.5" aria-hidden="true" />,
  pending_review: <Loader2 className="w-3.5 h-3.5" aria-hidden="true" />,
  approved: <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />,
  rejected: <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />,
};

const OVERALL_STYLES: Record<string, string> = {
  complete: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  ready_for_review: "border-cyan-500/40 bg-cyan-500/10 text-cyan-400",
  action_required: "border-red-500/40 bg-red-500/10 text-red-400",
  in_progress: "border-slate-600 bg-slate-800/60 text-slate-300",
};

interface OnboardingChecklistProps {
  state: OnboardingState;
  /**
   * Called when a status changes — either by the contractor submitting a
   * step or an admin reviewing it. The page uses this to persist state and
   * notify the contractor.
   */
  onStatusChange: (stepId: string, status: OnboardingStepStatus, notes?: string) => void;
  /**
   * When true, each step renders admin review controls (approve / request
   * changes). Used by the admin review panel.
   */
  showReviewActions?: boolean;
}

/** One row of the checklist: status, owner, turnaround, next action, links. */
function ChecklistStep({
  step,
  onStatusChange,
  showReviewActions,
}: {
  step: OnboardingStep;
  onStatusChange: OnboardingChecklistProps["onStatusChange"];
  showReviewActions: boolean;
}) {
  const complete = step.status === "approved";
  const actionable = !complete && step.linkHref;

  return (
    <li
      data-testid={`onboarding-step-${step.id}`}
      className={`rounded-xl border p-5 transition-colors ${
        complete
          ? "border-emerald-500/25 bg-emerald-500/[0.04]"
          : step.status === "rejected"
            ? "border-red-500/30 bg-red-500/[0.05]"
            : "border-slate-700 bg-[#0b0f1d]"
      }`}
    >
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 mb-1.5">
            <h3 className="text-white font-semibold">{step.title}</h3>
            <span
              data-testid={`onboarding-status-${step.id}`}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider border ${STATUS_STYLES[step.status]}`}
            >
              {STATUS_ICONS[step.status]}
              {STATUS_LABELS[step.status]}
            </span>
          </div>
          <p className="text-sm text-slate-400 mb-2">{step.description}</p>

          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-500">
            <div className="flex items-center gap-1.5">
              <UserRound className="w-3.5 h-3.5" aria-hidden="true" />
              <dt className="sr-only">Assigned to</dt>
              <dd>
                Owner: <span className="text-slate-300">{step.owner === "admin" ? "Admin" : "You"}</span>
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" aria-hidden="true" />
              <dt className="sr-only">Expected turnaround</dt>
              <dd>
                Turnaround: <span className="text-slate-300">{step.expectedTurnaround}</span>
              </dd>
            </div>
          </dl>

          {step.nextAction && (
            <p className="mt-2 text-sm text-slate-300">
              <span className="font-semibold text-slate-400">Next action: </span>
              {step.nextAction}
            </p>
          )}

          {step.status === "rejected" && step.reviewNotes && (
            <div
              data-testid={`onboarding-review-notes-${step.id}`}
              className="mt-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs text-red-300"
            >
              <span className="font-semibold uppercase tracking-wider">Review notes: </span>
              {step.reviewNotes}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          {actionable && (
            <Link
              href={step.linkHref!}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/20 transition-colors"
            >
              <FileText className="w-4 h-4" aria-hidden="true" />
              {step.linkLabel ?? "Open step"}
            </Link>
          )}

          {showReviewActions && step.status !== "approved" && (
            <div className="flex gap-2">
              <button
                type="button"
                data-testid={`onboarding-approve-${step.id}`}
                onClick={() => onStatusChange(step.id, "approved")}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
              >
                Approve
              </button>
              <button
                type="button"
                data-testid={`onboarding-reject-${step.id}`}
                onClick={() =>
                  onStatusChange(
                    step.id,
                    "rejected",
                    "Submitted material did not meet the review requirements — please update and resubmit."
                  )
                }
                className="px-3 py-2 rounded-lg text-sm font-medium bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors"
              >
                Request changes
              </button>
            </div>
          )}

          {complete && !showReviewActions && (
            <span className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-emerald-400">
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              Complete
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Contractor onboarding checklist. Renders each step with its status, owner,
 * expected turnaround, and next action; surfaces review notes for rejected
 * steps; and announces every status change to screen readers.
 */
export default function OnboardingChecklist({
  state,
  onStatusChange,
  showReviewActions = false,
}: OnboardingChecklistProps) {
  const overall = getOverallStatus(state);
  const summary = getOverallSummary(state);
  const [announcement, setAnnouncement] = useState("");
  const previousStatuses = useRef<Record<string, OnboardingStepStatus>>({});

  // Announce status transitions (screen readers pick this up via aria-live).
  useEffect(() => {
    const changed = state.steps
      .filter((step) => previousStatuses.current[step.id] && previousStatuses.current[step.id] !== step.status)
      .map((step) => `${step.title}: ${STATUS_LABELS[step.status]}`);
    if (changed.length > 0) {
      setAnnouncement(`Onboarding updated. ${changed.join(". ")}.`);
    }
    previousStatuses.current = Object.fromEntries(state.steps.map((step) => [step.id, step.status]));
  }, [state.steps]);

  return (
    <section aria-label="Onboarding checklist">
      <div
        data-testid="onboarding-overall-status"
        className={`mb-6 rounded-xl border p-4 ${OVERALL_STYLES[overall]}`}
      >
        <p className="font-semibold">{summary}</p>
        {overall === "ready_for_review" && (
          <p className="text-sm mt-1 opacity-90">
            Your profile, documents, license, and payout setup are complete. An admin will finish
            the final review shortly — you don&apos;t need to do anything else.
          </p>
        )}
      </div>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      <ol className="space-y-4">
        {state.steps.map((step) => (
          <ChecklistStep
            key={step.id}
            step={step}
            onStatusChange={onStatusChange}
            showReviewActions={showReviewActions}
          />
        ))}
      </ol>
    </section>
  );
}
