"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Warns before a form with unsaved edits is abandoned.
 *
 * - Tab close / reload / external links: the browser's native `beforeunload`
 *   prompt (browsers do not allow custom text there).
 * - In-app links: clicks on same-origin `<a href>` (including `next/link`) are
 *   intercepted and routed through a confirmation dialog.
 * - Browser back/forward: a sentinel history entry is pushed while dirty so the
 *   back button can be intercepted (the App Router has no route-change hook).
 * - Programmatic navigation: use `navigate(href)` to be prompted, or
 *   `allowNavigation()` before `router.push()` after a successful submit.
 *
 * Render `<UnsavedChangesDialog {...dialogProps} />` next to the form.
 */

const GUARD_KEY = "__unsavedChangesGuard";
const RELEASE_TIMEOUT_MS = 300;

type Pending = { kind: "href"; href: string } | { kind: "back" } | null;

export interface UnsavedChangesGuardOptions {
  /** True while the form holds edits that would be lost by leaving. */
  isDirty: boolean;
  /** Provide where drafts are supported; enables the "Save draft" action. */
  onSaveDraft?: () => void | Promise<void>;
}

export interface UnsavedChangesDialogProps {
  open: boolean;
  canSaveDraft: boolean;
  saving: boolean;
  saveError: boolean;
  onStay: () => void;
  onDiscard: () => void;
  onSaveDraft: () => void;
}

export function useUnsavedChangesGuard({ isDirty, onSaveDraft }: UnsavedChangesGuardOptions) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const dirtyRef = useRef(isDirty);
  const sentinelRef = useRef(false);
  const releasingRef = useRef(false);
  const onSaveDraftRef = useRef(onSaveDraft);

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);
  useEffect(() => {
    onSaveDraftRef.current = onSaveDraft;
  }, [onSaveDraft]);

  const pushSentinel = useCallback(() => {
    if (sentinelRef.current) return;
    window.history.pushState(
      { ...(window.history.state ?? {}), [GUARD_KEY]: true },
      "",
      window.location.href
    );
    sentinelRef.current = true;
  }, []);

  /** Pops the sentinel entry (if it is the current one) and waits for the traversal. */
  const releaseSentinel = useCallback((): Promise<void> => {
    if (!sentinelRef.current || !window.history.state?.[GUARD_KEY]) {
      sentinelRef.current = false;
      return Promise.resolve();
    }
    sentinelRef.current = false;
    releasingRef.current = true;
    return new Promise<void>((resolve) => {
      const finish = () => {
        window.removeEventListener("popstate", finish);
        clearTimeout(timer);
        releasingRef.current = false;
        resolve();
      };
      const timer = setTimeout(finish, RELEASE_TIMEOUT_MS);
      window.addEventListener("popstate", finish);
      window.history.back();
    });
  }, []);

  // Tab close / reload / external navigation.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // In-app link clicks. Capture phase on document runs before React/Next see the click.
  useEffect(() => {
    if (!isDirty) return;
    const onClick = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return; // beforeunload covers external links
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      event.preventDefault();
      event.stopPropagation();
      setPending({ kind: "href", href: `${url.pathname}${url.search}${url.hash}` });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [isDirty]);

  // Browser back button.
  useEffect(() => {
    if (!isDirty) return;
    pushSentinel();
    const onPopState = () => {
      if (!dirtyRef.current || releasingRef.current) return;
      sentinelRef.current = false; // the sentinel was just popped
      setPending({ kind: "back" });
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      // The form became clean (or unmounted) while still on the sentinel: drop it.
      if (sentinelRef.current && window.history.state?.[GUARD_KEY]) {
        sentinelRef.current = false;
        window.history.back();
      }
    };
  }, [isDirty, pushSentinel]);

  const leave = useCallback(
    async (destination: Pending) => {
      dirtyRef.current = false;
      await releaseSentinel();
      if (destination?.kind === "href") router.push(destination.href);
      else if (destination?.kind === "back") window.history.back();
    },
    [releaseSentinel, router]
  );

  /**
   * Clears the warning immediately. Call (and await) before navigating away
   * after a successful submit so the form never prompts when nothing is lost.
   */
  const allowNavigation = useCallback(async () => {
    dirtyRef.current = false;
    setPending(null);
    await releaseSentinel();
  }, [releaseSentinel]);

  /** Navigate programmatically, asking first if the form is dirty. */
  const navigate = useCallback(
    (href: string) => {
      if (dirtyRef.current) setPending({ kind: "href", href });
      else router.push(href);
    },
    [router]
  );

  const onStay = useCallback(() => {
    const wasBack = pending?.kind === "back";
    setPending(null);
    setSaveError(false);
    if (wasBack) pushSentinel();
  }, [pending, pushSentinel]);

  const onDiscard = useCallback(() => {
    const destination = pending;
    setPending(null);
    setSaveError(false);
    void leave(destination);
  }, [pending, leave]);

  const onSaveDraftAndLeave = useCallback(async () => {
    const destination = pending;
    setSaving(true);
    setSaveError(false);
    try {
      await onSaveDraftRef.current?.();
    } catch {
      setSaveError(true);
      return;
    } finally {
      setSaving(false);
    }
    setPending(null);
    await leave(destination);
  }, [pending, leave]);

  const dialogProps: UnsavedChangesDialogProps = {
    open: pending !== null,
    canSaveDraft: Boolean(onSaveDraft),
    saving,
    saveError,
    onStay,
    onDiscard,
    onSaveDraft: () => void onSaveDraftAndLeave(),
  };

  return { dialogProps, allowNavigation, navigate, isPrompting: pending !== null };
}
