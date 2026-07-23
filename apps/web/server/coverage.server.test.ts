import { beforeEach, describe, expect, it, vi } from 'vitest';

const realDb = vi.hoisted(async () => import('@edusupervise/db'));
const schema = await realDb;

const state = vi.hoisted(() => ({
  insertRows: [] as Array<{ id: string }>,
  existingRows: [] as Array<{ id: string }>,
  conflictConfigs: [] as unknown[],
  selectCalls: 0,
}));

function tx() {
  return {
    insert: vi.fn(() => ({
      values: () => ({
        onConflictDoNothing(config: unknown) {
          state.conflictConfigs.push(config);
          return { returning: () => Promise.resolve(state.insertRows) };
        },
        returning: () => Promise.resolve(state.insertRows),
      }),
    })),
    select: vi.fn(() => {
      state.selectCalls += 1;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(state.existingRows),
          }),
        }),
      };
    }),
  };
}

vi.mock('@edusupervise/db', () => ({
  ...schema,
  getSystemClient: vi.fn(),
}));
vi.mock('./db.server', () => ({
  getDb: vi.fn(),
  withSchoolId: vi.fn(async (_schoolId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(tx()),
  ),
}));
vi.mock('./logger.server', () => ({ logger: { warn: vi.fn() } }));
vi.mock('./audit.server', () => ({ recordAudit: vi.fn(), AUDIT: {} }));

const { recordAbsence } = await import('./coverage.server.js');

beforeEach(() => {
  state.insertRows = [];
  state.existingRows = [];
  state.conflictConfigs.length = 0;
  state.selectCalls = 0;
});

describe('recordAbsence idempotency', () => {
  const args = {
    schoolId: 'school-1',
    teacherId: 'teacher-1',
    absenceDate: '2026-09-01',
    source: 'frontline' as const,
    externalId: 'provider-event-1',
    createdBy: 'admin-1',
  };

  it('inserts with the tenant-scoped partial conflict target', async () => {
    state.insertRows = [{ id: 'event-new' }];

    await expect(recordAbsence(args)).resolves.toEqual({
      id: 'event-new',
      deduplicated: false,
    });
    expect(state.conflictConfigs).toHaveLength(1);
    expect(state.selectCalls).toBe(0);
  });

  it('loads the winning row when a concurrent insert conflicts', async () => {
    state.existingRows = [{ id: 'event-existing' }];

    await expect(recordAbsence(args)).resolves.toEqual({
      id: 'event-existing',
      deduplicated: true,
    });
    expect(state.selectCalls).toBe(1);
  });
});