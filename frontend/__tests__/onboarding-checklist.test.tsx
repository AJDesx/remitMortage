// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next/dynamic", () => () => () => null);
jest.mock("next/navigation", () => ({
  usePathname: () => "/contractor/onboarding",
  useParams: () => ({ slug: "payout-setup" }),
}));

type WalletState = { publicKey: string | null };

let walletState: WalletState = { publicKey: null };
jest.mock("../src/context/WalletContext", () => ({
  useWallet: () => walletState,
}));

let notifyCalls: Array<{ variant: string; title: string; message?: string }> = [];
jest.mock("../src/context/NotificationContext", () => ({
  useNotifications: () => ({
    notify: (input: { variant: string; title: string; message?: string }) => {
      notifyCalls.push(input);
      return "id";
    },
  }),
}));

import OnboardingChecklist from "../src/components/onboarding/OnboardingChecklist";
import ContractorOnboardingPage from "../src/app/contractor/onboarding/page";
import {
  applyStatusChange,
  defaultOnboardingState,
  type OnboardingState,
} from "../src/lib/onboarding-steps";

beforeEach(() => {
  notifyCalls = [];
  walletState = { publicKey: null };
  window.localStorage.clear();
});

describe("OnboardingChecklist", () => {
  const noop = () => {};

  it("renders every step with owner, turnaround and next action", () => {
    render(<OnboardingChecklist state={defaultOnboardingState()} onStatusChange={noop} />);

    for (const id of ["profile", "documents", "license", "payout", "admin-review"]) {
      expect(screen.getByTestId(`onboarding-step-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("onboarding-step-documents")).toHaveTextContent(/owner: you/i);
    expect(screen.getByTestId("onboarding-step-admin-review")).toHaveTextContent(/owner: admin/i);
    expect(screen.getByTestId("onboarding-step-license")).toHaveTextContent(/turnaround/i);
  });

  it("links incomplete steps to their destination page", () => {
    render(<OnboardingChecklist state={defaultOnboardingState()} onStatusChange={noop} />);
    expect(screen.getByRole("link", { name: /go to document uploads/i })).toHaveAttribute(
      "href",
      "/contractor"
    );
    expect(screen.getByRole("link", { name: /set up payouts/i })).toHaveAttribute(
      "href",
      "/contractor/payouts"
    );
  });

  it("shows the ready-for-review state when all contractor steps are done", () => {
    const state = applyStatusChange(
      applyStatusChange(
        applyStatusChange(applyStatusChange(defaultOnboardingState(), "profile", "approved"), "documents", "approved"),
        "license",
        "approved"
      ),
      "payout",
      "approved"
    );
    render(<OnboardingChecklist state={state} onStatusChange={noop} />);
    expect(screen.getByTestId("onboarding-overall-status")).toHaveTextContent(/ready for review/i);
  });

  it("surfaces review notes for a rejected step", () => {
    const state = applyStatusChange(defaultOnboardingState(), "documents", "rejected", {
      reviewNotes: "Photos were blurry — please re-upload.",
    });
    render(<OnboardingChecklist state={state} onStatusChange={noop} />);
    expect(screen.getByTestId("onboarding-review-notes-documents")).toHaveTextContent(
      /photos were blurry/i
    );
  });

  it("announces status changes through a polite live region", async () => {
    const state = defaultOnboardingState();
    const { rerender } = render(<OnboardingChecklist state={state} onStatusChange={noop} />);
    const next = applyStatusChange(state, "documents", "approved");
    rerender(<OnboardingChecklist state={next} onStatusChange={noop} />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/onboarding updated/i)
    );
  });

  it("hides review controls unless review mode is on", () => {
    const { rerender } = render(
      <OnboardingChecklist state={defaultOnboardingState()} onStatusChange={noop} />
    );
    expect(screen.queryByTestId("onboarding-approve-documents")).toBeNull();

    rerender(
      <OnboardingChecklist
        state={defaultOnboardingState()}
        onStatusChange={noop}
        showReviewActions
      />
    );
    expect(screen.getByTestId("onboarding-approve-documents")).toBeInTheDocument();
  });

  it("fires onStatusChange from the keyboard on review buttons", () => {
    const onStatusChange = jest.fn();
    render(
      <OnboardingChecklist
        state={defaultOnboardingState()}
        onStatusChange={onStatusChange}
        showReviewActions
      />
    );
    const approve = screen.getByTestId("onboarding-approve-documents");
    approve.focus();
    expect(approve).toHaveFocus();
    fireEvent.keyDown(approve, { key: "Enter", code: "Enter" });
    fireEvent.click(approve);
    expect(onStatusChange).toHaveBeenCalledWith("documents", "approved");
  });
});

describe("ContractorOnboardingPage", () => {
  it("renders the checklist page with contextual help", async () => {
    render(<ContractorOnboardingPage />);
    await waitFor(() =>
      expect(screen.getByTestId("contractor-onboarding-page")).toBeInTheDocument()
    );
    expect(
      await screen.findByTestId("onboarding-step-admin-review")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /need help/i })).toBeInTheDocument();
  });

  it("notifies with an error when an admin rejects a step (admin wallet)", async () => {
    walletState = { publicKey: "GADMIN" };
    process.env.NEXT_PUBLIC_ADMIN_ADDRESS = "GADMIN";

    render(<ContractorOnboardingPage />);
    const rejectButton = await screen.findByTestId("onboarding-reject-documents");
    fireEvent.click(rejectButton);

    await waitFor(() => {
      expect(notifyCalls.some((call) => call.variant === "error")).toBe(true);
    });
    const rejection = notifyCalls.find((call) => call.variant === "error")!;
    expect(rejection.title).toMatch(/rejected/i);
    expect(rejection.message).toMatch(/documents/i);
  });

  it("notifies with success when a step is approved and persists the state", async () => {
    walletState = { publicKey: "GADMIN" };
    process.env.NEXT_PUBLIC_ADMIN_ADDRESS = "GADMIN";

    render(<ContractorOnboardingPage />);
    const approveButton = await screen.findByTestId("onboarding-approve-payout");
    fireEvent.click(approveButton);

    await waitFor(() => {
      expect(notifyCalls.some((call) => call.variant === "success")).toBe(true);
    });
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("contractor-onboarding-state")!);
      expect(stored.steps.find((s: any) => s.id === "payout").status).toBe("approved");
    });
  });

  it("hides review controls for non-admin visitors", async () => {
    walletState = { publicKey: "GCONTRACTOR" };
    process.env.NEXT_PUBLIC_ADMIN_ADDRESS = "GADMIN";

    render(<ContractorOnboardingPage />);
    await screen.findByTestId("onboarding-step-documents");
    expect(screen.queryByTestId("onboarding-approve-documents")).toBeNull();
  });
});
