/**
 * DutyReminder — react-email template for the duty reminder email.
 *
 * Renders the HTML body for a reminder email about a scheduled duty. The
 * subject and the final dispatch are assembled by the caller (so we can stay
 * transport-agnostic and re-use the same template with mock + resend).
 *
 * Subject: "Reminder: <duty.location> at <time>"
 * Body: school name, duty location, local time (school timezone), time-until
 *       ("in 15 minutes"), and the custom message if provided.
 */
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface DutyReminderProps {
  schoolName: string;
  /** Duty location, e.g. "Main Entrance" or "Playground" */
  dutyLocation: string;
  /** Local time string formatted in the school's timezone, e.g. "8:30 AM" */
  dutyTimeLocal: string;
  /** IANA timezone name of the school, e.g. "America/Toronto" */
  schoolTimezone: string;
  /** Human-readable countdown, e.g. "in 15 minutes", "tomorrow at 7:45 AM" */
  timeUntil: string;
  /** Custom message set by the teacher or admin (optional). */
  customMessage?: string | null;
  /** Greeting line — usually the teacher's first name. */
  recipientName?: string | null;
}

export function DutyReminder({
  schoolName,
  dutyLocation,
  dutyTimeLocal,
  schoolTimezone,
  timeUntil,
  customMessage,
  recipientName,
}: DutyReminderProps) {
  return (
    <Html>
      <Head />
      <Preview>
        {`Reminder: ${dutyLocation} at ${dutyTimeLocal} (${schoolName})`}
      </Preview>
      <Body
        style={{
          backgroundColor: '#f6f9fc',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          margin: 0,
          padding: '24px 0',
        }}
      >
        <Container
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e6ebf1',
            borderRadius: '8px',
            margin: '0 auto',
            maxWidth: '560px',
            padding: '32px',
          }}
        >
          <Heading
            as="h1"
            style={{
              color: '#1a1a1a',
              fontSize: '22px',
              fontWeight: 600,
              margin: '0 0 16px',
            }}
          >
            Reminder: {dutyLocation} at {dutyTimeLocal}
          </Heading>

          <Text style={{ color: '#374151', fontSize: '16px', margin: '0 0 12px' }}>
            {recipientName ? `Hi ${recipientName},` : 'Hi,'}
          </Text>

          <Text style={{ color: '#374151', fontSize: '16px', margin: '0 0 16px' }}>
            You have a supervision duty scheduled at <strong>{schoolName}</strong>.
          </Text>

          <Section
            style={{
              backgroundColor: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: '6px',
              padding: '16px',
              margin: '16px 0',
            }}
          >
            <Text style={{ margin: '0 0 6px', color: '#1f2937', fontSize: '15px' }}>
              <strong>Location:</strong> {dutyLocation}
            </Text>
            <Text style={{ margin: '0 0 6px', color: '#1f2937', fontSize: '15px' }}>
              <strong>Time:</strong> {dutyTimeLocal}
              <span style={{ color: '#6b7280', marginLeft: '6px' }}>
                ({schoolTimezone})
              </span>
            </Text>
            <Text style={{ margin: 0, color: '#1f2937', fontSize: '15px' }}>
              <strong>Starts:</strong> {timeUntil}
            </Text>
          </Section>

          {customMessage ? (
            <>
              <Hr style={{ borderColor: '#e6ebf1', margin: '20px 0' }} />
              <Text style={{ color: '#374151', fontSize: '15px', margin: '0 0 8px' }}>
                <strong>Note:</strong>
              </Text>
              <Text style={{ color: '#374151', fontSize: '15px', margin: 0 }}>
                {customMessage}
              </Text>
            </>
          ) : null}

          <Hr style={{ borderColor: '#e6ebf1', margin: '24px 0 16px' }} />
          <Text style={{ color: '#9ca3af', fontSize: '13px', margin: 0 }}>
            This reminder was sent by {schoolName} via EduSupervise.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default DutyReminder;