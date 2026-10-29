/**
 * Daily revision reminders.
 *
 * Two local mechanisms, no server:
 *  1. In-app notification: while the app is open (tab or installed PWA), a check runs every
 *     minute and shows a system notification once per day after the chosen time, if today's
 *     revision is not completed and notification permission was granted.
 *  2. Calendar file (.ics): a recurring daily event with an alarm that the user imports into
 *     their own calendar app. This works even when the app is closed.
 * Browsers do not offer reliable scheduled notifications for closed web apps, and this app has
 * no push server, so (1) alone cannot remind you when the app is closed.
 */
export function buildIcs(time: string, title: string, now: Date, appUrl: string): string {
  const [hh, mm] = time.split(':');
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/[\\,;]/g, (c) => `\\${c}`);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hafeez Helfer//Daily revision//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:hafeez-helfer-daily-revision-${y}${mo}${d}@local`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${y}${mo}${d}T${hh}${mm}00`,
    'DURATION:PT30M',
    'RRULE:FREQ=DAILY',
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(`Open Hafeez Helfer: ${appUrl}`)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(title)}`,
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.requestPermission();
}

export interface ReminderCheck {
  readonly enabled: boolean;
  readonly time: string;
  readonly todayCompleted: boolean;
  readonly lastNotifiedDate: string | null;
  readonly today: string;
  readonly now: Date;
}

/** Pure decision used by the in-app timer (tested). */
export function shouldNotify(c: ReminderCheck): boolean {
  if (!c.enabled || c.todayCompleted || c.lastNotifiedDate === c.today) return false;
  const [hh, mm] = c.time.split(':').map(Number);
  const minutes = c.now.getHours() * 60 + c.now.getMinutes();
  return minutes >= (hh ?? 0) * 60 + (mm ?? 0);
}
