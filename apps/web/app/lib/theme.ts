// app/lib/theme.ts — per-school accent color application.
//
// Spec section 11: every school has a `schools.accent_color` value
// (default `#3b82f6`). The application uses `--color-accent` as a CSS
// variable so Tailwind's `bg-accent`, `text-accent`, `border-accent`
// utilities, plus ad-hoc inline styles, can read it.
//
// Where the variable is set:
//   - SSR: rendered into `<html style={{ '--color-accent': ... }}>` from
//     `root.tsx`'s server entry so the first paint already has the
//     correct color (no FOUC).
//   - SSR per-route: the authenticated layout (`_app.tsx`) re-applies
//     it on the `<body>` style so school-specific branding tracks the
//     logged-in school (the landing page has no school context).
//   - Client: `applyTheme()` runs at hydration and also after
//     client-side route transitions (when the user toggles the value
//     in settings). It writes to `document.documentElement.style`,
//     which is the single source of truth for both the cached HTML
//     and the live document.
//
// Default:
//   - Schools that haven't customised their accent_color fall back to
//     `#3b82f6` (Tailwind's `blue-500`).
//
// Why we don't ship a real CSS file:
//   - Component CSS would require either Tailwind config plumbing or
//     a separate stylesheet; both are heavier than a single CSS
//     variable on the html element. Tailwind reads `--color-accent`
//     via `theme.extend.colors.accent` in tailwind.config.ts and the
//     `bg-accent` / `text-accent` / `border-accent` utilities resolve
//     through `var(--color-accent)`. The components use inline
//     `style={{ '--color-accent': ... }}` so Tailwind picks it up at
//     SSR (before the stylesheet hydrates) without a flash.

import type * as React from 'react';

/**
 * Sanitize a user-supplied accent color. We accept any `rgb()` /
 * `rgba()` / `#RRGGBB` / `#RGB` / named-color string but reject
 * anything that contains a semicolon or url() so a hostile admin
 * can't inject other CSS variables.
 *
 * Returns the input if it parses as a CSS `<color>`; null otherwise.
 */
export function isValidAccentColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false;
  }
  // CSS injection defense — no semicolons, no parentheses that aren't
  // rgb()/rgba()/hsl() etc.
  if (/[;"'`]|\burl\(|\bexpression\(|\bscript:/i.test(value)) return false;
  // The three formats we accept verbatim.
  return (
    /^#[0-9a-f]{3}$/i.test(value) ||
    /^#[0-9a-f]{6}$/i.test(value) ||
    /^rgba?\(\s*\d/.test(value) ||
    /^hsla?\(\s*\d/.test(value)
  );
}

/** Default accent color for schools that haven't customised. */
export const DEFAULT_ACCENT = '#3b82f6';

/**
 * Pick the accent color for a school row, falling back to the default.
 * The fall-through keeps the UI pleasant when a school's
 * `accent_color` is null or an attacker tries to set nonsense.
 */
export function accentFor(value: string | null | undefined): string {
  return isValidAccentColor(value) ? value : DEFAULT_ACCENT;
}

/**
 * Apply the accent color to the document root. Idempotent — call it
 * on every route change without worrying about double-applies.
 *
 * Pure DOM operation, safe to call from any client context (no
 * server-side rendering side-effects).
 *
 * On the server side, this is a no-op — we render the inline style
 * directly into the JSX. The client-side function only matters after
 * hydration (when a user updates the color from the settings page).
 */
export function applyTheme(value: string): void {
  if (typeof document === 'undefined') return;
  const safe = accentFor(value);
  document.documentElement.style.setProperty('--color-accent', safe);
}

/**
 * Inline style spread for `<html>` / `<body>` that sets the accent.
 * Use this in SSR. The style object lets the React renderer hydrate
 * it directly into the HTML element instead of relying on JS.
 *
 * Example:
 *   <html style={themeStyle(loader.school.accentColor)}>
 */
export function themeStyle(value: string | null | undefined): React.CSSProperties {
  return { '--color-accent': accentFor(value) } as React.CSSProperties;
}
