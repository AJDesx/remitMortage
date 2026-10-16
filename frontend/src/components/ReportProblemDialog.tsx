"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { buildReport, submitReport } from "@/lib/error-report";

interface ReportProblemDialogProps {
  errorId: string;
  pathname: string;
  error: Error;
  /** Sentry event id of the captured crash, read at submit time, to link the report to it. */
  getEventId?: () => string | undefined;
  onClose: () => void;
}

export default function ReportProblemDialog({ errorId, pathname, error, getEventId, onClose }: ReportProblemDialogProps) {
  const [description, setDescription] = useState("");
  const [sent, setSent] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useFocusTrap(dialogRef, true, { onEscape: onClose, initialFocusRef: textRef });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitReport(buildReport({ errorId, pathname, description, error }), getEventId?.());
    setSent(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-problem-title"
        className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
      >
        <h2 id="report-problem-title" className="text-lg font-bold text-white">Report a problem</h2>
        {sent ? (
          <div className="mt-4 space-y-4">
            <p role="status" className="text-sm text-slate-300">
              Thanks, your report was sent. Reference: <strong data-testid="sent-error-id">{errorId}</strong>
            </p>
            <button type="button" onClick={onClose} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-slate-950">
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-4 space-y-4">
            <p className="text-xs text-slate-400">
              We attach the error ID, the page (without IDs or query strings) and your browser type. Emails,
              wallet addresses, tokens and phone numbers are removed before sending.
            </p>
            <p className="text-xs text-slate-400">
              Error ID: <code data-testid="error-id" className="text-cyan-300">{errorId}</code>
            </p>
            <label className="block text-sm text-slate-300">
              What were you doing?
              <textarea
                ref={textRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={4}
                className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950/40 p-2 text-sm text-white"
              />
            </label>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-slate-950">
                Send report
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
