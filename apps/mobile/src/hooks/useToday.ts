// apps/mobile/src/hooks/useToday.ts
//
// useToday — fetch + state for the Today screen. Pulls the JSON
// payload from GET /app/api/today, derives "my duties for today"
// (a stable ordering + group roster annotation), and exposes
// optimistic mark-complete via the duty-complete helper.
//
// State machine (Sprint 1, intentionally simple):
//   idle → loading → success
//                       ↘ error (network / 5xx / 401)
//   success → refreshing (pull-to-refresh)
//                       ↘ error (stays on cached data)
//
// We deliberately use useState + a small ref to the latest fetch —
// no react-query, no zustand. Sprint 1 is a single screen; the
// hook is fully self-contained. When Sprint 2 adds the
// notifications inbox, the same hook can be lifted to a context
// (slice C's push registration will trigger an invalidate()).
//
// Integration with slice A:
//   - `api.get<T>()` from `@/lib/api` returns an `ApiEnvelope<T>`
//     (no throws). We branch on `.status` / `.ok` instead of
//     try/catch. The Today screen branches on the `error` /
//     `sessionExpired` state we derive from the envelope.
//   - Cookies + CSRF are auto-attached by apiFetch — no manual
//     Cookie/x-csrf-token headers here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getApiBaseUrl } from '@/lib/api';
import { markDutyComplete, type MarkCompleteResult } from '@/lib/duty-complete';
import type {
  GroupRosterMember,
  TodayAssignment,
  TodayDuty,
  TodayResponse,
} from '@/types/api';

export interface TodayDerived {
  /** Filtered + sorted duties the teacher is on for today. */
  myDuties: TodayDuty[];
  /** Per-duty list of colleagues, excluding the current user. */
  colleaguesByDuty: Record<string, GroupRosterMember[]>;
  /** Set of duty ids optimistically marked complete; cleared on refresh. */
  completedDutyIds: Set<string>;
  /** True when the user is an EA — UI swaps the action button for a "Covering" badge. */
  isEducationalAssistant: boolean;
  /** Cycle day for the header chip, null on holidays / non-school days. */
  cycleDay: number | null;
  /** Server says today is a school day. */
  isSchoolDay: boolean;
  /** YYYY-MM-DD strings in the school's timezone. */
  today: string;
  tomorrow: string;
  weekFromNow: string;
  /** Stats: total duties / locations / my upcoming / minutes/week. */
  stats: TodayResponse['stats'];
  /** "Show the onboarding banner" — set by server for solo teachers with no duties. */
  showOnboardingBanner: boolean;
}

export interface UseTodayState {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  data: TodayDerived | null;
  /** True if the latest /app/api/today call returned 401. */
  sessionExpired: boolean;
  /**
   * Optimistic + server-side mark complete. Returns the result
   * so the caller can show a toast on success or roll back on
   * failure.
   */
  markComplete: (dutyId: string) => Promise<MarkCompleteResult>;
  /** Trigger a pull-to-refresh fetch. */
  refresh: () => Promise<void>;
  /** Manually re-run the initial loader (e.g. after sign-in). */
  reload: () => Promise<void>;
}

function derive(
  payload: TodayResponse,
  completed: Set<string>,
): TodayDerived {
  const myDutyIds = new Set<string>(
    payload.myAssignments.map((a: TodayAssignment) => a.dutyId),
  );
  const myDuties = payload.allDuties
    .filter((d: TodayDuty) => myDutyIds.has(d.id) && !completed.has(d.id))
    .sort((a, b) =>
      (a.startTime ?? '').localeCompare(b.startTime ?? ''),
    );

  const colleaguesByDuty: Record<string, GroupRosterMember[]> = {};
  for (const d of myDuties) {
    const all = payload.groupRoster[d.id] ?? [];
    colleaguesByDuty[d.id] = all.filter(
      (c) => c.userId !== payload.userId,
    );
  }

  return {
    myDuties,
    colleaguesByDuty,
    completedDutyIds: completed,
    isEducationalAssistant: payload.role === 'educational_assistant',
    cycleDay: payload.cycleDay,
    isSchoolDay: payload.isSchoolDay,
    today: payload.today,
    tomorrow: payload.tomorrow,
    weekFromNow: payload.weekFromNow,
    stats: payload.stats,
    showOnboardingBanner: payload.showOnboardingBanner,
  };
}

export function useToday(): UseTodayState {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [payload, setPayload] = useState<TodayResponse | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(
    () => new Set<string>(),
  );
  // useRef so the mark-complete closure sees the latest completed
  // set without re-creating the function on every state change.
  const completedRef = useRef<Set<string>>(completed);
  useEffect(() => {
    completedRef.current = completed;
  }, [completed]);

  const runFetch = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      setError(null);

      const res = await api.get<TodayResponse>(
        `${getApiBaseUrl()}/app/api/today`,
      );

      if (res.status === 401) {
        setSessionExpired(true);
        setPayload(null);
        setError('session_expired');
      } else if (!res.ok || !res.data) {
        setError(
          res.status === 0
            ? 'network_error'
            : res.status >= 500
              ? 'server_error'
              : `http_${res.status}`,
        );
      } else {
        setSessionExpired(false);
        setPayload(res.data);
        // Clear optimistic completes on a successful refresh — the
        // server's view is the source of truth.
        setCompleted(new Set<string>());
      }

      if (mode === 'initial') setLoading(false);
      else setRefreshing(false);
    },
    [],
  );

  // Initial mount fetch.
  useEffect(() => {
    runFetch('initial');
  }, [runFetch]);

  const refresh = useCallback(async () => {
    await runFetch('refresh');
  }, [runFetch]);

  const reload = useCallback(async () => {
    setLoading(true);
    await runFetch('initial');
  }, [runFetch]);

  const markComplete = useCallback(
    async (dutyId: string): Promise<MarkCompleteResult> => {
      // Optimistic update: hide the card immediately.
      const prev = new Set(completedRef.current);
      const next = new Set(prev);
      next.add(dutyId);
      completedRef.current = next;
      setCompleted(next);

      const result = await markDutyComplete(dutyId);
      if (!result.ok) {
        // Roll back. 403 (EA) and 401 (session expired) both
        // trigger a refetch so the server's view of the world is
        // reflected.
        completedRef.current = prev;
        setCompleted(prev);
        if (result.status === 401) {
          setSessionExpired(true);
        } else if (result.status === 403) {
          // Re-pull — the server now knows the EA's state.
          await runFetch('refresh');
        }
      }
      return result;
    },
    [runFetch],
  );

  const derived = useMemo<TodayDerived | null>(() => {
    if (!payload) return null;
    return derive(payload, completed);
  }, [payload, completed]);

  return useMemo<UseTodayState>(
    () => ({
      loading,
      refreshing,
      error,
      data: derived ?? null,
      sessionExpired,
      markComplete,
      refresh,
      reload,
    }),
    [loading, refreshing, error, derived, sessionExpired, markComplete, refresh, reload],
  );
}
