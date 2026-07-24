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
  googleCalendarDayUrl: string | null;
  calendarSyncStatus: 'PENDING' | 'SYNCED' | 'CANCELLED' | 'ERROR' | null;
  canCancel: boolean;
  canReschedule: boolean;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MiniAppAdminBookingContract
  extends Omit<MiniAppUserBookingContract, 'canCancel' | 'canReschedule' | 'canRetry'> {
  user: {
    id: string;
    telegramId: string;
    username: string | null;
    displayName: string;
    status: 'ACTIVE' | 'BANNED';
  };
  queueState: 'REQUIRES_DECISION' | 'TECHNICAL_ERROR' | 'PROCESSED';
  waitingMinutes: number | null;
  isAging: boolean;
  slotAvailable: boolean | null;
  canConfirm: boolean;
  canReject: boolean;
  canBlock: boolean;
}

export interface MiniAppAdminQueueSummaryContract {
  pending: number;
  decidedToday: number;
  aging: number;
  oldestWaitingMinutes: number | null;
  reliability: {
    observationStartedAt: string;
    sampleSize: number;
    minimumSampleSize: number;
    slotUnavailable: number;
    ratePercent: number | null;
    baselineSampleSize: number;
    baselineSlotUnavailable: number;
    baselineRatePercent: number;
    comparison: 'COLLECTING' | 'IMPROVED' | 'UNCHANGED' | 'WORSE';
  };
}

export interface MiniAppAdminSettingsContract {
  google: {
    configured: boolean;
    authorized: boolean;
    reachable: boolean;
    accountEmail: string | null;
    tokenExpiresAt: string | null;
  };
  schedule: {
    timezone: string;
    minimumLeadTimeMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    maxMeetingsPerDay: number;
    bookingHorizonDays: number;
    workingPeriods: Array<{
      weekday: number;
      startMinute: number;
      endMinute: number;
    }>;
  };
  overview: {
    activeRestrictions: number;
    blockedUsers: number;
    templates: number;
  };
}

export interface MiniAppAdminRestrictionContract {
  id: string;
  date: string;
  type: 'FULL_DAY' | 'TIME_INTERVAL';
  startMinute: number | null;
  endMinute: number | null;
  comment: string | null;
  calendarSyncStatus: 'PENDING' | 'SYNCED' | 'ERROR';
  createdAt: string;
}

export interface MiniAppAdminBlockedUserContract {
  id: string;
  userId: string;
  displayName: string;
  username: string | null;
  reason: string | null;
  blockedAt: string;
}

export interface MiniAppAdminTemplateContract {
  type:
    | 'BOOKING_SUBMITTED'
    | 'BOOKING_CONFIRMED'
    | 'BOOKING_REJECTED'
    | 'BOOKING_EXPIRED'
    | 'BOOKING_CANCELLED'
    | 'RESCHEDULE_SUBMITTED'
    | 'SLOT_UNAVAILABLE'
    | 'CONFIRMATION_ERROR';
  label: string;
  text: string;
  allowedPlaceholders: Array<{
    name: string;
    label: string;
  }>;
  updatedAt: string;
}

export type MiniAppDiagnosticState = 'OK' | 'ATTENTION' | 'ERROR';

export interface MiniAppDiagnosticCheckContract {
  id: 'database' | 'telegram' | 'google' | 'notifications' | 'calendar' | 'queue';
  label: string;
  state: MiniAppDiagnosticState;
  message: string;
}

export interface MiniAppDiagnosticsContract {
  state: MiniAppDiagnosticState;
  title: string;
  checkedAt: string;
  version: string;
  checks: MiniAppDiagnosticCheckContract[];
  repairs: {
    attempted: boolean;
    notificationRetries: number;
    calendarMarkersRestored: number;
    telegramWebhookRestored: boolean;
  };
  diagnosticText: string;
}
