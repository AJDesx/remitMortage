// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Screen-reader announcer.
 *
 * A tiny framework-agnostic message bus that feeds the visually hidden live
 * regions rendered by `LiveRegionAnnouncer`. Any module (React or not) can call
 * `announce()`; the mounted component renders the message into a polite or
 * assertive live region so assistive technology reads it without moving focus.
 *
 * Spam protection:
 *  - A message identical to the previously accepted message of the same
 *    priority is dropped while it is inside the de-duplication window.
 *  - Polite messages are spaced at least `minIntervalMs` apart; bursts are
 *    queued (bounded) and flushed in order. Assertive messages are never
 *    delayed because they report failures the user must hear immediately.
 */

export type AnnouncePriority = "polite" | "assertive";

export interface Announcement {
  /** Monotonic id, used by the renderer to re-announce identical text. */
  id: number;
  priority: AnnouncePriority;
  message: string;
}

export interface AnnounceOptions {
  priority?: AnnouncePriority;
}

export interface AnnouncerConfig {
  /** Identical consecutive messages inside this window are dropped. */
  dedupeWindowMs: number;
  /** Minimum spacing between polite announcements. */
  minIntervalMs: number;
  /** Maximum polite messages held while rate limited; oldest are dropped. */
  maxQueue: number;
}

export const DEFAULT_ANNOUNCER_CONFIG: AnnouncerConfig = {
  dedupeWindowMs: 5000,
  minIntervalMs: 1000,
  maxQueue: 5,
};

type Listener = (announcement: Announcement) => void;

export function createAnnouncer(overrides: Partial<AnnouncerConfig> = {}) {
  const config: AnnouncerConfig = { ...DEFAULT_ANNOUNCER_CONFIG, ...overrides };
  const listeners = new Set<Listener>();
  const lastAccepted: Partial<Record<AnnouncePriority, { message: string; at: number }>> = {};
  let nextId = 0;
  let lastPoliteEmitAt = Number.NEGATIVE_INFINITY;
  let politeQueue: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function emit(priority: AnnouncePriority, message: string) {
    nextId += 1;
    if (priority === "polite") lastPoliteEmitAt = Date.now();
    const announcement: Announcement = { id: nextId, priority, message };
    listeners.forEach((listener) => listener(announcement));
  }

  function schedule() {
    if (timer !== null || politeQueue.length === 0) return;
    const wait = Math.max(0, config.minIntervalMs - (Date.now() - lastPoliteEmitAt));
    timer = setTimeout(() => {
      timer = null;
      const next = politeQueue.shift();
      if (next !== undefined) emit("polite", next);
      schedule();
    }, wait);
  }

  /** Returns true when the message was accepted (emitted or queued). */
  function announce(message: string, options: AnnounceOptions = {}): boolean {
    const text = message.replace(/\s+/g, " ").trim();
    if (!text) return false;

    const priority = options.priority ?? "polite";
    const now = Date.now();
    const last = lastAccepted[priority];
    if (last && last.message === text && now - last.at < config.dedupeWindowMs) {
      return false;
    }
    lastAccepted[priority] = { message: text, at: now };

    if (priority === "assertive") {
      emit("assertive", text);
      return true;
    }

    if (politeQueue.length === 0 && now - lastPoliteEmitAt >= config.minIntervalMs) {
      emit("polite", text);
      return true;
    }

    politeQueue.push(text);
    if (politeQueue.length > config.maxQueue) politeQueue.shift();
    schedule();
    return true;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Clears queued messages and de-dupe history. Intended for tests. */
  function reset() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    politeQueue = [];
    lastPoliteEmitAt = Number.NEGATIVE_INFINITY;
    delete lastAccepted.polite;
    delete lastAccepted.assertive;
  }

  return { announce, subscribe, reset, config };
}

export const announcer = createAnnouncer();

/** Announce a message to screen readers. Defaults to polite priority. */
export function announce(message: string, options?: AnnounceOptions): boolean {
  return announcer.announce(message, options);
}

export type ToastLikeVariant = "info" | "success" | "warning" | "error";

/** Announce a toast: errors and warnings interrupt, everything else is polite. */
export function announceToast(variant: ToastLikeVariant, title: string, message?: string): boolean {
  const text = message ? `${title}. ${message}` : title;
  const prefix = variant === "error" ? "Error: " : variant === "warning" ? "Warning: " : "";
  return announce(`${prefix}${text}`, {
    priority: variant === "error" || variant === "warning" ? "assertive" : "polite",
  });
}
