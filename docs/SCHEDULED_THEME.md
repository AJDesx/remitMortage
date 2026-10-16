# Scheduled Dark-Mode Auto-Switching (#834)

Theme mode (Settings → Appearance → Theme Mode):

| Mode | Behavior |
| --- | --- |
| System | Follows the OS `prefers-color-scheme`, live. Default when nothing was chosen before. |
| Scheduled | Dark inside a daily window, light outside. Custom hours (`HH:MM`, may cross midnight) or sunset→sunrise from the device location. |
| Manual | The light/dark button the user picked. Anyone who chose a theme before this feature is migrated to Manual automatically. |

Picking Light/Dark explicitly always switches to Manual. The colour-blind palette is independent of mode.

## How it works

- `src/app/lib/theme-schedule.ts` is pure (takes a `Date`): `isDarkAt`, `msUntilNextSwitch`, `resolveEffectiveTheme`, `computeSunTimes`. The window is `[start, end)`; `start === end` means never dark.
- `ThemeProvider` arms one timer for the next boundary and re-syncs on tab focus / visibility (timers are suspended in hidden tabs and across sleep). No reload needed.
- First paint: `THEME_BOOT_SCRIPT` (`src/app/lib/theme-boot.ts`) runs inline in `<head>` and resolves the same logic from `localStorage`, so there is no flash. For sunset→sunrise the computed times are written back to `remitmortgage-theme-schedule` on each sync so the script never needs coordinates. `theme-modes.test.tsx` checks the script agrees with `isDarkAt` at the boundaries.
- Automatic switches fade (`html.theme-transition`) only under `prefers-reduced-motion: no-preference`.
- Storage keys: `remitmortgage-theme-mode`, `remitmortgage-theme-schedule`, plus the existing `remitmortgage-theme` (manual choice) and `remitmortgage-palette`. Location never leaves the device.

Tests: `frontend/__tests__/theme-schedule.test.ts`, `frontend/__tests__/theme-modes.test.tsx`.
