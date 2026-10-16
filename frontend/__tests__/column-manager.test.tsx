// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import ColumnManager from "../src/components/tables/ColumnManager";
import LoanQueueTable from "../src/components/admin/LoanQueueTable";
import type { ColumnDefinition } from "../src/lib/column-preferences";

jest.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

type Row = { a: string; b: string; c: string };

const COLUMNS: ColumnDefinition<Row>[] = [
  { id: "a", header: "Alpha", render: (row) => row.a },
  { id: "b", header: "Beta", render: (row) => row.b },
  { id: "c", header: "Gamma", required: true, render: (row) => row.c },
];

describe("ColumnManager", () => {
  const baseProps = {
    allColumns: COLUMNS,
    preferences: { order: ["a", "b", "c"], hidden: [] as string[] },
    onToggle: jest.fn(),
    onMove: jest.fn(),
    onReset: jest.fn(),
    announcement: "",
    tableLabel: "test",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is closed by default and reports expanded state", () => {
    render(<ColumnManager {...baseProps} />);
    const trigger = screen.getByTestId("column-manager-test");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: /customize test columns/i })).toBeInTheDocument();
  });

  it("toggles a column via its checkbox", () => {
    render(<ColumnManager {...baseProps} />);
    fireEvent.click(screen.getByTestId("column-manager-test"));

    fireEvent.click(screen.getByLabelText("Alpha"));
    expect(baseProps.onToggle).toHaveBeenCalledWith("a");
  });

  it("disables the checkbox for required columns", () => {
    render(<ColumnManager {...baseProps} />);
    fireEvent.click(screen.getByTestId("column-manager-test"));

    expect(screen.getByRole("checkbox", { name: /Gamma/ })).toBeDisabled();
  });

  it("moves columns with the arrow buttons", () => {
    render(<ColumnManager {...baseProps} />);
    fireEvent.click(screen.getByTestId("column-manager-test"));

    fireEvent.click(screen.getByRole("button", { name: "Move Beta column up" }));
    expect(baseProps.onMove).toHaveBeenCalledWith("b", "up");

    fireEvent.click(screen.getByRole("button", { name: "Move Alpha column down" }));
    expect(baseProps.onMove).toHaveBeenCalledWith("a", "down");
  });

  it("disables the move buttons at the ends of the list", () => {
    render(<ColumnManager {...baseProps} />);
    fireEvent.click(screen.getByTestId("column-manager-test"));

    expect(screen.getByRole("button", { name: "Move Alpha column up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Gamma column down" })).toBeDisabled();
  });

  it("resets to defaults", () => {
    render(<ColumnManager {...baseProps} />);
    fireEvent.click(screen.getByTestId("column-manager-test"));
    fireEvent.click(screen.getByTestId("column-manager-reset-test"));
    expect(baseProps.onReset).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    render(<ColumnManager {...baseProps} />);
    const trigger = screen.getByTestId("column-manager-test");
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces changes through the live region", () => {
    render(<ColumnManager {...baseProps} announcement="Column Alpha hidden." />);
    expect(screen.getByRole("status")).toHaveTextContent("Column Alpha hidden.");
  });
});

describe("LoanQueueTable", () => {
  const loans = [
    {
      id: "L1",
      borrower: "GABCDEF1234567890",
      principal: 5000,
      verificationScore: 90,
      status: "submitted",
      daysInStatus: 2,
    },
    {
      id: "L2",
      borrower: "GXYZ1234567890ABC",
      principal: 12000,
      verificationScore: 55,
      status: "underwriting",
      daysInStatus: 5,
    },
  ];

  const onApprove = jest.fn();
  const onReject = jest.fn();

  beforeEach(() => {
    window.localStorage.clear();
    jest.clearAllMocks();
  });

  it("renders one row per loan with the e2e approve hook", () => {
    render(
      <LoanQueueTable loans={loans} onApprove={onApprove} onReject={onReject} userId="GADMIN" />
    );

    expect(screen.getAllByRole("row")).toHaveLength(loans.length + 1); // + header
    expect(screen.getByTestId("admin-approve-L1")).toBeInTheDocument();
    expect(screen.getByTestId("admin-approve-L2")).toBeInTheDocument();
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
  });

  it("calls back for approve and reject", () => {
    render(
      <LoanQueueTable loans={loans} onApprove={onApprove} onReject={onReject} userId="GADMIN" />
    );

    fireEvent.click(screen.getByTestId("admin-approve-L1"));
    expect(onApprove).toHaveBeenCalledWith(loans[0]);

    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[1]);
    expect(onReject).toHaveBeenCalledWith(loans[1]);
  });

  it("hides a column from the table when toggled off", () => {
    render(
      <LoanQueueTable loans={loans} onApprove={onApprove} onReject={onReject} userId="GADMIN" />
    );

    fireEvent.click(screen.getByTestId("column-manager-loan-queue"));
    fireEvent.click(screen.getByLabelText("Status"));

    expect(screen.queryByRole("columnheader", { name: /^Status\b/ })).toBeNull();
    // Other columns remain.
    expect(screen.getByRole("columnheader", { name: /Borrower/ })).toBeInTheDocument();
  });

  it("reorders columns via the manager", () => {
    render(
      <LoanQueueTable loans={loans} onApprove={onApprove} onReject={onReject} userId="GADMIN" />
    );

    fireEvent.click(screen.getByTestId("column-manager-loan-queue"));
    fireEvent.click(screen.getByRole("button", { name: "Move Principal column up" }));

    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers[0]).toContain("Principal");
    expect(headers[1]).toContain("Borrower");
  });

  it("persists preferences across remounts for the same user", () => {
    const first = render(
      <LoanQueueTable loans={loans} onApprove={onApprove} onReject={onReject} userId="GADMIN" />
    );
    fireEvent.click(screen.getByTestId("column-manager-loan-queue"));
    fireEvent.click(screen.getByLabelText("Status"));
    first.unmount();

    render(
      <LoanQueueTable loans={loans} onApprove={onApprove} onReject={onReject} userId="GADMIN" />
    );
    expect(screen.queryByRole("columnheader", { name: /^Status\b/ })).toBeNull();
  });

  it("resizes a column with the keyboard", () => {
    render(
      <LoanQueueTable loans={loans} onApprove={onApprove} onReject={onReject} userId="GADMIN" />
    );

    const handle = screen.getByRole("separator", { name: "Resize Borrower column" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight", code: "ArrowRight" });

    // Width becomes the default (160) + one keyboard step (16).
    expect(handle).toHaveAttribute("aria-valuenow", "176");
  });
});
