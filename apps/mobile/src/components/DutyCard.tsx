// apps/mobile/src/components/DutyCard.tsx
//
// One duty row in the Today list. Mirrors the web's DutyCard
// (apps/web/app/routes/_app.today._index.tsx:624-724) but in a
// flat vertical layout that works at phone widths. The card is
// dumb — all state (loading, optimistic complete, role) lives
// in the parent (Today screen + useToday hook). The card just
// renders + fires callbacks.
//
// Props intentionally explicit (no context) so the card can be
// reused on the Upcoming screen (F7) without ceremony.

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { EquipmentChip, chipsForDuty } from './EquipmentChip';
import type { GroupRosterMember, TodayDuty } from '../types/api';

export interface DutyCardProps {
  duty: TodayDuty;
  /** Other teachers on the same duty (excluding the current user). */
  colleagues: GroupRosterMember[];
  /** True if the user is an EA — swaps the action button for a "Covering" badge. */
  isEducationalAssistant: boolean;
  /** True while a mark-complete request is in flight for this duty. */
  isMarkingComplete: boolean;
  /** Whether the optimistic mark-complete has fired (UI feedback). */
  isOptimisticallyComplete: boolean;
  onMarkComplete: (dutyId: string) => void;
  onSwapPress?: (dutyId: string) => void;
  testID?: string;
}

const COLORS = {
  bg: '#ffffff',
  border: '#e5e7eb',
  borderDivider: '#f3f4f6',
  textPrimary: '#111827',
  textSecondary: '#6b7280',
  textTertiary: '#9ca3af',
  accent: '#2563eb',
  accentSoft: '#eff6ff',
  success: '#10b981',
  successSoft: '#d1fae5',
};

export function DutyCard({
  duty,
  colleagues,
  isEducationalAssistant,
  isMarkingComplete,
  isOptimisticallyComplete,
  onMarkComplete,
  onSwapPress,
  testID,
}: DutyCardProps): React.ReactElement {
  const chips = chipsForDuty(duty);
  const colleagueLabel =
    colleagues.length === 0
      ? null
      : colleagues.length === 1
        ? "You're covering with 1 other"
        : `You're covering with ${colleagues.length} others`;

  return (
    <View
      testID={testID ?? `duty-card-${duty.id}`}
      style={styles.card}
      accessibilityRole="summary"
      accessibilityLabel={`${duty.name} at ${formatTime12h(duty.startTime)}`}
    >
      <View style={styles.row}>
        <View style={styles.timeColumn}>
          <Text style={styles.time}>{formatTime12h(duty.startTime)}</Text>
          {duty.endTime && (
            <Text style={styles.timeEnd}>
              {'\u2192'} {formatTime12h(duty.endTime)}
            </Text>
          )}
        </View>
        <View style={styles.bodyColumn}>
          <Text style={styles.name}>{duty.name}</Text>
          {duty.location && duty.location !== duty.name && (
            <Text style={styles.location}>{duty.location}</Text>
          )}
          {colleagueLabel && (
            <Text style={styles.colleagues} testID="group-duty-note">
              {colleagueLabel}
            </Text>
          )}
          {chips.length > 0 && (
            <View style={styles.chipsRow}>
              {chips.map((c) => (
                <EquipmentChip key={c} kind={c} compact />
              ))}
            </View>
          )}
        </View>
        <View style={styles.actionsColumn}>
          {isEducationalAssistant ? (
            <View
              testID="ea-covering-badge"
              style={styles.coveringBadge}
              accessibilityLabel={`Covering ${duty.name}`}
            >
              <Text style={styles.coveringBadgeText}>Covering</Text>
            </View>
          ) : isOptimisticallyComplete ? (
            <View
              testID="duty-complete-done"
              style={styles.doneBadge}
              accessibilityRole="text"
              accessibilityLabel={`${duty.name} marked complete`}
            >
              <Text style={styles.doneBadgeText}>Done</Text>
            </View>
          ) : (
            <Pressable
              onPress={() => onMarkComplete(duty.id)}
              disabled={isMarkingComplete}
              testID={`mark-complete-${duty.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Mark ${duty.name} complete`}
              accessibilityState={{ disabled: isMarkingComplete, busy: isMarkingComplete }}
              style={({ pressed }) => [
                styles.markButton,
                pressed ? styles.markButtonPressed : null,
                isMarkingComplete ? styles.markButtonDisabled : null,
              ]}
            >
              {isMarkingComplete ? (
                <ActivityIndicator size="small" color={COLORS.textPrimary} />
              ) : (
                <Text style={styles.markButtonText}>Mark complete</Text>
              )}
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * 12-hour time formatter — mirrors the web's formatTime12h helper
 * (apps/web/app/routes/_app.today._index.tsx:1064-1071). Returns
 * "—" for missing time, the raw input if it doesn't parse.
 */
export function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const parts = hhmm.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  timeColumn: {
    width: 72,
    marginRight: 12,
  },
  time: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  timeEnd: {
    fontSize: 11,
    color: COLORS.textTertiary,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  bodyColumn: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  location: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  colleagues: {
    fontSize: 12,
    color: COLORS.accent,
    marginTop: 4,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
  },
  actionsColumn: {
    marginLeft: 12,
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
  },
  markButton: {
    backgroundColor: COLORS.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 100,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markButtonPressed: {
    opacity: 0.7,
  },
  markButtonDisabled: {
    backgroundColor: COLORS.border,
  },
  markButtonText: {
    color: COLORS.bg,
    fontSize: 13,
    fontWeight: '600',
  },
  doneBadge: {
    backgroundColor: COLORS.successSoft,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  doneBadgeText: {
    color: COLORS.success,
    fontSize: 13,
    fontWeight: '600',
  },
  coveringBadge: {
    backgroundColor: COLORS.accentSoft,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  coveringBadgeText: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '600',
  },
});
