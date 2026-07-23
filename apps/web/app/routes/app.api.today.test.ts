import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/auth.server', () => ({ getSession: vi.fn() }));
vi.mock('../../server/today.server', () => ({ loadTodayData: vi.fn() }));
vi.mock('../../server/logger.server', () => ({
  logger: { error: vi.fn() },
}));

const payload = {
  role: 'teacher',
  userId: 'user-1',
  today: '2026-03-07',
  tomorrow: '2026-03-08',
  weekFromNow: '2026-03-14',
  allDuties: [],
  myAssignments: [],
  cycleDay: null,
  isSchoolDay: true,
  stats: {
    totalDuties: 0,
    totalLocations: 0,
    myUpcoming: 0,
    myMinutesPerWeek: 0,
  },
  groupRoster: {},
  recurringDuties: [],
  showOnboardingBanner: true,
  reminderMap: {},
};

describe('GET /app/api/today contract', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getSession } = await import('../../server/auth.server');
    const { loadTodayData } = await import('../../server/today.server');
    vi.mocked(getSession).mockResolvedValue({
      schoolId: 'school-1',
      userId: 'user-1',
      role: 'teacher',
      email: 'teacher@example.com',
      name: 'Teacher',
    });
    vi.mocked(loadTodayData).mockResolvedValue(payload as never);
  });

  it('returns the shared loader payload unchanged with no-store caching', async () => {
    const { loader } = await import('./app.api.today');
    const { loadTodayData } = await import('../../server/today.server');
    const response = await loader({
      request: new Request('http://localhost/app/api/today', {
        headers: { Accept: 'application/json' },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(payload);
    expect(loadTodayData).toHaveBeenCalledTimes(1);
  });

  it('does not expose JSON without authentication', async () => {
    const { getSession } = await import('../../server/auth.server');
    vi.mocked(getSession).mockResolvedValue(null);
    const { loader } = await import('./app.api.today');
    const response = await loader({
      request: new Request('http://localhost/app/api/today', {
        headers: { Accept: 'application/json' },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('redirects ordinary browser navigation to the web Today page', async () => {
    const { loader } = await import('./app.api.today');
    const response = await loader({
      request: new Request('http://localhost/app/api/today'),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/app/today');
  });
});
