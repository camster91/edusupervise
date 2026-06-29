// apps/web/app/lib/design-system.ts
//
// TypeScript exports of the design tokens defined in
// apps/web/app/styles/tokens.css. Components import from this file
// to get type-safe token references; the actual VALUES are CSS
// custom properties (so dark mode + per-school accent overrides
// work without a JS recompile).
//
// Usage pattern:
//   import { colors, type, space, motion } from '~/lib/design-system';
//   className="bg-surface text-primary"
//   style={{ padding: space.xl, transition: motion.transition.base }}
//
// The CSS var NAMES are the constants here. The CSS file is the
// single source of truth for the actual values.

export const colors = {
  // Surfaces
  bg:          'var(--color-bg)',
  surface:     'var(--color-surface)',
  surface2:    'var(--color-surface-2)',
  surface3:    'var(--color-surface-3)',

  // Text
  textPrimary:    'var(--color-text-primary)',
  textSecondary:  'var(--color-text-secondary)',
  textTertiary:   'var(--color-text-tertiary)',
  textOnAccent:   'var(--color-text-on-accent)',

  // Borders
  border:        'var(--color-border)',
  borderStrong:  'var(--color-border-strong)',
  divider:       'var(--color-divider)',

  // Brand
  accent:        'var(--color-accent)',
  accentHover:   'var(--color-accent-hover)',
  accentSoft:    'var(--color-accent-soft)',
  accentFg:      'var(--color-accent-fg)',

  // Status
  success:       'var(--color-success)',
  successSoft:   'var(--color-success-soft)',
  warning:       'var(--color-warning)',
  warningSoft:   'var(--color-warning-soft)',
  error:         'var(--color-error)',
  errorSoft:     'var(--color-error-soft)',
  info:          'var(--color-info)',
  infoSoft:      'var(--color-info-soft)',
} as const;

export const type = {
  display:   { fontSize: 'var(--text-display)',    lineHeight: 'var(--leading-display)',    fontWeight: 'var(--weight-display)' },
  title1:    { fontSize: 'var(--text-title-1)',    lineHeight: 'var(--leading-title-1)',    fontWeight: 'var(--weight-title-1)' },
  title2:    { fontSize: 'var(--text-title-2)',    lineHeight: 'var(--leading-title-2)',    fontWeight: 'var(--weight-title-2)' },
  title3:    { fontSize: 'var(--text-title-3)',    lineHeight: 'var(--leading-title-3)',    fontWeight: 'var(--weight-title-3)' },
  body:      { fontSize: 'var(--text-body)',       lineHeight: 'var(--leading-body)',       fontWeight: 'var(--weight-body)' },
  bodyEm:    { fontSize: 'var(--text-body-em)',    lineHeight: 'var(--leading-body-em)',    fontWeight: 'var(--weight-body-em)' },
  callout:   { fontSize: 'var(--text-callout)',    lineHeight: 'var(--leading-callout)',    fontWeight: 'var(--weight-callout)' },
  subhead:   { fontSize: 'var(--text-subhead)',    lineHeight: 'var(--leading-subhead)',    fontWeight: 'var(--weight-subhead)' },
  footnote:  { fontSize: 'var(--text-footnote)',   lineHeight: 'var(--leading-footnote)',   fontWeight: 'var(--weight-footnote)' },
  caption2:  { fontSize: 'var(--text-caption-2)',  lineHeight: 'var(--leading-caption-2)',  fontWeight: 'var(--weight-caption-2)' },
} as const;

export const space = {
  xs:    'var(--space-xs)',
  sm:    'var(--space-sm)',
  md:    'var(--space-md)',
  lg:    'var(--space-lg)',
  xl:    'var(--space-xl)',
  '2xl': 'var(--space-2xl)',
  '3xl': 'var(--space-3xl)',
  '4xl': 'var(--space-4xl)',
} as const;

export const radius = {
  sm:    'var(--radius-sm)',
  md:    'var(--radius-md)',
  lg:    'var(--radius-lg)',
  xl:    'var(--radius-xl)',
  '2xl': 'var(--radius-2xl)',
  full:  'var(--radius-full)',
} as const;

export const elevation = {
  0: 'var(--elev-0)',
  1: 'var(--elev-1)',
  2: 'var(--elev-2)',
  3: 'var(--elev-3)',
} as const;

export const motion = {
  duration: {
    fast:  'var(--duration-fast)',
    base:  'var(--duration-base)',
    slow:  'var(--duration-slow)',
    sheet: 'var(--duration-sheet)',
  },
  ease: {
    out:    'var(--ease-out)',
    spring: 'var(--ease-spring)',
  },
  transition: {
    fast: 'all var(--duration-fast) ease',
    base: 'all var(--duration-base) var(--ease-out)',
    slow: 'all var(--duration-slow) var(--ease-out)',
    sheet: 'transform var(--duration-sheet) var(--ease-out)',
  },
} as const;

export const sizing = {
  touchTargetMin:  'var(--touch-target-min)',
  tabBarHeight:    'var(--tab-bar-height)',
  topbarHeight:    'var(--topbar-height)',
  inputHeight:     'var(--input-height)',
  buttonSm:        'var(--button-sm)',
  buttonMd:        'var(--button-md)',
  buttonLg:        'var(--button-lg)',
  sidebarExpanded: 'var(--sidebar-expanded)',
  sidebarCollapsed:'var(--sidebar-collapsed)',
  maxContent:      'var(--max-content-width)',
} as const;

// Schools can override `--color-accent` and `--color-accent-soft`.
// These are the keys the theme system writes to.
export const OVERRIDABLE_COLOR_VARS = [
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-soft',
] as const;
