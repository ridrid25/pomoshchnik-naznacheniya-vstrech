import { registerAs } from '@nestjs/config';

export default registerAs('google', () => ({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || null,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || null,
  redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || null,
  calendarId: process.env.GOOGLE_CALENDAR_ID?.trim() || 'primary',
}));
