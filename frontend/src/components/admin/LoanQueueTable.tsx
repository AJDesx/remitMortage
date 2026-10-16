"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import ColumnManager from "@/components/tables/ColumnManager";
import ColumnResizeHandle from "@/components/tables/ColumnResizeHandle";
import { useColumnPreferences } from "@/hooks/useColumnPreferences";
import type { ColumnDefinition } from "@/lib/column-preferences";
import type { KanbanLoan } from "@/components/LoanKanbanBoard";

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsdc(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 80 ? "text-emerald-400" : score >= 60 ? "text-amber-400" : "text-red-400";
  return <span className={`font-semibold ${tone}`}>{score}</span>;
}

interface LoanQueueTableProps {
  loans: KanbanLoan[];
  onApprove: (loan: KanbanLoan) => void;
  onReject: (loan: KanbanLoan) => void;
  /** Wallet used to scope per-user column preferences. */
  userId: string | null;
}

/**
 * Loan queue rendered as a customizable table. Columns can be shown, hidden,
 * reordered, and resized; preferences persist per reviewer. The Approve
 * action keeps the `admin-approve-<id>` test hook used by e2e.
 */
export default function LoanQueueTable({
  loans,
  onApprove,
  onReject,
  userId,
}: LoanQueueTableProps) {
  const columns = React.useMemo<ColumnDefinition<KanbanLoan>[]>(
    () => [
      {
        id: "borrower",
        header: "Borrower",
        defaultWidth: 160,
        render: (loan) => <span className="font-mono">{shortenAddress(loan.borrower)}</span>,
      },
      {
        id: "principal",
        header: "Principal",
        defaultWidth: 140,
        align: "right",
        render: (loan) => <span className="font-semibold">{formatUsdc(loan.principal)}</span>,
      },
      {
        id: "score",
        header: "Verification Score",
        defaultWidth: 160,
        render: (loan) => <ScoreBadge score={loan.verificationScore} />,
      },
      {
        id: "status",
        header: "Status",
        defaultWidth: 130,
        render: (loan) => (
          <span className="capitalize text-[var(--text-secondary)]">{loan.status}</span>
        ),
      },
      {
        id: "days",
        header: "Days in Status",
        defaultWidth: 130,
        align: "right",
        render: (loan) => <span>{loan.daysInStatus}</span>,
      },
      {
        id: "actions",
        header: "Actions",
        defaultWidth: 190,
        required: true,
        render: (loan) => (
          <div className="flex gap-2">
            <button
              data-testid={`admin-approve-${loan.id}`}
              onClick={() => onApprove(loan)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => onReject(loan)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors"
            >
              Reject
            </button>
          </div>
        ),
      },
    ],
    [onApprove, onReject]
  );

  const {
    preferences,
    columns: visibleColumns,
    announcement,
    toggleColumn,
    moveColumn,
    resizeColumn,
    resetToDefaults,
  } = useColumnPreferences("admin-loan-queue", userId, columns);

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-lg overflow-hidden">
      <div className="flex items-center justify-end p-3 border-b border-[var(--border-color)]">
        <ColumnManager
          tableLabel="loan-queue"
          allColumns={columns}
          preferences={preferences}
          onToggle={toggleColumn}
          onMove={moveColumn}
          onReset={resetToDefaults}
          announcement={announcement}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)] text-xs uppercase tracking-wider">
              {visibleColumns.map((column) => {
                const width = preferences.widths[column.id] ?? column.defaultWidth;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    style={width ? { width } : undefined}
                    className={`relative px-4 py-3 font-medium ${
                      column.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    {column.header}
                    <ColumnResizeHandle
                      columnHeader={column.header}
                      width={width}
                      minWidth={column.minWidth}
                      onResize={(nextWidth) => resizeColumn(column.id, nextWidth)}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loans.map((loan) => (
              <tr
                key={loan.id}
                className="border-b border-[var(--border-color)]/40 last:border-0 hover:bg-[var(--bg-card-hover)] transition-colors"
              >
                {visibleColumns.map((column) => (
                  <td
                    key={column.id}
                    className={`px-4 py-3 ${column.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {column.render(loan)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
