"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";
import { announcer, type Announcement, type AnnouncePriority } from "@/lib/announcer";

/** How long an announcement stays in the DOM before the region is emptied. */
const CLEAR_AFTER_MS = 10_000;

type RegionState = Record<AnnouncePriority, Announcement | null>;

/**
 * Visually hidden polite + assertive live regions. Mount exactly once at the
 * app root; both regions are always present so assistive technology has
 * registered them before the first message arrives. Feed them with
 * `announce()` from `@/lib/announcer` or the `useAnnouncer` hook.
 */
export function LiveRegionAnnouncer() {
  const [regions, setRegions] = useState<RegionState>({ polite: null, assertive: null });

  useEffect(() => {
    const timers: Partial<Record<AnnouncePriority, ReturnType<typeof setTimeout>>> = {};

    const unsubscribe = announcer.subscribe((announcement) => {
      const { priority } = announcement;
      setRegions((current) => ({ ...current, [priority]: announcement }));

      const existing = timers[priority];
      if (existing) clearTimeout(existing);
      timers[priority] = setTimeout(() => {
        setRegions((current) => ({ ...current, [priority]: null }));
      }, CLEAR_AFTER_MS);
    });

    return () => {
      unsubscribe();
      Object.values(timers).forEach((timer) => timer && clearTimeout(timer));
    };
  }, []);

  // Live regions only re-announce when their text changes, so alternate a
  // trailing non-breaking space to let identical text (after the de-dupe
  // window) be read again.
  const render = (announcement: Announcement | null) =>
    announcement ? `${announcement.message}${announcement.id % 2 === 0 ? " " : ""}` : "";

  return (
    <>
      <div
        data-testid="live-region-polite"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {render(regions.polite)}
      </div>
      <div
        data-testid="live-region-assertive"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        {render(regions.assertive)}
      </div>
    </>
  );
}

export default LiveRegionAnnouncer;
