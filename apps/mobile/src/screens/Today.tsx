// apps/mobile/src/screens/Today.tsx
//
// Today screen — Sprint 1 of the EduSupervise mobile companion.
//
// What this screen renders, top to bottom:
//   1. Cycle day / "no school" / "solo onboarding" header chip
//   2. Stats strip (4 cards mirroring the web's StatsRow)
//   3. "Today" section — duty cards in chronological order
//   4. Empty state when there are no duties
//
// State + data flow:
//   useToday() owns the fetch + optimistic mark-complete logic.
//   The screen is presentational on top of that hook — it does
//   not call fetch directly.
//
// The web equivalent is at
//   apps/web/app/routes/_app.today._index.tsx
// but this is a separate component; we did NOT port the web
// component, only its data shape and intent (per slice B's
// task spec).
//
// Refresh behavior: pull-to-refresh on iOS + Android via the
// standard React Native RefreshControl. Optimistic mark-complete
// in the hook rolls back on non-204 responses.

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useToday } from '@/hooks/useToday';
import { DutyCard, formatTime12h } from '@/components/DutyCard';

export function Today(): React.ReactElement {
  const router = useRouter();
  const {
    loading,
    refreshing,
    error,
    data,
    sessionExpired,
    markComplete,
    refresh,
  } = useToday();
  // Per-duty in-flight tracker. The hook is shared across duties
  // and a single mark-complete in flight at a time is enough for
  // Sprint 1, but we keep a per-duty set so double-tap on the
  // same card doesn't fire two POSTs.
  const [marking, setMarking] = useState<Set<string>>(
    () => new Set<string>(),
  );

  const onMarkPress = useCallback(
    async (dutyId: string) => {
      if (marking.has(dutyId)) return;
      const next = new Set(marking);
      next.add(dutyId);
      setMarking(next);
      try {
        const result = await markComplete(dutyId);
        if (result.ok) {
          // Lightweight confirmation. The optimistic "Done" badge
          // already shows on the card; the toast is just the
          // "yep, the server heard you" reassurance.
          Alert.alert('Marked complete', 'Your admin has been notified.', [
            { text: 'OK' },
          ]);
        } else if (result.reason === 'ea_coverage_flow') {
          Alert.alert(
            'Use the coverage flow',
            'Educational assistants cover via the coverage flow, not the mark-complete button.',
            [{ text: 'OK' }],
          );
        } else if (result.reason === 'session_expired') {
          Alert.alert('Session expired', 'Please sign in again.', [
            {
              text: 'Sign in',
              onPress: () => router.replace('/sign-in'),
            },
          ]);
        } else {
          Alert.alert(
            'Could not mark complete',
            `Please try again. (${result.reason})`,
            [{ text: 'OK' }],
          );
        }
      } finally {
        const after = new Set(marking);
        after.delete(dutyId);
        setMarking(after);
      }
    },
    [marking, markComplete, router],
  );

  // ---- Loading skeleton (first paint) -------------------------------
  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.textPrimary} />
          <Text style={styles.loadingText}>Loading your duties…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ---- Session expired ----------------------------------------------
  if (sessionExpired) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={styles.center}>
          <Text style={styles.title}>Sign in again</Text>
          <Text style={styles.body}>
            Your session expired. Sign in to see your duties.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/sign-in')}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed ? styles.primaryButtonPressed : null,
            ]}
          >
            <Text style={styles.primaryButtonText}>Sign in</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ---- Error state (network / 5xx) ---------------------------------
  if (error || !data) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} />
          }
        >
          <View style={styles.center}>
            <Text style={styles.title}>Could not load your duties</Text>
            <Text style={styles.body}>
              Check your network and pull down to refresh.
            </Text>
            {error && <Text style={styles.errorText}>Error: {error}</Text>}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- Loaded -------------------------------------------------------
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} />
        }
      >
        {/* Header chip: cycle day / "not a school day" / onboarding */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            {data.isSchoolDay
              ? data.cycleDay
                ? `Day ${data.cycleDay}`
                : 'Today'
              : 'No school today'}
          </Text>
          <Text style={styles.headerSubtitle}>
            {data.isSchoolDay
              ? 'Your duties, in order'
              : 'Enjoy the day off.'}
          </Text>
        </View>

        {/* Solo onboarding banner — solo teachers with no duties yet */}
        {data.showOnboardingBanner && (
          <View style={styles.onboardingBanner} testID="onboarding-solo-banner">
            <Text style={styles.onboardingTitle}>
              Welcome — let's add your first duty
            </Text>
            <Text style={styles.onboardingBody}>
              Five short steps and you'll have your first duty scheduled
              with a reminder. No school setup, no admin involvement.
            </Text>
            <Pressable
              accessibilityRole="link"
              onPress={() => {
                // Web-only onboarding wizard for Sprint 1. Sprint 2
                // brings the wizard into the mobile app.
                Alert.alert(
                  'Open the web app',
                  'The onboarding wizard lives on the web for now. Open edusupervise.ashbi.ca/onboarding/solo on your laptop.',
                  [{ text: 'OK' }],
                );
              }}
              style={({ pressed }) => [
                styles.onboardingButton,
                pressed ? styles.onboardingButtonPressed : null,
              ]}
            >
              <Text style={styles.onboardingButtonText}>
                Set up my first duty
              </Text>
            </Pressable>
          </View>
        )}

        {/* Stats row */}
        <View style={styles.statsRow}>
          <Stat
            value={String(data.stats.myUpcoming)}
            label="My upcoming"
            caption="next 7 days"
          />
          <Stat
            value={formatHours(data.stats.myMinutesPerWeek)}
            label="Hours / week"
            caption="your schedule"
          />
          <Stat
            value={String(data.stats.totalDuties)}
            label="Total duties"
            caption="school-wide"
          />
          <Stat
            value={String(data.stats.totalLocations)}
            label="Locations"
            caption="school-wide"
          />
        </View>

        {/* Today's list */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Today</Text>
            <Text style={styles.sectionMeta}>
              {data.isSchoolDay && data.cycleDay
                ? `Day ${data.cycleDay}`
                : data.isSchoolDay
                  ? 'No cycle info'
                  : 'No school'}
            </Text>
          </View>

          {data.myDuties.length === 0 ? (
            data.isSchoolDay ? (
              <EmptyState
                title="No duties today"
                body="You're not assigned to any duties for the current cycle day. Check back tomorrow."
              />
            ) : (
              <EmptyState
                title="No school today"
                body="Enjoy the day off."
              />
            )
          ) : (
            data.myDuties.map((d) => (
              <DutyCard
                key={d.id}
                duty={d}
                colleagues={data.colleaguesByDuty[d.id] ?? []}
                isEducationalAssistant={data.isEducationalAssistant}
                isMarkingComplete={marking.has(d.id)}
                isOptimisticallyComplete={data.completedDutyIds.has(d.id)}
                onMarkComplete={onMarkPress}
              />
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Local helpers — kept in the screen file because they're not used elsewhere.
// ---------------------------------------------------------------------------

function Stat({
  value,
  label,
  caption,
}: {
  value: string;
  label: string;
  caption: string;
}): React.ReactElement {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statCaption}>{caption}</Text>
    </View>
  );
}

function EmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

function formatHours(minutes: number): string {
  if (minutes <= 0) return '0h';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}.${Math.round((m / 60) * 10)}h`;
}

const COLORS = {
  bg: '#f9fafb',
  card: '#ffffff',
  border: '#e5e7eb',
  textPrimary: '#111827',
  textSecondary: '#6b7280',
  textTertiary: '#9ca3af',
  accent: '#2563eb',
  accentSoft: '#eff6ff',
  warning: '#d97706',
  warningSoft: '#fef3c7',
  error: '#dc2626',
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginBottom: 16,
  },
  errorText: {
    fontSize: 12,
    color: COLORS.error,
    marginTop: 8,
  },
  primaryButton: {
    backgroundColor: COLORS.textPrimary,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  primaryButtonPressed: { opacity: 0.7 },
  primaryButtonText: {
    color: COLORS.card,
    fontSize: 14,
    fontWeight: '600',
  },
  header: {
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  headerSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  onboardingBanner: {
    backgroundColor: COLORS.warningSoft,
    borderColor: COLORS.warning,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  onboardingTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: 4,
  },
  onboardingBody: {
    fontSize: 13,
    color: COLORS.textPrimary,
    marginBottom: 12,
  },
  onboardingButton: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  onboardingButtonPressed: { opacity: 0.85 },
  onboardingButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    marginHorizontal: -4,
    marginBottom: 20,
  },
  stat: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    marginHorizontal: 4,
    alignItems: 'flex-start',
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statCaption: {
    fontSize: 10,
    color: COLORS.textTertiary,
    marginTop: 2,
  },
  section: {
    marginTop: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  sectionMeta: {
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  empty: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 24,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: 4,
  },
  emptyBody: {
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
});
