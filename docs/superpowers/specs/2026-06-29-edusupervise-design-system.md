# EduSupervise Design System — Apple HIG (Phase 2A)

*Spec for the UI refactor. Source of truth for tokens, components, layout patterns, and accessibility rules. Complements the research synthesis in `docs/superpowers/research/2026-06-28/SYNTHESIS.md` §4 (Apple-HIG design patterns) and §7 (Top 7 opportunities, #2 is this refactor).*

**Author:** orchestrator (Mavis) · **Date:** 2026-06-29 · **Phase:** 2A (UI refactor) precedes Phase 2B (Coverage Router) — see SYNTHESIS.md §8 for sequencing.

**Audience:** frontend engineers, designers, and Cameron (decision-maker on visual identity).

---

## 0. Why this doc exists

The current code base uses generic Tailwind + slate grays + rounded-2xl cards. It works, it ships, but it doesn't look like an Apple product. This refactor brings the visual language into Apple HIG (iOS 26 / Liquid Glass / WWDC25) territory. The driving finding from research:

> *The app that captures "duty roster + reminder + swap + equity hours balance" in iStudiez polish will own a category that doesn't exist yet.* — `competitive-landscape-design.md` §A.6

iStudiez Pro is the design north star for the per-teacher day view. The shell + navigation patterns should follow iOS 26 Liquid Glass idioms. The full set of 10 design decisions + 14 anti-patterns from research synthesis §4 governs every component below.

This doc specifies the contract. Each component has: tokens it uses, accessibility requirements, motion behavior, and a code skeleton. Engineers should follow the skeleton literally — the goal is a unified design language, not creative divergence.

---

## 1. Foundations

### 1.1 Color tokens

All color is **semantic, not appearance-based** (HIG Color guidelines). One accent color per school (configurable, defaults to system blue). Surfaces are off-white in light mode, near-black in dark mode. Status colors are fixed.

```css
/* Light mode (default) */
--color-bg:            #F8F9FB;   /* page background, off-white */
--color-surface:       #FFFFFF;   /* cards, sheets, hero cards */
--color-surface-2:     #F1F3F7;   /* nested surface, table headers */
--color-text-primary:  #0A0E1A;   /* body, titles */
--color-text-secondary:#525866;   /* metadata, captions */
--color-text-tertiary: #8A91A0;   /* placeholder, disabled */
--color-border:        #E4E7EE;   /* dividers, card borders */
--color-accent:        #007AFF;   /* system blue (default) */
--color-accent-soft:   #E5F1FF;   /* accent surface (selection, focus) */
--color-success:       #34C759;   /* coverage confirmed */
--color-warning:       #FF9500;   /* conflict detected */
--color-error:         #FF3B30;   /* destructive, alert */
--color-info:          #5AC8FA;   /* informational */
```

School brand color overrides ONLY `--color-accent` and `--color-accent-soft` (the latter auto-derived from the former via a utility that ships with the design system). Everything else is fixed.

```css
/* Dark mode (auto via prefers-color-scheme) */
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg:            #0A0E1A;
    --color-surface:       #14171F;
    --color-surface-2:     #1C2030;
    --color-text-primary:  #F8F9FB;
    --color-text-secondary:#9BA1B0;
    --color-text-tertiary: #5A6172;
    --color-border:        #252A3A;
    --color-accent:        #0A84FF;
    --color-accent-soft:   #1A2A40;
    --color-success:       #30D158;
    --color-warning:       #FF9F0A;
    --color-error:         #FF453A;
    --color-info:          #64D2FF;
  }
}
```

**Rule:** No raw hex in component code. Components import from `apps/web/app/lib/design-system.ts` and reference `--color-*` vars. Tailwind config maps these to `bg-surface`, `text-primary`, `border-default` etc. utility classes.

### 1.2 Typography

```css
--font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
```

**Type scale** (HIG typography, 1.2x ratio, anchored on 16px body):

| Token | Size | Line-height | Weight | Use |
|---|---|---|---|---|
| `--text-display` | 34px | 41px | 700 | hero card title (current duty name) |
| `--text-title-1` | 28px | 34px | 700 | page title |
| `--text-title-2` | 22px | 28px | 600 | section heading |
| `--text-title-3` | 20px | 25px | 600 | card title |
| `--text-body`    | 16px | 24px | 400 | body, default |
| `--text-body-em` | 16px | 24px | 600 | emphasized body |
| `--text-callout` | 15px | 20px | 400 | secondary body |
| `--text-subhead` | 13px | 18px | 600 | metadata, labels |
| `--text-footnote`| 12px | 16px | 400 | captions, timestamps |
| `--text-caption-2`| 11px| 13px | 500 | badges, chips |

**Inter is loaded via `@fontsource/inter`** (npm, 100-400 weight subset for now). SF Pro is not bundled (we're web/PWA, not native). Inter is 92% metrically similar to SF Pro (research citation [21]).

**Rule:** No raw `text-xl`, `text-2xl` etc. in component code. Use `text-title-1`, `text-body`, `text-footnote` semantic classes that map to the scale above.

### 1.3 Spacing

8pt grid, but with a 4pt half-step for tight cases. Tailwind already has 4/8/12/16/20/24/32/40/48/64 which maps cleanly.

**Semantic spacing tokens:**

| Token | Value | Use |
|---|---|---|
| `--space-xs` | 4px | between icon and label |
| `--space-sm` | 8px | within a control |
| `--space-md` | 12px | between related fields |
| `--space-lg` | 16px | card padding (small) |
| `--space-xl` | 24px | card padding (default), section gap |
| `--space-2xl` | 32px | between major sections |
| `--space-3xl` | 48px | hero card padding, page top |

**Rule:** Card padding is always `--space-xl` (24px) on phone, `--space-2xl` (32px) on iPad+. Hero cards get `--space-3xl`.

### 1.4 Motion

Spring physics, short, never bouncy. Apple HIG default: 250-350ms, ease-in-out, 0.85-1.0 scale range.

| Pattern | Duration | Easing | Notes |
|---|---|---|---|
| `transition: opacity` | 200ms | ease-out | hover, focus, dismiss |
| `transition: transform` | 250ms | cubic-bezier(0.32, 0.72, 0, 1) | sheet slide-up, tab switch |
| `transition: background-color` | 150ms | ease-out | button press |
| `transition: color` | 150ms | ease-out | link, label |
| Sheet dismiss (drag) | spring | spring(0.85, 0.85, 0.35) | native iOS feel |
| Tab indicator slide | 350ms | spring(0.7, 0.7, 0.3) | water-droplet effect |
| Pull-to-refresh | spring | spring(1, 0.85, 0.3) | translate + scale |

**Rule:** No parallax. No auto-playing animation. No confetti except once per week per user ("all duties covered this week" celebration). No bouncy easings. **No motion** when `prefers-reduced-motion: reduce`.

### 1.5 Elevation

Three levels only. No chunky shadows.

| Token | Light mode | Dark mode | Use |
|---|---|---|---|
| `--elev-0` | none | none | flat surfaces |
| `--elev-1` | `0 1px 2px rgba(10,14,26,0.04), 0 1px 1px rgba(10,14,26,0.06)` | `0 1px 2px rgba(0,0,0,0.4)` | cards, sheets |
| `--elev-2` | `0 4px 12px rgba(10,14,26,0.08), 0 1px 4px rgba(10,14,26,0.04)` | `0 4px 12px rgba(0,0,0,0.5)` | popovers, banners |
| `--elev-3` | `0 8px 24px rgba(10,14,26,0.12), 0 4px 8px rgba(10,14,26,0.06)` | `0 8px 24px rgba(0,0,0,0.6)` | modals, sheets on iPad |

Apple removed chunky shadows in iOS 7 and never brought them back. Don't.

### 1.6 Radius

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 6px | inputs, chips, small buttons |
| `--radius-md` | 10px | buttons (default) |
| `--radius-lg` | 14px | cards |
| `--radius-xl` | 20px | hero cards, sheets |
| `--radius-full` | 9999px | pills, avatars, badges |

**Anti-pattern:** Material You 28pt+ button corners are explicitly out. Default button radius is 10px.

---

## 2. Components

### 2.1 Button

Three variants. All have a 44x44pt minimum touch target (HIG requirement).

| Variant | Use | Spec |
|---|---|---|
| `primary` | single primary action per screen | `bg: --color-accent`, `color: white`, `radius: --radius-md` |
| `secondary` | supporting actions | `bg: --color-surface-2`, `color: --color-text-primary`, `border: 1px --color-border` |
| `tertiary` | inline / text-style | `bg: transparent`, `color: --color-accent`, hover: `bg: --color-accent-soft` |
| `destructive` | delete, cancel coverage, etc. | `bg: --color-error`, `color: white` |

Sizes: `sm` (32pt, caption label), `md` (40pt, body), `lg` (48pt, body-em). **Never below 32pt height** — touch target is 44x44 with extra padding.

States: `default`, `hover`, `active` (scale 0.97, 100ms), `focus` (2px ring `--color-accent`, 2px offset), `disabled` (opacity 0.4, no pointer).

### 2.2 Card

Three hierarchy levels, distinguished by elevation and padding, not color.

| Level | Elevation | Padding | Use |
|---|---|---|---|
| `surface` | `--elev-1` | `--space-xl` | list item, secondary card |
| `hero` | `--elev-1` | `--space-2xl` | top-of-page card, "Today" hero |
| `overlay` | `--elev-2` | `--space-xl` | popover content, sheet content |

**Rule:** Cards never have a colored left border or icon-with-bg. Card is white (or surface-2 in dark), border `--color-border`, content inside. Information hierarchy via type scale + spacing, not decoration.

### 2.3 HeroCard (iStudiez-style — the load-bearing component)

The single most visible component. Used on the per-teacher "Today" view. Shows the teacher's current duty, next duty, and upcoming today.

```
┌─────────────────────────────────────────────────┐
│  NOW  10:42 AM                                  │
│  Cafeteria duty · Mrs. Smith room               │
│  ─────────────────────                          │
│  NEXT  11:30 AM                                 │
│  Bus duty · Bus 7                               │
│                                                 │
│  [Swap]  [Mark complete]                        │
└─────────────────────────────────────────────────┘
```

- Background: `--color-surface`
- Border: 1px `--color-border`, radius `--radius-xl` (20px)
- Padding: `--space-2xl` (32px)
- "NOW" label: `--text-subhead`, `--color-text-secondary`, uppercase, letter-spacing 0.5px
- Time: `--text-display` (34px), `--color-text-primary`
- Duty name: `--text-title-3` (20px), `--color-text-primary`
- Location: `--text-callout`, `--color-text-secondary`
- Divider: 1px `--color-border`
- "NEXT" repeats pattern with `--text-title-2` for time (28px)

States:
- `current-active` (green dot top-right, `--color-success`)
- `conflict` (warning banner above: "You're also scheduled for PSAT proctoring at 11:30 — `resolve`")
- `upcoming-only` (no green dot, faded slightly)
- `empty` (no duty right now: "No duty right now. Next: bus at 11:30.")

Motion: on mount, time updates live (subtle pulse every minute, no animation). On swap completion, 250ms success checkmark (white check on `--color-success` circle, fades after 1.5s).

### 2.4 WeekStrip (horizon strip — W1-W6)

Used for cycle/rotation visualization. Top of any week-view page.

```
┌─────────────────────────────────────────────────┐
│   Mon     Tue     Wed     Thu     Fri   [Today] │
│   6       7       8       9      10   W2 of 6  │
│   W1      W2      W2      W2     W2            │
└─────────────────────────────────────────────────┘
```

- Horizontal scroll on phone, full visible on iPad
- Each day: 56px wide on phone, 80px on iPad
- Today: filled `--color-accent-soft` background, accent text
- "W2 of 6" badge: pill, `--color-surface-2` background, `--text-footnote`
- Tap day → load that day's view
- Liquid Glass morph on week-to-week transition (research §4 decision #1)

### 2.5 TabBar (iPhone bottom navigation)

iOS 26 HIG adaptive tab bar. 4 peer sections: **Today / Roster / Coverage / Settings**.

- Height: 49pt + safe-area-inset-bottom
- Background: `var(--color-surface)` with `backdrop-filter: blur(20px) saturate(180%)` (Liquid Glass effect on supported browsers)
- Top border: 0.5px `--color-border`
- Tab item: icon (24pt) + label (`--text-caption-2`, 11px)
- Active: `--color-accent` color, dot indicator above icon
- Inactive: `--color-text-tertiary`
- Tap target: full width / 4, minimum 44pt height

**Anti-pattern:** Tab bars are for peer sections of the app, not for primary task buttons. They are not a "home" button or "create" button. Coverage actions live in the Coverage tab as a peer, not as an FAB or tab bar item.

### 2.6 Sidebar (iPad / web)

Adaptive sidebar that auto-hides on phone, shows as collapsible on iPad, expanded on desktop.

- Width: 240pt expanded, 64pt collapsed (icon-only)
- Background: `var(--color-surface)`, 0.5px right border
- Sections: Today / Roster / Coverage / Reports / Settings (5 items at admin level)
- Active item: `--color-accent-soft` background, `--color-accent` text, 4px left accent bar
- Hover: `--color-surface-2` background

**iOS 18+ idiom:** Use `TabView` from React Router (or hand-rolled equivalent) that auto-morphs between TabBar (compact) and Sidebar (regular). Don't hand-roll the detection.

### 2.7 Sheet (modal)

For focused tasks: confirm swap, add single duty, accept coverage, alert dismissal.

- Slides up from bottom, rounded top corners (`--radius-xl`)
- Background: `--color-surface`, elevation `--elev-3`
- Detents: `[.medium, .large]` — user can drag to half-height or full-height
- Backdrop: `rgba(10,14,26,0.4)` with 200ms fade
- Dismiss: drag down, tap backdrop, or explicit close button
- Locked detent (no drag) for confirm-only flows

**Rule:** Use sheet for: add a single duty slot, confirm a swap, accept coverage, alert dismissal. **Not** for: bulk duty assignment, creating a new rotation template, building reports — those are full-page routes.

### 2.8 Banner (transient alert)

For conflict alerts and informational messages. Replaces the "red wall" pattern.

- Top of screen, 4px from safe area, full width minus 16px side padding
- Background: `--color-warning` for conflict, `--color-info` for info, `--color-error` for error, `--color-success` for confirm
- Icon: 20pt, white
- Text: `--text-callout`, white
- Action button: white text, underlined (`--color-text-primary` background on press)
- Dismiss: X icon top-right, or auto-dismiss after 8s (configurable)
- Animate in: slide-down from top, 250ms; animate out: slide-up, 200ms

**Rule:** Banners are transient, one at a time, max. **Never** stack. **Never** modal. **Never** block input.

### 2.9 EmptyState

Three-job pattern (NN/g): communicate status, provide learning cue, give direct path to key task.

```tsx
<EmptyState
  icon={<CalendarIcon size={48} />}
  title="No duties this week"
  description="Looks like your schedule is clear. Add a duty or claim a swap to get started."
  action={{ label: "Browse open swaps", onClick: () => ... }}
/>
```

- Icon: 48pt, `--color-text-tertiary`
- Title: `--text-title-3`, `--color-text-primary`
- Description: `--text-body`, `--color-text-secondary`, max 280 char
- Action: secondary button (default), or primary if it's the only path forward

### 2.10 Form primitives

Inputs, selects, checkboxes, switches. All use the same base style:

- Height: 44pt (HIG minimum touch target)
- Border: 1px `--color-border`, radius `--radius-md` (10px)
- Background: `--color-surface`
- Padding: 12px horizontal, 12px vertical
- Label: `--text-subhead`, `--color-text-secondary`, 4px above input
- Helper text: `--text-footnote`, `--color-text-tertiary`, 4px below
- Error state: border `--color-error`, helper text in `--color-error`
- Focus: 2px ring `--color-accent`, 2px offset
- Disabled: opacity 0.4

---

## 3. Layout patterns

### 3.1 Per-teacher "Today" view (the load-bearing screen)

The single most-used screen. Mobile-first design.

```
┌─────────────────────────────────────┐
│  Topbar: School name, Notification  │
├─────────────────────────────────────┤
│  HeroCard (current + next duty)     │ ← §2.3
│                                     │
│  WeekStrip (W1-W6)                  │ ← §2.4
│                                     │
│  Today                              │ ← Section heading
│  ─────                              │
│  09:00  Morning arrival  Mr. Brown  │ ← List items
│  11:30  Cafeteria       Mrs. Smith  │   (active = accent)
│  12:30  Bus duty         Bus 7      │   (conflict = warning)
│  15:15  Dismissal        Main door  │
│                                     │
│  [Coverage requests (1)]            │ ← section with badge
│  ─────                              │
│  • Mr. Brown needs bus cover Tue    │ ← swipe to accept
│                                     │
│  TabBar: Today / Roster / Coverage  │ ← §2.5
└─────────────────────────────────────┘
```

### 3.2 Admin dashboard (iPad / web)

Sidebar on left, content on right. Two-column layout on iPad (sidebar + main), three-column on desktop (sidebar + nav-rail + main).

```
┌──────────┬────────────────────────────────────────────┐
│          │  Header: school name, date, search         │
│ Sidebar  ├────────────────────────────────────────────┤
│          │                                            │
│ Today    │  Coverage status (3 uncovered today)      │
│ Roster   │  ┌─────────────┬─────────────┬───────────┐  │
│ Coverage │  │ Bus 7       │ Cafeteria   │ Dismissal │  │
│ Reports  │  │ ⚠ Uncovered │ ✓ Covered   │ ⚠ Uncov.  │  │
│ Settings │  │ [Find cover]│              │ [Find]    │  │
│          │  └─────────────┴─────────────┴───────────┘  │
│          │                                            │
│          │  Fairness report (this term)               │
│          │  ┌────────────────────────────────────┐    │
│          │  │ Mr. Smith  ████░░░░░░  3 duties    │    │
│          │  │ Mrs. Lee   ████████░░  7 duties    │    │
│          │  │ ...                                │    │
│          │  └────────────────────────────────────┘    │
└──────────┴────────────────────────────────────────────┘
```

### 3.3 Week view (all teachers)

Calendar-grid layout. iPad shows 5 days × 6 teachers in one view. iPhone shows one day at a time, swiping.

```
┌────────────────────────────────────────────────────┐
│  WeekStrip (W1-W6)                                 │
├────────────────────────────────────────────────────┤
│         Mon    Tue    Wed    Thu    Fri             │
│ 7:00    ░      ░      ░      ░      ░              │
│ 8:00    ░      ░      ░      ░      ░              │
│ 11:30   [CS]   [JL]   [CS]   [JL]   [CS] ←cafeteria│
│ 12:30   [BG]   [BG]   [BG]   [BG]   [BG] ←bus      │
│ 15:15   [EP]   [EP]   [EP]   [EP]   [EP] ←dismissal│
└────────────────────────────────────────────────────┘
```

- Cells: 56pt height on iPad, 80pt on iPad-Pro
- Duty blocks: rounded 6px, color = school accent at 20% opacity, accent text
- Conflict: 2px warning border on the conflicting cell
- Empty: surface-2 background, "—" text
- Tap cell → open duty in a sheet (§2.7)
- Long-press → multi-select mode for batch edits

### 3.4 Onboarding

Two tracks, per research §4 decision #9.

**Admin onboarding** (3-4 cards, SMS-style):
1. "Welcome to EduSupervise" + school name input
2. "Add your teachers" + CSV import or manual add
3. "Choose a duty template" + presets (Elementary Standard, Middle School 6-Period, etc.)
4. "You're all set. Here's your first week's schedule." + continue to dashboard

Each card is full-screen on iPhone, modal on iPad. "Next" button bottom-right. "Back" optional, often hidden.

**Teacher onboarding** (one screen):
```
┌─────────────────────────────────────┐
│  Welcome, Alex.                     │
│                                     │
│  Your duties this week: 3           │
│                                     │
│  Tomorrow at 11:30: Cafeteria       │
│                                     │
│  [Get started →]                    │
└─────────────────────────────────────┘
```
That's it. No settings tour, no "feature highlights" carousel. They land on Today.

---

## 4. Anti-patterns (the 14 things to never do)

Distilled from research synthesis §4 (slice 6 §B.14). Every component review and PR must check these.

1. **Notification push that isn't instant.** Subs and teachers lose seconds; minutes matter for duty reminders.
2. **Tab-bar items used for actions, not peer sections.** Coverage actions live as a Coverage tab, not a FAB.
3. **Filter controls that look active but reset silently.** Filters persist in URL state, not session state.
4. **Custom date pickers that don't match the platform picker.** Use native `<input type="date">` or a shadcn-style that mirrors it.
5. **Modal-stacked conflict pages.** Banners only.
6. **Material You 28pt+ button corners.** 10px default, no exceptions.
7. **Chunky shadows.** 1-2px subtle, not 8px+ drops.
8. **"AI gradient" purple-cyan landing pages.** Restrained palette only.
9. **Per-school logo in chrome.** Accent color only.
10. **Five-screen onboarding for teachers.** One screen, dropped into Today.
11. **Empty pages with no copy and no CTA.** Three-job pattern always.
12. **Per-teacher pricing hidden behind sales calls.** Publish on the website.
13. **Stale "Loading…" placeholders where data has loaded.** Skeleton screens with shimmer, or nothing.
14. **Drag-and-drop as primary task on iPhone.** Long-press → action menu instead.

---

## 5. Token reference (full)

Complete CSS custom properties + Tailwind config. Lives in:
- `apps/web/app/styles/tokens.css` — CSS vars (single source of truth)
- `apps/web/tailwind.config.ts` — Tailwind maps (extends the theme)
- `apps/web/app/lib/design-system.ts` — TS exports for components

The TS file re-exports the CSS var names as constants, so components import from one place:
```ts
import { colors, type, space, motion, radius, elevation } from '~/lib/design-system';
```

`~/` alias is already configured in the Vite config (per the devops gotcha: "Vite alias `~/*` doesn't resolve .ts extensions in SSR build — use relative paths `../../server/foo.ts`"). For client components, `~/lib/design-system` should work; for SSR build, fall back to `../../lib/design-system`.

---

## 6. File structure (target)

```
apps/web/app/
├── styles/
│   └── tokens.css              ← CSS vars, single source of truth
├── lib/
│   ├── design-system.ts        ← TS exports of tokens
│   ├── theme.ts                ← existing, updated to use new tokens
│   └── cn.ts                   ← existing className utility
├── components/
│   ├── shell/
│   │   ├── Sidebar.tsx         ← updated: adaptive (TabBar on phone, Sidebar on iPad+)
│   │   ├── TabBar.tsx          ← NEW: iOS 26 adaptive tab bar
│   │   ├── Topbar.tsx          ← updated: slim, HIG-style
│   │   ├── MobileNav.tsx       ← deprecated → TabBar.tsx (kept for compat, will be removed)
│   │   └── NotificationBell.tsx ← updated: HIG bell with badge
│   ├── ui/
│   │   ├── Button.tsx          ← updated: HIG spec
│   │   ├── Card.tsx            ← updated: surface / hero / overlay variants
│   │   ├── Sheet.tsx           ← NEW: modal sheet with detents
│   │   ├── Banner.tsx          ← NEW: transient alert
│   │   ├── EmptyState.tsx      ← NEW: three-job pattern
│   │   ├── HeroCard.tsx        ← NEW: iStudiez-style current/next
│   │   ├── WeekStrip.tsx       ← NEW: W1-W6 horizon
│   │   ├── Tabs.tsx            ← existing, updated
│   │   ├── Input.tsx           ← updated: HIG spec
│   │   ├── Select.tsx          ← existing
│   │   ├── Dialog.tsx          ← existing (deprecate in favor of Sheet)
│   │   └── ...                 ← Form, Popover, Table, Toast — keep as-is
│   └── auth/                   ← DELETE (cancelled better-auth leftovers)
├── routes/
│   ├── _app.tsx                ← updated: uses new Sidebar/Topbar
│   ├── _app.today._index.tsx   ← NEW: per-teacher "Today" view (the load-bearing screen)
│   ├── _app._index.tsx         ← updated: redirect to _app.today
│   ├── _app.duties._index.tsx  ← updated: uses new design system
│   ├── _app.calendar._index.tsx ← updated: uses WeekStrip
│   ├── _app.assignments._index.tsx ← updated
│   ├── _app.teachers._index.tsx ← updated
│   ├── _app.reminders._index.tsx ← updated
│   ├── _app.settings._index.tsx ← updated
│   ├── _app.settings.billing.tsx ← updated
│   ├── onboarding.admin._index.tsx ← NEW: admin wizard
│   ├── onboarding.teacher._index.tsx ← NEW: teacher one-screen
│   └── ... (other routes kept as-is)
└── routes.ts                   ← updated: add new routes
```

---

## 7. Accessibility checklist (per component PR)

Every component PR must verify:

- [ ] All interactive elements have a visible focus state (2px ring, 2px offset)
- [ ] Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text (WCAG AA)
- [ ] Tap targets ≥ 44x44pt (HIG minimum)
- [ ] `aria-label` or `aria-labelledby` on icon-only buttons
- [ ] `prefers-reduced-motion: reduce` disables non-essential motion
- [ ] `prefers-color-scheme: dark` works without code changes
- [ ] Keyboard navigation: Tab order is logical, Enter/Space activate
- [ ] Screen reader: roles are correct (`button`, `dialog`, `listitem`, etc.)
- [ ] Dynamic content: `aria-live="polite"` for banners, `aria-live="assertive"` for errors
- [ ] Forms: labels associated with inputs, errors announced, required fields marked

---

## 8. Implementation guide

### Phase 1: Foundation (this PR / this sprint)
1. Write `apps/web/app/styles/tokens.css` (CSS vars from §1)
2. Write `apps/web/app/lib/design-system.ts` (TS exports)
3. Update `apps/web/tailwind.config.ts` (map tokens to utility classes)
4. Update `apps/web/app/components/ThemeStyle.tsx` (use new tokens)
5. Update `apps/web/app/root.tsx` (import tokens CSS, set base font)
6. Clean up cancelled-worker's abandoned files: `components/auth/` (delete), `MobileNav.tsx` (replace with TabBar)
7. Build `components/ui/Button.tsx` v2 (HIG spec)
8. Build `components/ui/Card.tsx` v2 (surface / hero / overlay)
9. Build `components/ui/EmptyState.tsx` (new)
10. Build `components/ui/Banner.tsx` (new)

### Phase 2: Shell (this PR)
11. Build `components/shell/TabBar.tsx` (iOS 26 adaptive)
12. Update `components/shell/Sidebar.tsx` (adaptive, collapse on compact)
13. Update `components/shell/Topbar.tsx` (slim)
14. Update `components/shell/NotificationBell.tsx` (HIG bell with badge)
15. Update `routes/_app.tsx` (use new shell)

### Phase 3: Load-bearing view (this PR)
16. Build `components/ui/HeroCard.tsx` (iStudiez-style)
17. Build `components/ui/WeekStrip.tsx` (W1-W6)
18. Build `routes/_app.today._index.tsx` (per-teacher "Today")
19. Add `_app.today._index` to `routes.ts`
20. Update `_app._index.tsx` to redirect to `_app.today` for teachers

### Phase 4: Onboarding (this PR)
21. Build `components/ui/Sheet.tsx` (modal sheet with detents)
22. Build `routes/onboarding.admin._index.tsx` (3-4 card wizard)
23. Build `routes/onboarding.teacher._index.tsx` (one-screen welcome)
24. Add onboarding routes to `routes.ts`
25. First-run detection: if no school, redirect admin to `/onboarding/admin`; if new teacher, redirect to `/onboarding/teacher`

### Phase 5: Existing pages (this PR, light touch)
26. Refactor `_app.duties._index.tsx` to use new design system (tokens + components)
27. Refactor `_app.calendar._index.tsx` to use WeekStrip
28. Refactor `_app.teachers._index.tsx` (admin)
29. Refactor `_app.assignments._index.tsx` (admin)
30. Refactor `_app.reminders._index.tsx` (admin)
31. Refactor `_app.settings._index.tsx` + `_app.settings.billing.tsx`

### Phase 6: Polish + smoke test (this PR)
32. Verify build: `pnpm --filter web build`
33. Visual smoke test on iPhone (375pt) and iPad (768pt) viewports
34. Keyboard nav test
35. Reduced-motion test
36. Dark mode test
37. Lighthouse accessibility score ≥ 95
38. Commit + PR

---

## 9. Out of scope (defer to later sprints)

- **Capacitor wrap** (iOS + Android native) — Phase 1.5
- **Coverage Router** (the feature, not just UI) — Phase 2B
- **Parent-facing duty alerts** (UI components) — Phase 3
- **Credentials module** (UI) — Phase 3
- **Compliance-gated duty assignment** (UI) — Phase 3
- **PD rotation module** (UI) — Phase 4
- **Fairness/equity dashboard** (UI) — Phase 4
- **Sub credential portability** (UI) — Phase 4

This refactor delivers the design system + the load-bearing "Today" view. Everything else builds on top.

---

## 10. Open questions for Cameron (decision points)

These are the design decisions I made defaults on. Cameron should override any he disagrees with.

1. **School accent color override scope.** Default: only `--color-accent` and `--color-accent-soft` override. Should the school also pick a custom "danger" or "success" color? **Default: no** — keep status colors fixed, HIG style.
2. **Dark mode default.** Default: auto via `prefers-color-scheme`, no toggle. Should we ship a manual light/dark toggle? **Default: no** for v1, add in v2.
3. **Custom typography per school.** Default: Inter for everyone, no school override. Should a school be able to upload a custom font? **Default: no** — adds complexity, breaks HIG.
4. **Tab bar 4 vs 5 sections.** Default: 4 (Today / Roster / Coverage / Settings) for teachers; 5 (Today / Roster / Coverage / Reports / Settings) for admins. Alternative: collapse Coverage into Roster for teachers. **Default: 4 sections for teachers** — Coverage is a separate peer section.
5. **Hero card on iPad.** Default: same component, centered, max-width 480pt. Alternative: split into 2-column layout. **Default: centered single column** — cleaner, more focused.

---

## 11. References

- `docs/superpowers/research/2026-06-28/competitive-landscape-design.md` §A.6 (iStudiez Pro north star), §B.2-B.12 (HIG patterns), §B.14 (anti-patterns)
- `docs/superpowers/research/2026-06-28/SYNTHESIS.md` §3.3 (iStudiez Pro is the design north star), §4 (distilled HIG patterns), §7 opp #2 (UI refactor is opportunity #2)
- Apple Human Interface Guidelines — [developer.apple.com/design/human-interface-guidelines](https://developer.apple.com/design/human-interface-guidelines/) (Tab bars, Sheets, Color, Typography, Materials, Alters, Motion)
- WWDC25 Session 356 — Get to know the new design system (Liquid Glass)
- iOS 26 Liquid Glass reference — research citation [19]
- iStudiez Pro — research citation [14]
- Apple Reminders iOS 18+ inline-edit pattern — research citation [26]
- NN/g Empty States — research citation [27]
- Inter font — research citation [21]
- WCAG 2.2 AA — [w3.org/WAI/WCAG22/quickref](https://www.w3.org/WAI/WCAG22/quickref/)

---

**End of design system spec. Estimated implementation time: 8-12 hours focused work for one engineer, or 3-4 days with review + polish. This is the contract; the components follow the contract literally.**
