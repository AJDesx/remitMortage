// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { act, render, screen } from "@testing-library/react";
import { LiveRegionAnnouncer } from "../LiveRegionAnnouncer";
import TransactionModal from "../tx/TransactionModal";
import { ToastProvider, useToast } from "@/context/ToastContext";
import { announce, announcer } from "@/lib/announcer";

function ToastButton({ input }: { input: Parameters<ReturnType<typeof useToast>["toast"]>[0] }) {
  const { toast } = useToast();
  return <button onClick={() => toast(input)}>fire</button>;
}

describe("LiveRegionAnnouncer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    announcer.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders always-present polite and assertive regions", () => {
    render(<LiveRegionAnnouncer />);
    expect(screen.getByTestId("live-region-polite")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("live-region-assertive")).toHaveAttribute("aria-live", "assertive");
  });

  it("writes announcements into the matching region", () => {
    render(<LiveRegionAnnouncer />);
    act(() => {
      announce("Loan application submitted");
      announce("Loan request failed", { priority: "assertive" });
    });

    expect(screen.getByTestId("live-region-polite")).toHaveTextContent("Loan application submitted");
    expect(screen.getByTestId("live-region-assertive")).toHaveTextContent("Loan request failed");
  });

  it("does not repeat identical updates", () => {
    render(<LiveRegionAnnouncer />);
    const polite = screen.getByTestId("live-region-polite");

    act(() => {
      announce("Dashboard data refreshed.");
    });
    const first = polite.textContent;
    act(() => {
      announce("Dashboard data refreshed.");
      announce("Dashboard data refreshed.");
    });

    expect(polite.textContent).toBe(first);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(polite.textContent).toBe(first);
  });

  it("announces toasts without moving focus (deposit and milestone approval)", () => {
    render(
      <ToastProvider>
        <LiveRegionAnnouncer />
        <ToastButton input={{ variant: "success", title: "Quorum reached", message: "Milestone approved." }} />
      </ToastProvider>
    );
    const button = screen.getByText("fire");
    button.focus();

    act(() => {
      button.click();
    });

    expect(screen.getByTestId("live-region-polite")).toHaveTextContent(
      "Quorum reached. Milestone approved."
    );
    expect(button).toHaveFocus();
  });

  it("announces failed toasts assertively", () => {
    render(
      <ToastProvider>
        <LiveRegionAnnouncer />
        <ToastButton input={{ variant: "error", title: "Deposit failed", message: "Insufficient balance" }} />
      </ToastProvider>
    );

    act(() => {
      screen.getByText("fire").click();
    });

    expect(screen.getByTestId("live-region-assertive")).toHaveTextContent(
      "Error: Deposit failed. Insufficient balance"
    );
  });

  it("announces transaction success and failure from TransactionModal", () => {
    render(
      <>
        <LiveRegionAnnouncer />
        <TransactionModal isOpen phase="success" transactionType="Deposit" onClose={jest.fn()} />
      </>
    );
    expect(screen.getByTestId("live-region-polite")).toHaveTextContent(
      "Deposit confirmed on the network."
    );
  });

  it("announces a failed transaction assertively", () => {
    render(
      <>
        <LiveRegionAnnouncer />
        <TransactionModal
          isOpen
          phase="error"
          transactionType="Deposit"
          errorMessage="Simulation failed: insufficient balance"
          onClose={jest.fn()}
        />
      </>
    );
    expect(screen.getByTestId("live-region-assertive")).toHaveTextContent(
      "Deposit failed. insufficient balance"
    );
  });
});
