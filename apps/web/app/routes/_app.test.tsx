import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: {
    schoolId: 'school-1',
    userId: 'user-1',
    name: 'Ms. Test',
    email: 'test@example.com',
    role: 'teacher' as const,
  },
  selectShapes: [] as Array<Record<string, unknown>>,
  unreadRows: [{ value: 7 }] as Array<{ value: number }>,
}));

vi.mock('../../server/auth.server', () => ({
  getSession: vi.fn(async () => state.session),
}));

vi.mock('../../server/csrf.server', () => ({
  ensureCsrfCookie: () => ({ token: 'csrf', setCookie: undefined }),
}));

vi.mock('../../server/db.server', () => ({
  withSchoolId: vi.fn(async (_schoolId: string, fn: (tx: unknown) => Promise<unknown>) => {
    let selectCall = 0;
    const tx = {
      select(shape: Record<string, unknown>) {
        state.selectShapes.push(shape);
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([{
                  id: 'school-1',
                  name: 'Test School',
                  accentColor: '#123456',
                  plan: 'trial',
                  demoExpiresAt: null,
                }]),
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => Promise.resolve(state.unreadRows),
          }),
        };
      },
    };
    return fn(tx);
  }),
}));

vi.mock('../components/shell', () => ({
  Sidebar: () => null,
  Topbar: () => null,
  TabBar: () => null,
}));
vi.mock('../components/ThemeStyle', () => ({ ThemeStyle: ({ children }: { children: unknown }) => children }));
vi.mock('../components/DemoBanner', () => ({ DemoBanner: () => null }));
vi.mock('../components/ExpiredDemo', () => ({ ExpiredDemo: () => null }));

const { loader } = await import('./_app.js');

beforeEach(() => {
  state.selectShapes.length = 0;
  state.unreadRows = [{ value: 7 }];
});

describe('_app loader unread count', () => {
  it('uses the aggregate count result without selecting notification ids', async () => {
    const response = await loader({
      request: new Request('http://localhost/app'),
      params: {},
      context: {},
    } as never);
    const payload = response.data;

    expect(payload.unreadCount).toBe(7);
    expect(state.selectShapes).toHaveLength(2);
    expect(Object.keys(state.selectShapes[1] ?? {})).toEqual(['value']);
  });
});