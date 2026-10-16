"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useId, useRef } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { UnsavedChangesDialogProps } from "@/hooks/useUnsavedChangesGuard";

/**
 * Confirmation shown when leaving a form with unsaved edits. Keyboard
 * accessible: focus is trapped and starts on the safe "Stay" action, Escape
 * stays on the page, and focus returns to the triggering element on close.
 */
export default function UnsavedChangesDialog({
  open,
  canSaveDraft,
  saving,
  saveError,
  onStay,
  onDiscard,
  onSaveDraft,
}: UnsavedChangesDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);

  useFocusTrap(dialogRef, open, { onEscape: onStay, initialFocusRef: stayRef });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm"
      data-testid="unsaved-changes-overlay"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        data-testid="unsaved-changes-dialog"
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl"
      >
        <h2 id={titleId} className="text-lg font-bold text-white">
          Leave without saving?
        </h2>
        <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-slate-300">
          You have unsaved changes. If you leave this page now, they will be lost
          {canSaveDraft ? " unless you save a draft first" : ""}.
        </p>
        {saveError && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-300">
            Your draft could not be saved. Try again, or stay on the page.
          </p>
        )}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            data-testid="unsaved-changes-discard"
            className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-100 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:opacity-60"
          >
            Discard changes
          </button>
          {canSaveDraft && (
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={saving}
              data-testid="unsaved-changes-save-draft"
              className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-100 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save draft & leave"}
            </button>
          )}
          <button
            ref={stayRef}
            type="button"
            onClick={onStay}
            data-testid="unsaved-changes-stay"
            className="rounded-xl bg-sky-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-sky-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Stay on page
          </button>
        </div>
      </div>
    </div>
  );
}
