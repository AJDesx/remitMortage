# Screen-Reader Announcements (authoring guide)

Async results (a deposit confirming, a loan request failing, a milestone
approval landing, a background refresh breaking) change the page visually but
do not move focus, so screen-reader users never hear about them. The shared
announcer fixes that with two visually hidden live regions mounted **once** in
`frontend/src/app/layout.tsx`.

| Piece | File |
| --- | --- |
| Message bus, de-dupe + rate limit | `frontend/src/lib/announcer.ts` |
| Hidden polite/assertive regions | `frontend/src/components/LiveRegionAnnouncer.tsx` |
| Hook API | `frontend/src/hooks/useAnnouncer.ts` |
| Transaction copy | `describeTransactionAnnouncement` in `frontend/src/lib/transaction-status.ts` |

## What is announced automatically

You do **not** need to do anything for these:

- Toasts from `useToast()` (`ToastContext`) and `useNotifications().notify()`.
  Errors and warnings are assertive, everything else is polite.
- `react-hot-toast` toasts (mirrored by `HotToaster`; string messages only).
- `TransactionModal` phase changes: simulating, signing, pending, confirmed,
  failed (deposit and withdrawal flows).
- The `/tx/[hash]` status page transitions.

The visual toast components no longer carry `role="alert"` / `aria-live`; the
announcer is the single source of spoken output. Do not add live attributes to
new toast-like UI.

## Announcing from new code

```ts
import { announce } from "@/lib/announcer";

announce("Loan application submitted for underwriting review.");          // polite
announce("Loan application failed. Amount too high.", { priority: "assertive" });
```

In components you can also use the hook:

```tsx
const { polite, assertive } = useAnnouncer();
useAnnounceOnChange(statusMessage);            // mirror a status string
```

### Choosing a priority

- **polite** (default): success, progress, "data updated". Waits for the user
  to finish what the screen reader is saying.
- **assertive**: failures the user must act on, validation errors. Interrupts.
  Use sparingly.

### Writing messages

- Lead with the outcome ("Deposit confirmed", "Loan request failed").
- Add the one detail that explains it. Skip hashes and long IDs.
- Full sentences, no emoji or icon characters.

## Anti-spam rules (built in)

- **De-duplication**: an identical message to the previously accepted one of the
  same priority is dropped for 5 s.
- **Rate limit**: polite messages are spaced at least 1 s apart; bursts queue
  (max 5, oldest dropped) and flush in order. Assertive messages are never
  delayed.
- **Polling**: announce *state changes*, not every poll. The dashboard only
  speaks when a background refresh fails or recovers, never on each success.

## Do / don't

- Do keep focus where it is; announcements are not a focus management tool.
- Don't also render `role="status"` / `role="alert"` on the same text you
  announce; it will be read twice.
- Don't announce on every render; trigger from the event or a state *change*.

## Testing

Render `<LiveRegionAnnouncer />` alongside the feature, trigger the flow and
assert on `screen.getByTestId("live-region-polite")` or `"live-region-assertive"`.
Call `announcer.reset()` in `beforeEach` to clear de-dupe history. See
`frontend/src/components/__tests__/LiveRegionAnnouncer.test.tsx`.
