import { beforeEach, describe, expect, it, vi } from 'vitest';

const realDb = vi.hoisted(async () => import('@edusupervise/db'));
const schema = await realDb;

const state = vi.hoisted(() => ({
  assignmentRows: [] as Array<Record<string, unknown>>,
  teacherRows: [] as Array<Record<string, unknown>>,
  parentRows: [] as Array<{ id: string }>,
  insertedRows: [] as Array<{ parentId: string }>,
  insertedValues: [] as Array<Record<string, unknown>>,
  insertCalls: 0,
  closeCalls: 0,
}));

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows);
  chain.then = (
    resolve: (value: unknown[]) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function runtimeTx() {
  let selectCall = 0;
  return {
    select: vi.fn(() => {
      selectCall += 1;
      return selectChain(selectCall === 1 ? state.teacherRows : state.parentRows);
    }),
    insert: vi.fn(() => {
      state.insertCalls += 1;
      return {
        values(values: Array<Record<string, unknown>>) {
          state.insertedValues = values;
          return {
            onConflictDoNothing() {
              return {
                returning: () => Promise.resolve(state.insertedRows),
              };
            },
          };
        },
      };
    }),
  };
}

vi.mock('@edusupervise/db', () => ({
  ...schema,
  getSystemClient: () => ({
    db: { select: () => selectChain(state.assignmentRows) },
    close: async () => { state.closeCalls += 1; },
  }),
}));

vi.mock('./db.server', () => ({
  getDb: vi.fn(),
  withSchoolId: vi.fn(async (_schoolId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(runtimeTx()),
  ),
}));

const { generateAlertsForAssignment } = await import('./parent-alerts.server.js');

beforeEach(() => {
  state.assignmentRows = [{
    id: 'assignment-1',
    schoolId: 'school-1',
    dutyId: 'duty-1',
    originalTeacherId: 'teacher-old',
    newTeacherId: 'teacher-new',
    eventId: 'event-1',
    absenceDate: '2026-09-01',
    dutyLocation: 'Bus 7',
    dutyStartTime: '08:00:00',
    dutyEndTime: '08:30:00',
    originalTeacherName: 'Mr. Original',
  }];
  state.teacherRows = [{ name: 'Ms. Cover' }];
  state.parentRows = [{ id: 'parent-1' }, { id: 'parent-2' }, { id: 'parent-3' }];
  state.insertedRows = [];
  state.insertedValues = [];
  state.insertCalls = 0;
  state.closeCalls = 0;
});

describe('generateAlertsForAssignment reliability', () => {
  it('uses one bulk insert and counts conflicts from RETURNING', async () => {
    state.insertedRows = [{ parentId: 'parent-1' }, { parentId: 'parent-3' }];

    const result = await generateAlertsForAssignment({
      coverageAssignmentId: 'assignment-1',
    });

    expect(state.insertCalls).toBe(1);
    expect(state.insertedValues).toHaveLength(3);
    expect(result).toEqual({ created: 2, skipped: 1 });
    expect(state.closeCalls).toBe(1);
  });

  it('deduplicates matching parent ids before the insert and count', async () => {
    state.parentRows = [{ id: 'parent-1' }, { id: 'parent-1' }, { id: 'parent-2' }];
    state.insertedRows = [{ parentId: 'parent-1' }];

    const result = await generateAlertsForAssignment({
      coverageAssignmentId: 'assignment-1',
    });

    expect(state.insertedValues.map((row) => row.parentId)).toEqual([
      'parent-1',
      'parent-2',
    ]);
    expect(result).toEqual({ created: 1, skipped: 1 });
  });
});