// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from "react";
import { announce, type AnnouncePriority } from "../lib/announcer";

/**
 * Stable announcer API for components.
 *
 *   const { polite, assertive } = useAnnouncer();
 *   polite("Loan application submitted");
 *   assertive("Deposit failed");
 */
const api = {
  announce,
  polite: (message: string) => announce(message, { priority: "polite" }),
  assertive: (message: string) => announce(message, { priority: "assertive" }),
};

export function useAnnouncer() {
  return api;
}

/**
 * Announces `message` whenever it changes to a new non-empty value. Useful for
 * mirroring status text (form results, status badges) without moving focus.
 */
export function useAnnounceOnChange(
  message: string | null | undefined,
  priority: AnnouncePriority = "polite",
) {
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (message && message !== previous.current) announce(message, { priority });
    previous.current = message;
  }, [message, priority]);
}
