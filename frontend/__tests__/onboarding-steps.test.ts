// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  applyStatusChange,
  contractorOwnedSteps,
  defaultOnboardingState,
  getOverallStatus,
  getOverallSummary,
  type OnboardingState,
} from "../src/lib/onboarding-steps";

function stateWithStatuses(
  statuses: Record<string, string>,
  now = "2026-04-15T00:00:00.000Z"
): OnboardingState {
  const base = defaultOnboardingState(now);
  return {
    steps: base.steps.map((step) =>
      statuses[step.id] ? { ...step, status: statuses[step.id] as any } : step
    ),
  };
}

const ALL_APPROVED = {
  profile: "approved",
  documents: "approved",
  license: "approved",
  payout: "approved",
  "admin-review": "approved",
};

const CONTRACTOR_DONE = {
  profile: "approved",
  documents: "approved",
  license: "approved",
  payout: "approved",
  "admin-review": "not_started",
};

describe("defaultOnboardingState", () => {
  it("includes all five required steps", () => {
    const { steps } = defaultOnboardingState();
    expect(steps.map((s) => s.id)).toEqual([
      "profile",
      "documents",
      "license",
      "payout",
      "admin-review",
    ]);
  });

  it("gives every step an owner, turnaround and next action", () => {
    for (const step of defaultOnboardingState().steps) {
      expect(step.owner).toMatch(/contractor|admin/);
      expect(step.expectedTurnaround).toBeTruthy();
      expect(step.nextAction).toBeTruthy();
    }
  });
});

describe("getOverallStatus", () => {
  it("is in progress for the default state", () => {
    expect(getOverallStatus(defaultOnboardingState())).toBe("in_progress");
  });

  it("is ready for review when all contractor steps are approved", () => {
    expect(getOverallStatus(stateWithStatuses(CONTRACTOR_DONE))).toBe("ready_for_review");
  });

  it("is complete when every step is approved", () => {
    expect(getOverallStatus(stateWithStatuses(ALL_APPROVED))).toBe("complete");
  });

  it("flags action required when one step is rejected", () => {
    expect(
      getOverallStatus(stateWithStatuses({ ...CONTRACTOR_DONE, documents: "rejected" }))
    ).toBe("action_required");
  });

  it("handles a mixed state: one pending, one rejected, others approved", () => {
    const mixed = stateWithStatuses({
      profile: "approved",
      documents: "rejected",
      license: "pending_review",
      payout: "approved",
      "admin-review": "not_started",
    });
    expect(getOverallStatus(mixed)).toBe("action_required");
  });

  it("is in progress when one contractor step is still pending review", () => {
    const pending = stateWithStatuses({
      ...CONTRACTOR_DONE,
      documents: "pending_review",
    });
    // documents is not approved yet, so not ready for review
    expect(getOverallStatus(pending)).toBe("in_progress");
  });
});

describe("getOverallSummary", () => {
  it("summarises progress with counts", () => {
    const state = stateWithStatuses({ profile: "approved" });
    expect(getOverallSummary(state)).toBe("1 of 4 steps complete.");
  });

  it("announces the ready-for-review state", () => {
    expect(getOverallSummary(stateWithStatuses(CONTRACTOR_DONE))).toMatch(/ready for review/i);
  });
});

describe("applyStatusChange", () => {
  it("approves a step, clears its next action, and stamps the time", () => {
    const next = applyStatusChange(defaultOnboardingState(), "documents", "approved", {
      now: "2026-05-01T00:00:00.000Z",
    });
    const step = next.steps.find((s) => s.id === "documents")!;
    expect(step.status).toBe("approved");
    expect(step.nextAction).toBeNull();
    expect(step.updatedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("stores reviewer notes when a step is rejected", () => {
    const next = applyStatusChange(defaultOnboardingState(), "license", "rejected", {
      reviewNotes: "License number does not match the register.",
    });
    const step = next.steps.find((s) => s.id === "license")!;
    expect(step.status).toBe("rejected");
    expect(step.reviewNotes).toBe("License number does not match the register.");
    expect(step.nextAction).toMatch(/resubmit/i);
  });

  it("does not mutate the original state", () => {
    const original = defaultOnboardingState();
    applyStatusChange(original, "profile", "approved");
    expect(original.steps.find((s) => s.id === "profile")!.status).toBe("in_progress");
  });
});

describe("contractorOwnedSteps", () => {
  it("excludes the admin review step", () => {
    const owners = contractorOwnedSteps(defaultOnboardingState()).map((s) => s.owner);
    expect(owners).toEqual(["contractor", "contractor", "contractor", "contractor"]);
  });
});
