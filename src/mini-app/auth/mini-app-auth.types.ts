import type { Request } from 'express';

import type { User } from '../../generated/prisma/client';

export type MiniAppRole = 'ADMIN' | 'USER';

export interface MiniAppAuthContext {
  user: User;
  role: MiniAppRole;
}

export type MiniAppRequest = Request & {
  miniAppAuth?: MiniAppAuthContext;
};

export interface TelegramMiniAppUser {
  id: bigint;
  username: string | null;
  displayName: string;
}
