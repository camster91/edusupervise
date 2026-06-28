// apps/web/app/routes/_index.tsx — landing route.
//
// Placeholder landing page so the foundation Dockerfile.web can build a
// non-empty route table. The real marketing copy + signup CTA live in the
// `frontend-shell` task.

import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => [
  { title: 'EduSupervise' },
  { name: 'description', content: 'Multi-tenant SaaS for K-12 supervision duty scheduling.' },
];

export default function Index() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>EduSupervise</h1>
      <p>
        Multi-tenant SaaS for K-12 schools to schedule teacher supervision duties
        and dispatch reminders to staff. Sign-up flow and dashboard coming with
        the next task.
      </p>
    </main>
  );
}