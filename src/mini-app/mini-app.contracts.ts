export type MiniAppRole = 'ADMIN' | 'USER';

export interface MiniAppUserContract {
  id: string;
  telegramId: string;
  username: string | null;
  displayName: string;
  role: MiniAppRole;
  status: 'ACTIVE';
  lastConfirmedEmail: string | null;
  notificationChannel: 'TELEGRAM' | 'EMAIL';
}

export interface MiniAppSessionContract {
  authenticated: true;
  user: MiniAppUserContract;
}

export interface MiniAppWeekContract {
  offset: number;
  startDate: string;
  endDate: string;
}

export interface MiniAppSlotContract {
  date: string;
  time: string;
  startAt: string;
  endAt: string;
  timezone: string;
}

export interface MiniAppBookingContract {
  id: string;
  publicCode: string;
  source: 'MINI_APP';
  meetingFormat: 'ONLINE' | 'IN_PERSON';
  durationMinutes: number;
  startAt: string;
  timezone: string;
  title: string;
  comment: string | null;
  email: string | null;
  status: 'PENDING_APPROVAL';
  expiresAt: string;
  createdAt: string;
}

export interface MiniAppUserBookingContract {
  id: string;
  publicCode: string;
  type: 'NEW' | 'RESCHEDULE' | 'CANCEL';
  source: 'TELEGRAM_BOT' | 'MINI_APP' | 'ADMIN';
  meetingFormat: 'ONLINE' | 'IN_PERSON';
  durationMinutes: number;
  startAt: string;
  endAt: string;
  timezone: string;
  title: string;
  comment: string | null;
  email: string | null;
  status:
    | 'PENDING_APPROVAL'
    | 'CONFIRMED'
    | 'REJECTED'
    | 'EXPIRED'
    | 'CANCELLED_BY_USER'
    | 'SLOT_UNAVAILABLE'
    | 'CONFIRMATION_ERROR';
  rejectionReason: string | null;
  originalBookingId: string | null;
  googleMeetUrl: string | null;
  calendarSyncStatus: 'PENDING' | 'SYNCED' | 'CANCELLED' | 'ERROR' | null;
  canCancel: boolean;
  canReschedule: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MiniAppAdminBookingContract
  extends Omit<MiniAppUserBookingContract, 'canCancel' | 'canReschedule'> {
  googleCalendarDayUrl: string | null;
  user: {
    id: string;
    telegramId: string;
    username: string | null;
    displayName: string;
    status: 'ACTIVE' | 'BANNED';
  };
  queueState: 'REQUIRES_DECISION' | 'TECHNICAL_ERROR' | 'PROCESSED';
  canConfirm: boolean;
  canReject: boolean;
  canBlock: boolean;
}

export interface MiniAppAdminQueueSummaryContract {
  pending: number;
  decidedToday: number;
}
