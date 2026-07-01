// components/ui/EquipmentChips.tsx — small colored chips on duty
// cards showing what equipment / role requirements the duty needs.
//
// Inspired by the reference Replit prototype's "Safety Vest Required"
// + "Communication Radio Required" callouts. Extended with two more
// flags (keys + ID badge) and made smaller so they fit as inline
// chips without crowding the duty card.
//
// Source-of-truth: `duties` table columns `requires_vest`,
// `requires_radio`. `requires_keys` + `requires_id_badge` are
// planned for v2 (schema migration) — the chip set already renders
// them and degrades gracefully when the flags are absent.

import { ShieldCheck, Radio, KeyRound, IdCard } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface EquipmentChipsProps {
  requiresVest?: boolean;
  requiresRadio?: boolean;
  /** v2 — schema column not yet added. */
  requiresKeys?: boolean;
  /** v2 — schema column not yet added. */
  requiresIdBadge?: boolean;
  /** Compact = chip only (no label), inline-friendly. Default true. */
  compact?: boolean;
  className?: string;
}

interface ChipDef {
  key: keyof Omit<EquipmentChipsProps, 'compact' | 'className'>;
  label: string;
  icon: typeof ShieldCheck;
  /** Tailwind classes for background + text. */
  tone: string;
}

const CHIPS: ChipDef[] = [
  { key: 'requiresVest',    label: 'Vest',     icon: ShieldCheck, tone: 'bg-warning-soft text-warning' },
  { key: 'requiresRadio',   label: 'Radio',    icon: Radio,       tone: 'bg-info-soft text-info' },
  { key: 'requiresKeys',    label: 'Keys',     icon: KeyRound,    tone: 'bg-surface-2 text-secondary' },
  { key: 'requiresIdBadge', label: 'Badge',    icon: IdCard,      tone: 'bg-success-soft text-success' },
];

export function EquipmentChips(props: EquipmentChipsProps): React.ReactElement | null {
  const active = CHIPS.filter((c) => props[c.key]);
  if (active.length === 0) return null;

  return (
    <ul
      className={cn('flex flex-wrap gap-xs', props.className)}
      role="list"
      aria-label="Required equipment"
    >
      {active.map(({ key, label, icon: Icon, tone }) => (
        <li key={key}>
          <span
            className={cn(
              'inline-flex items-center gap-xs',
              'rounded-full font-medium',
              props.compact ? 'h-5 px-xs text-caption-2' : 'h-6 px-sm text-footnote',
              tone,
            )}
          >
            <Icon size={props.compact ? 10 : 12} aria-hidden />
            {!props.compact && <span>{label}</span>}
            {props.compact && <span className="sr-only">{label}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}