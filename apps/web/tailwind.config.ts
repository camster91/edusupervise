/** @type {import('tailwindcss').Config} */
//
// apps/web/tailwind.config.ts — Tailwind v3 config that maps the
// Apple-HIG design tokens (apps/web/app/styles/tokens.css) to
// utility classes. Every component should use semantic utility
// classes (bg-surface, text-primary, border-default) rather than
// raw colors or sizes.
//
// Source spec: docs/superpowers/specs/2026-06-29-edusupervise-design-system.md
//
// The `colors` block uses CSS var references so:
//   - Dark mode (via prefers-color-scheme) works automatically
//   - School brand override of --color-accent works automatically
//   - No JS recompile needed when the school changes its accent

export default {
  content: [
    './app/**/*.{ts,tsx,js,jsx}',
  ],
  // The 'accent' color is special — it's per-school overridable via
  // inline style="--accent: ..." on the <html> element. The utility
  // classes (bg-accent, text-accent, border-accent) resolve through
  // that CSS var, so schools get custom branding without a rebuild.
  theme: {
    extend: {
      colors: {
        bg:           'var(--color-bg)',
        surface:      'var(--color-surface)',
        'surface-2':  'var(--color-surface-2)',
        'surface-3':  'var(--color-surface-3)',

        primary:      'var(--color-text-primary)',
        secondary:    'var(--color-text-secondary)',
        tertiary:     'var(--color-text-tertiary)',
        'on-accent':  'var(--color-text-on-accent)',

        border:        'var(--color-border)',
        'border-strong': 'var(--color-border-strong)',
        divider:       'var(--color-divider)',

        // Brand — overridable
        accent:       'var(--color-accent)',
        'accent-hover': 'var(--color-accent-hover)',
        'accent-soft':  'var(--color-accent-soft)',
        'accent-fg':    'var(--color-accent-fg)',

        // Status — fixed
        success:      'var(--color-success)',
        'success-soft': 'var(--color-success-soft)',
        warning:      'var(--color-warning)',
        'warning-soft': 'var(--color-warning-soft)',
        error:        'var(--color-error)',
        'error-soft': 'var(--color-error-soft)',
        info:         'var(--color-info)',
        'info-soft':  'var(--color-info-soft)',

        // Cycle day palette (Day 1-5)
        'cycle-1':     'var(--color-cycle-1)',
        'cycle-1-soft':'var(--color-cycle-1-soft)',
        'cycle-2':     'var(--color-cycle-2)',
        'cycle-2-soft':'var(--color-cycle-2-soft)',
        'cycle-3':     'var(--color-cycle-3)',
        'cycle-3-soft':'var(--color-cycle-3-soft)',
        'cycle-4':     'var(--color-cycle-4)',
        'cycle-4-soft':'var(--color-cycle-4-soft)',
        'cycle-5':     'var(--color-cycle-5)',
        'cycle-5-soft':'var(--color-cycle-5-soft)',
      },

      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
      },

      // Type scale (matches tokens.css)
      fontSize: {
        'display':   ['var(--text-display)',   { lineHeight: 'var(--leading-display)',   fontWeight: 'var(--weight-display)' }],
        'title-1':   ['var(--text-title-1)',   { lineHeight: 'var(--leading-title-1)',   fontWeight: 'var(--weight-title-1)' }],
        'title-2':   ['var(--text-title-2)',   { lineHeight: 'var(--leading-title-2)',   fontWeight: 'var(--weight-title-2)' }],
        'title-3':   ['var(--text-title-3)',   { lineHeight: 'var(--leading-title-3)',   fontWeight: 'var(--weight-title-3)' }],
        'body':      ['var(--text-body)',      { lineHeight: 'var(--leading-body)',      fontWeight: 'var(--weight-body)' }],
        'body-em':   ['var(--text-body-em)',   { lineHeight: 'var(--leading-body-em)',   fontWeight: 'var(--weight-body-em)' }],
        'callout':   ['var(--text-callout)',   { lineHeight: 'var(--leading-callout)',   fontWeight: 'var(--weight-callout)' }],
        'subhead':   ['var(--text-subhead)',   { lineHeight: 'var(--leading-subhead)',   fontWeight: 'var(--weight-subhead)' }],
        'footnote':  ['var(--text-footnote)',  { lineHeight: 'var(--leading-footnote)',  fontWeight: 'var(--weight-footnote)' }],
        'caption-2': ['var(--text-caption-2)', { lineHeight: 'var(--leading-caption-2)', fontWeight: 'var(--weight-caption-2)' }],
      },

      spacing: {
        'xs':   'var(--space-xs)',
        'sm':   'var(--space-sm)',
        'md':   'var(--space-md)',
        'lg':   'var(--space-lg)',
        'xl':   'var(--space-xl)',
        '2xl':  'var(--space-2xl)',
        '3xl':  'var(--space-3xl)',
        '4xl':  'var(--space-4xl)',
      },

      borderRadius: {
        'sm':    'var(--radius-sm)',
        'md':    'var(--radius-md)',
        'lg':    'var(--radius-lg)',
        'xl':    'var(--radius-xl)',
        '2xl':   'var(--radius-2xl)',
        'full':  'var(--radius-full)',
      },

      boxShadow: {
        'elev-0': 'var(--elev-0)',
        'elev-1': 'var(--elev-1)',
        'elev-2': 'var(--elev-2)',
        'elev-3': 'var(--elev-3)',
      },

      transitionDuration: {
        'fast':  'var(--duration-fast)',
        'base':  'var(--duration-base)',
        'slow':  'var(--duration-slow)',
        'sheet': 'var(--duration-sheet)',
      },

      transitionTimingFunction: {
        'out':    'var(--ease-out)',
        'spring': 'var(--ease-spring)',
      },

      maxWidth: {
        'content': 'var(--max-content-width)',
      },

      height: {
        'tabbar':  'var(--tab-bar-height)',
        'topbar':  'var(--topbar-height)',
        'input':   'var(--input-height)',
        'btn-sm':  'var(--button-sm)',
        'btn-md':  'var(--button-md)',
        'btn-lg':  'var(--button-lg)',
      },

      width: {
        'sidebar':     'var(--sidebar-expanded)',
        'sidebar-collapsed': 'var(--sidebar-collapsed)',
      },
    },
  },
  plugins: [],
};
