# Unsaved Changes Warning

Forms that take minutes to fill in warn before their data would be lost.
Implemented by [`useUnsavedChangesGuard`](../frontend/src/hooks/useUnsavedChangesGuard.ts)
and [`UnsavedChangesDialog`](../frontend/src/components/forms/UnsavedChangesDialog.tsx).

## What is guarded

| Way of leaving | Behaviour while the form is dirty |
| --- | --- |
| Close / reload the tab, external link | Browser's native `beforeunload` confirmation (custom text is not allowed by browsers) |
| In-app link (`<a>`, `next/link`, navbar) | Click is intercepted; the dialog offers **Stay**, **Discard changes** and, where supported, **Save draft & leave** |
| Browser back button | A guard history entry is pushed while dirty; going back opens the same dialog |
| Programmatic navigation | Use `navigate(href)` from the hook to be prompted |

New-tab links, modified clicks (Ctrl/Cmd/Shift/Alt), `download` links and
same-page/hash links are never intercepted. A clean form never prompts.

## Using it

```tsx
const { dialogProps, allowNavigation } = useUnsavedChangesGuard({
  isDirty,                 // true while there are edits that would be lost
  onSaveDraft: saveDraft,  // optional: enables "Save draft & leave"
});

// after a successful submit, BEFORE redirecting:
await allowNavigation();
router.push("/dashboard");

return <>
  <UnsavedChangesDialog {...dialogProps} />
  …
</>;
```

`allowNavigation()` clears the warning synchronously and removes the guard
history entry, so a just-submitted form can never prompt. A form that resets
itself (`isDirty` → `false`) is also clean immediately.

## Wired up

- `OnboardingWizard` — dirty = react-hook-form `isDirty`; "Save draft" calls
  `useFormAutosave().saveDraftNow()`; `allowNavigation()` runs before the
  post-submit redirect.
- Loan application page — dirty while the requested amount is non-empty; no
  drafts, so only Stay / Discard are offered.

## Accessibility

`role="alertdialog"` with `aria-modal`, an accessible name and description;
focus moves to the safe **Stay on page** button, Tab/Shift+Tab are trapped,
Escape stays, and focus returns to the clicked link when dismissed.

## Limitations

The App Router has no route-change event, so back/forward is guarded with a
sentinel history entry, and `router.push()` calls made by application code
bypass the guard unless they go through `navigate()`. Browsers show their own
generic text for the tab-close prompt.

## Tests

`frontend/__tests__/unsaved-changes-guard.test.tsx` covers dirty and clean
states, stay / discard / save-draft paths, keyboard behaviour, back button and
the post-submit case; `useFormAutosave.saveDraftNow.test.tsx` covers the
immediate draft save.

```bash
cd frontend && npx jest __tests__/unsaved-changes-guard.test.tsx __tests__/useFormAutosave.saveDraftNow.test.tsx
```
