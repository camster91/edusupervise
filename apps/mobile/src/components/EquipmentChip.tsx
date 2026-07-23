// apps/mobile/src/components/EquipmentChip.tsx
//
// Small inline pill that says "VEST" / "RADIO" / "KEYS" / "BADGE" —
// a one-token reminder to grab the right gear before walking to
// the spot. Mirrors apps/web/app/components/ui/EquipmentChips.tsx
// in spirit, but for a single chip (mobile renders one chip per
// requirement; the web has a compound component for compact +
// expanded views).
//
// We don't use icons here — text is more legible at small font
// sizes and on a phone in bright sunlight, and the "what gear do
// I need" question is more about reading than scanning.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export type EquipmentKind = 'vest' | 'radio' | 'keys' | 'badge';

export interface EquipmentChipProps {
  kind: EquipmentKind;
  /** Optional override for the visible label. Defaults to uppercase kind. */
  label?: string;
  /** Compact mode uses smaller padding for inline duty-card use. */
  compact?: boolean;
  /** Optional test hook for E2E tests. */
  testID?: string;
}

const KIND_COLORS: Record<EquipmentKind, { bg: string; fg: string }> = {
  // Mirrors the web's "info-soft" + "warning-soft" palette, lightly
  // tuned for a brighter phone display. The colors are picked from
  // the same accent palette the web uses (see apps/web/app/lib/
  // design-system.ts); the exact hex values are intentionally close
  // but not identical to keep the mobile asset bundle independent.
  vest: { bg: '#fef3c7', fg: '#92400e' },   // amber soft
  radio: { bg: '#dbeafe', fg: '#1e40af' },  // blue soft
  keys: { bg: '#e0e7ff', fg: '#3730a3' },   // indigo soft
  badge: { bg: '#fce7f3', fg: '#9d174d' },  // pink soft
};

export function EquipmentChip({
  kind,
  label,
  compact = false,
  testID,
}: EquipmentChipProps): React.ReactElement {
  const colors = KIND_COLORS[kind];
  return (
    <View
      testID={testID ?? `equipment-chip-${kind}`}
      style={[
        styles.chip,
        compact ? styles.chipCompact : null,
        { backgroundColor: colors.bg },
      ]}
      accessibilityRole="text"
      accessibilityLabel={`${label ?? kind} required`}
    >
      <Text
        style={[
          styles.label,
          compact ? styles.labelCompact : null,
          { color: colors.fg },
        ]}
      >
        {label ?? kind.toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * Helper for a duty card: given the duty's `requiresVest` /
 * `requiresRadio` flags, return the chip list to render. Keys +
 * badge are reserved for Sprint 2 (the schema doesn't carry them
 * yet on the duty row — see packages/db/src/schema.ts:310-311 for
 * the current two-flag set).
 */
export function chipsForDuty(duty: {
  requiresVest: boolean;
  requiresRadio: boolean;
}): EquipmentKind[] {
  const out: EquipmentKind[] = [];
  if (duty.requiresVest) out.push('vest');
  if (duty.requiresRadio) out.push('radio');
  return out;
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 6,
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  chipCompact: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 4,
    marginTop: 0,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  labelCompact: {
    fontSize: 10,
  },
});
