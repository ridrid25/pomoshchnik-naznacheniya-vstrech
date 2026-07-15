import type { MiniAppAuthContext } from './auth/mini-app-auth.types';
import type { MiniAppUserContract } from './mini-app.contracts';

export function toUserContract(
  auth: MiniAppAuthContext,
): MiniAppUserContract {
  return {
    id: auth.user.id,
    telegramId: auth.user.telegramId.toString(),
    username: auth.user.telegramUsername,
    displayName: auth.user.telegramDisplayName,
    role: auth.role,
    status: 'ACTIVE',
    lastConfirmedEmail: auth.user.lastConfirmedEmail,
    notificationChannel: auth.user.notificationChannel,
  };
}
