// components/ThemeStyle.tsx — wraps the React tree in an element whose
// `style` attribute injects the per-school `--color-accent` CSS variable.
//
// `--color-accent` is the same variable `tokens.css` declares and
// `tailwind.config.ts` maps `bg-accent` / `text-accent` / `border-accent` to.
// Anything else (e.g. `--accent`) would render as a no-op because Tailwind
// reads the `--color-accent` namespace.
//
// The component is intentionally simple — a pass-through div with
// `style={{ '--color-accent': accent }}` set. We don't write to
// `document.documentElement` here because that would mutate the live
// document during SSR (where `document` doesn't exist anyway).
//
// Why a wrapper instead of writing to the `<html>` style attribute
// directly: the `Layout` `<html>` is rendered ABOVE the
// `<Outlet />` in the component tree. The wrapper sits inside
// `<Outlet />` so changing the accent on navigation can be done
// without rewriting the document root. Routes that need a
// document-level theme (the few that read the variable outside their
// own sub-tree) call `applyTheme()` from `lib/theme.ts`.

import type * as React from 'react';
import { accentFor } from '../lib/theme';

export interface ThemeStyleProps {
  /** The accent color, sourced from the loader. */
  accent: string;
  children: React.ReactNode;
}

export function ThemeStyle({ accent, children }: ThemeStyleProps): React.ReactElement {
  const safe = accentFor(accent);
  return (
    <div
      style={{ '--color-accent': safe } as React.CSSProperties}
      className="contents"
      data-accent={safe}
    >
      {children}
    </div>
  );
}
