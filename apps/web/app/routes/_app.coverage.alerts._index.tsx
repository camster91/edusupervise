// apps/web/app/routes/_app.coverage.alerts._index.tsx — Parent alerts
// dashboard (Phase 3).
//
// Admin-only. Shows draft + sent parent alerts. Drafts can be
// "sent" (mock for v1) or cancelled. Real SMS/email dispatch is
// v2 (slice 3 §6, route through Twilio / Resend / ParentSquare).

import { useState } from 'react';
import { useLoaderData, useFetcher, Link } from 'react-router';
import {
  Bell,
  Check,
  X,
  MessageSquare,
  Mail,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from './+types/_app.coverage.alerts._index';
import { getSession, requireRole } from '../../server/auth.server';
import { listAlerts, listParentContacts, type ParentAlertStatus } from '../../server/parent-alerts.server';
import { Button, EmptyState, Tabs, TabsList, TabsTrigger, Banner } from '../components/ui';

export function meta() {
  return [{ title: 'Parent alerts — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (!session) {
    throw new Response(null, { status: 302, headers: { Location: '/login' } });
  }
  if (session.role !== 'school_admin') {
    throw new Response('Forbidden', { status: 403 });
  }
  const [drafts, sent, parents] = await Promise.all([
    listAlerts({ schoolId: session.schoolId, status: 'draft', limit: 100 }),
    listAlerts({ schoolId: session.schoolId, status: 'sent', limit: 100 }),
    listParentContacts({ schoolId: session.schoolId, limit: 200 }),
  ]);
  return { drafts, sent, parents };
}

export default function ParentAlertsPage() {
  const { drafts, sent, parents } = useLoaderData<typeof loader>();
  const [activeTab, setActiveTab] = useState<'drafts' | 'sent' | 'parents'>('drafts');
  const visible = activeTab === 'drafts' ? drafts : activeTab === 'sent' ? sent : [];

  return (
    <div className="max-w-3xl mx-auto space-y-xl pb-3xl">
      <div>
        <h1 className="text-title-1 text-primary font-bold flex items-center gap-sm">
          <Bell size={28} aria-hidden className="text-secondary" />
          Parent alerts
        </h1>
        <p className="text-callout text-secondary mt-xs">
          Targeted duty-coverage notifications to parents. Drafts are
          generated automatically when a teacher accepts a coverage
          request; send them to dispatch (v1: mock).
        </p>
      </div>

      {drafts.length > 0 && (
        <Banner
          variant="info"
          message={`${drafts.length} ${drafts.length === 1 ? 'draft alert is' : 'draft alerts are'} ready to send.`}
        />
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'drafts' | 'sent' | 'parents')}>
        <TabsList>
          <TabsTrigger value="drafts">{`Drafts (${drafts.length})`}</TabsTrigger>
          <TabsTrigger value="sent">{`Sent (${sent.length})`}</TabsTrigger>
          <TabsTrigger value="parents">{`Parents (${parents.length})`}</TabsTrigger>
        </TabsList>
      </Tabs>

      {activeTab !== 'parents' && (
        visible.length === 0 ? (
          <div className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden">
            <EmptyState
              icon={<Bell size={48} aria-hidden />}
              title={activeTab === 'drafts' ? 'No draft alerts' : 'No sent alerts yet'}
              description={
                activeTab === 'drafts'
                  ? 'Drafts are generated when a teacher accepts a coverage request. Nothing here yet.'
                  : 'Once you send a draft, it appears here for the audit log.'
              }
            />
          </div>
        ) : (
          <ul className="space-y-md" role="list">
            {visible.map((a) => (
              <li
                key={a.id}
                className="bg-surface rounded-xl border border-border shadow-elev-1 p-xl"
              >
                <AlertRow alert={a} />
              </li>
            ))}
          </ul>
        )
      )}

      {activeTab === 'parents' && (
        parents.length === 0 ? (
          <div className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden">
            <EmptyState
              icon={<UsersIcon />}
              title="No parent contacts yet"
              description="Add parent contacts (name, phone, email) and tag them with the routes their kids use ('Bus 7', 'Recess K-2', etc.). When a teacher accepts a coverage request, alerts are auto-generated for the matching parents."
            />
          </div>
        ) : (
          <div className="bg-surface rounded-xl border border-border shadow-elev-1 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-2 border-b border-divider">
                  <th className="text-left px-xl py-md text-subhead text-secondary font-semibold">Name</th>
                  <th className="text-left px-xl py-md text-subhead text-secondary font-semibold">Phone</th>
                  <th className="text-left px-xl py-md text-subhead text-secondary font-semibold">Email</th>
                  <th className="text-left px-xl py-md text-subhead text-secondary font-semibold">Route tags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {parents.map((p) => (
                  <tr key={p.id}>
                    <td className="px-xl py-md text-body text-primary font-semibold">{p.name}</td>
                    <td className="px-xl py-md text-callout text-secondary tabular">{p.phone ?? '—'}</td>
                    <td className="px-xl py-md text-callout text-secondary">{p.email ?? '—'}</td>
                    <td className="px-xl py-md">
                      <div className="flex flex-wrap gap-xs">
                        {p.routeTags.length === 0 ? (
                          <span className="text-footnote text-tertiary">none</span>
                        ) : (
                          p.routeTags.map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center px-sm py-xs rounded-full bg-accent-soft text-accent text-caption-2 font-semibold"
                            >
                              {t}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function AlertRow({
  alert,
}: {
  alert: {
    id: string;
    parentName: string;
    parentPhone: string | null;
    parentEmail: string | null;
    channel: ParentAlertStatus extends never ? never : 'sms' | 'email' | 'app';
    subject: string | null;
    bodyShort: string;
    bodyLong: string | null;
    status: ParentAlertStatus;
    sentAt: string | null;
    createdAt: string;
    dutyLocation: string;
    dutyStartTime: string;
    dutyEndTime: string;
    absenceDate: string;
    newTeacherName: string | null;
  };
}): React.ReactElement {
  const fetcher = useFetcher();
  const [showLong, setShowLong] = useState(false);
  const channelIcon: Record<typeof alert.channel, LucideIcon> = {
    sms: MessageSquare,
    email: Mail,
    app: Smartphone,
  };
  const ChannelIcon = channelIcon[alert.channel];

  return (
    <div className="space-y-md">
      <div className="flex items-start gap-md">
        <div
          aria-hidden
          className="w-10 h-10 rounded-full bg-accent-soft grid place-items-center text-accent shrink-0"
        >
          <ChannelIcon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-sm flex-wrap">
            <h3 className="text-body-em text-primary font-semibold">
              {alert.parentName}
            </h3>
            <span
              className={
                'inline-flex items-center px-sm py-xs rounded-full text-caption-2 font-semibold uppercase tracking-wide ' +
                (alert.status === 'sent'
                  ? 'bg-success-soft text-success'
                  : alert.status === 'draft'
                    ? 'bg-warning-soft text-warning'
                    : 'bg-surface-2 text-secondary')
              }
            >
              {alert.status}
            </span>
          </div>
          <p className="text-footnote text-secondary mt-xs">
            {alert.parentPhone && <>📱 {alert.parentPhone}</>}
            {alert.parentPhone && alert.parentEmail && <> · </>}
            {alert.parentEmail && <>✉️ {alert.parentEmail}</>}
          </p>
        </div>
      </div>

      <div>
        <div className="text-subhead text-secondary uppercase tracking-wider mb-xs">
          {alert.subject ?? 'Coverage update'}
        </div>
        <p className="text-body text-primary">{alert.bodyShort}</p>
        {alert.bodyLong && (
          <button
            type="button"
            onClick={() => setShowLong((s) => !s)}
            className="text-callout text-accent hover:underline mt-sm"
          >
            {showLong ? 'Hide full message' : 'Show full message'}
          </button>
        )}
        {showLong && alert.bodyLong && (
          <pre className="mt-sm p-md bg-surface-2 rounded-md text-callout text-primary whitespace-pre-wrap font-sans">
            {alert.bodyLong}
          </pre>
        )}
      </div>

      <div className="text-footnote text-secondary flex items-center gap-md flex-wrap pt-md border-t border-divider">
        <span>
          <strong className="text-primary">{alert.dutyLocation}</strong> · {formatTime12h(alert.dutyStartTime)}–{formatTime12h(alert.dutyEndTime)}
        </span>
        <span>·</span>
        <span>{new Date(alert.absenceDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        {alert.newTeacherName && (
          <>
            <span>·</span>
            <span>Now covered by <strong className="text-primary">{alert.newTeacherName}</strong></span>
          </>
        )}
      </div>

      {alert.status === 'draft' && (
        <div className="flex items-center gap-sm pt-md border-t border-divider">
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              fetcher.submit(
                { alertId: alert.id },
                { method: 'POST', action: '/api/coverage/parent-alerts/send' },
              );
            }}
            disabled={fetcher.state !== 'idle'}
          >
            <Check size={16} aria-hidden />
            {fetcher.state === 'submitting' ? 'Sending…' : 'Mark as sent'}
          </Button>
          <Button
            variant="tertiary"
            size="md"
            onClick={() => {
              fetcher.submit(
                { alertId: alert.id },
                { method: 'POST', action: '/api/coverage/parent-alerts/cancel' },
              );
            }}
            disabled={fetcher.state !== 'idle'}
          >
            <X size={16} aria-hidden />
            Cancel
          </Button>
          <span className="text-footnote text-tertiary ml-auto">
            v1: mock send. v2 routes via Twilio/Resend.
          </span>
        </div>
      )}

      {alert.status === 'sent' && alert.sentAt && (
        <div className="text-footnote text-success pt-md border-t border-divider">
          Sent {new Date(alert.sentAt).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </div>
      )}
    </div>
  );
}

function UsersIcon(): React.ReactElement {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
