const MINI_APP_BOT_USERNAME = 'Zapiscalender_bot';

export function createCalendarReturnUrl(bookingId: string): string {
  const startParam = /^[a-z0-9]+$/u.test(bookingId)
    ? `calendar_${bookingId}`
    : 'calendar';
  return `https://t.me/${MINI_APP_BOT_USERNAME}?startapp=${encodeURIComponent(startParam)}`;
}
