"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { useWallet } from "@/context/WalletContext";
import { useNotifications } from "@/context/NotificationContext";
import OnboardingChecklist from "@/components/onboarding/OnboardingChecklist";
import HelpLink from "@/components/help/HelpLink";
import {
  applyStatusChange,
  defaultOnboardingState,
  getOverallStatus,
  type OnboardingState,
  type OnboardingStepStatus,
} from "@/lib/onboarding-steps";

const Navbar = dynamic(() => import("@/components/Navbar"), { ssr: false });

const STORAGE_KEY = "contractor-onboarding-state";

/** Admin wallet allowed to review onboarding steps (mirrors the admin page). */
function getAdminAddress(): string {
  return process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "";
}

function loadState(): OnboardingState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as OnboardingState;
      if (Array.isArray(parsed.steps) && parsed.steps.length > 0) return parsed;
    }
  } catch {
    // storage unavailable — fall through to defaults
  }
  return defaultOnboardingState();
}

export default function ContractorOnboardingPage() {
  return <ContractorOnboardingInner />;
}

function ContractorOnboardingInner() {
  const { publicKey } = useWallet();
  const { notify } = useNotifications();
  const [state, setState] = useState<OnboardingState | null>(null);

  useEffect(() => {
    setState(loadState());
  }, []);

  const handleStatusChange = useCallback(
    (stepId: string, status: OnboardingStepStatus, notes?: string) => {
      setState((current) => {
        if (!current) return current;
        const previousOverall = getOverallStatus(current);
        const next = applyStatusChange(current, stepId, status, { reviewNotes: notes ?? null });
        const step = next.steps.find((candidate) => candidate.id === stepId);
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // non-fatal
        }

        if (step) {
          const title = `Onboarding step ${status === "approved" ? "approved" : status === "rejected" ? "rejected" : "updated"}`;
          const message =
            status === "rejected"
              ? `“${step.title}” was sent back for changes: ${step.reviewNotes}`
              : status === "approved"
                ? `“${step.title}” was approved.`
                : `“${step.title}” is now ${step.status.replace("_", " ")}.`;
          notify({
            variant: status === "rejected" ? "error" : status === "approved" ? "success" : "info",
            title,
            message,
          });
        }

        const nextOverall = getOverallStatus(next);
        if (nextOverall !== previousOverall && nextOverall === "ready_for_review") {
          notify({
            variant: "success",
            title: "Ready for review",
            message: "All of your onboarding steps are complete. An admin will finish the final review shortly.",
          });
        }

        return next;
      });
    },
    [notify]
  );

  const isAdmin =
    !!publicKey && !!getAdminAddress() && publicKey.toLowerCase() === getAdminAddress().toLowerCase();

  return (
    <main
      data-testid="contractor-onboarding-page"
      className="min-h-screen bg-[#060913] text-slate-100 pb-20"
    >
      <Navbar />

      <div className="pt-32 px-6 max-w-4xl mx-auto">
        <nav aria-label="Breadcrumb" className="mb-6">
          <Link
            href="/contractor"
            className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-cyan-400 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Contractor portal
          </Link>
        </nav>

        <header className="mb-8">
          <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-4 border border-cyan-500/20">
            <ClipboardCheck className="w-3.5 h-3.5" aria-hidden="true" />
            Onboarding
          </span>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white mb-3">
            Contractor onboarding checklist
          </h1>
          <p className="text-slate-400 text-sm md:text-base max-w-2xl">
            Complete every step below to become eligible for milestone disbursements. Each step
            shows who owns it, how long review takes, and exactly what to do next.
          </p>
          <div className="mt-3">
            <HelpLink context="document-upload" />
          </div>
        </header>

        {isAdmin && (
          <p
            data-testid="onboarding-reviewer-notice"
            className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300"
          >
            You are connected with the admin wallet — review controls are shown on each step.
          </p>
        )}

        {state === null ? (
          <p className="text-sm text-slate-500">Loading checklist…</p>
        ) : (
          <OnboardingChecklist
            state={state}
            onStatusChange={handleStatusChange}
            showReviewActions={isAdmin}
          />
        )}
      </div>
    </main>
  );
}
