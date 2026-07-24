import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BookingService } from '../bookings/booking.service';
import { PrismaService } from '../database/prisma.service';
import {
  BookingStatus,
  CalendarSyncStatus,
  NotificationDeliveryStatus,
} from '../generated/prisma/client';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { JsonLoggerService } from '../logging/json-logger.service';
import { NotificationService } from '../notifications/notification.service';
import type {
  MiniAppDiagnosticCheckContract,
  MiniAppDiagnosticsContract,
  MiniAppDiagnosticState,
} from './mini-app.contracts';

const MONITOR_INTERVAL_MS = 5 * 60_000;
const FIRST_MONITOR_DELAY_MS = 20_000;
const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;
const APP_VERSION = 'M11';

interface RepairResult {
  attempted: boolean;
  notificationRetries: number;
  calendarMarkersRestored: number;
  telegramWebhookRestored: boolean;
}

@Injectable()
export class MiniAppDiagnosticsService implements OnModuleInit, OnModuleDestroy {
  private firstMonitorTimer?: NodeJS.Timeout;
  private monitorTimer?: NodeJS.Timeout;
  private lastAlertAt = 0;
  private previousState: MiniAppDiagnosticState | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingService,
    private readonly notifications: NotificationService,
    private readonly googleCalendar: GoogleCalendarService,
    private readonly config: ConfigService,
    private readonly logger: JsonLoggerService,
  ) {}

  onModuleInit(): void {
    if (!this.isProduction()) return;
    this.firstMonitorTimer = setTimeout(() => {
      void this.monitorAndRepair();
    }, FIRST_MONITOR_DELAY_MS);
    this.monitorTimer = setInterval(() => {
      void this.monitorAndRepair();
    }, MONITOR_INTERVAL_MS);
    this.firstMonitorTimer.unref();
    this.monitorTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.firstMonitorTimer) clearTimeout(this.firstMonitorTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
  }

  async inspect(): Promise<MiniAppDiagnosticsContract> {
    return this.buildReport(emptyRepairResult());
  }

  async repairNow(): Promise<MiniAppDiagnosticsContract> {
    const repairs = await this.runSafeRepairs();
    return this.buildReport(repairs);
  }

  private async monitorAndRepair(): Promise<void> {
    try {
      const report = await this.repairNow();
      await this.sendStateNotification(report);
      this.logger.logEvent(
        'MiniAppDiagnosticsService',
        'diagnostics.monitor.completed',
        {
          state: report.state,
          notification_retries: report.repairs.notificationRetries,
          calendar_markers_restored: report.repairs.calendarMarkersRestored,
          telegram_webhook_restored: report.repairs.telegramWebhookRestored,
        },
      );
    } catch (error: unknown) {
      this.logger.errorEvent(
        'MiniAppDiagnosticsService',
        'diagnostics.monitor.failed',
        { error_message: safeError(error) },
      );
    }
  }

  private async runSafeRepairs(): Promise<RepairResult> {
    const repairs: RepairResult = {
      attempted: true,
      notificationRetries: 0,
      calendarMarkersRestored: 0,
      telegramWebhookRestored: false,
    };
    const expectedWebhookUrl = this.expectedWebhookUrl();
    const webhookSecret =
      this.config.get<string | null>('app.telegramWebhookSecret') ?? null;

    const results = await Promise.allSettled([
      this.notifications.retryPending(),
      this.bookings.syncPendingCalendarMarkers(),
      this.isProduction() && expectedWebhookUrl && webhookSecret
        ? this.notifications.ensureTelegramWebhook(
            expectedWebhookUrl,
            webhookSecret,
          )
        : Promise.resolve(false),
    ]);
    if (results[0].status === 'fulfilled') {
      repairs.notificationRetries = results[0].value;
    }
    if (results[1].status === 'fulfilled') {
      repairs.calendarMarkersRestored = results[1].value;
    }
    if (results[2].status === 'fulfilled') {
      repairs.telegramWebhookRestored = results[2].value;
    }
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      this.logger.errorEvent(
        'MiniAppDiagnosticsService',
        'diagnostics.repair.failed',
        { repair_index: index, error_message: safeError(result.reason) },
      );
    });
    return repairs;
  }

  private async buildReport(
    repairs: RepairResult,
  ): Promise<MiniAppDiagnosticsContract> {
    const checkedAt = new Date();
    const checks: MiniAppDiagnosticCheckContract[] = [];
    let databaseAvailable = true;

    try {
      await this.prisma.scheduleSettings.count();
      checks.push(check('database', 'Приложение и данные', 'OK', 'Работают'));
    } catch {
      databaseAvailable = false;
      checks.push(
        check(
          'database',
          'Приложение и данные',
          'ERROR',
          'Нет доступа к данным',
        ),
      );
    }

    const expectedWebhookUrl = this.expectedWebhookUrl();
    const telegramStatus = await this.notifications.getTelegramWebhookStatus(
      expectedWebhookUrl,
      this.isProduction(),
    );
    if (!telegramStatus.configured) {
      checks.push(
        check('telegram', 'Telegram-бот', 'ERROR', 'Не настроен на сервере'),
      );
    } else if (!telegramStatus.checked) {
      checks.push(
        check(
          'telegram',
          'Telegram-бот',
          'OK',
          'Настроен; внешняя проверка доступна после публикации',
        ),
      );
    } else if (!telegramStatus.reachable) {
      checks.push(
        check('telegram', 'Telegram-бот', 'ERROR', 'Telegram не ответил'),
      );
    } else if (!telegramStatus.matchesExpectedWebhook) {
      checks.push(
        check(
          'telegram',
          'Telegram-бот',
          'ATTENTION',
          'Адрес приёма сообщений нужно восстановить',
        ),
      );
    } else {
      checks.push(check('telegram', 'Telegram-бот', 'OK', 'Работает'));
    }

    const googleStatus = await this.googleCalendar.getStatus();
    if (!googleStatus.configured || !googleStatus.authorized) {
      checks.push(
        check(
          'google',
          'Google Calendar',
          'ERROR',
          'Нужно заново подключить календарь',
        ),
      );
    } else {
      const reachable = this.isProduction()
        ? await this.googleCalendar.probeConnection().catch(() => false)
        : true;
      checks.push(
        check(
          'google',
          'Google Calendar',
          reachable ? 'OK' : 'ERROR',
          reachable ? 'Подключён и отвечает' : 'Подключён, но не отвечает',
        ),
      );
    }

    if (databaseAvailable) {
      const dayAgo = new Date(checkedAt.getTime() - 24 * 60 * 60_000);
      const waitingSince = new Date(checkedAt.getTime() - 15 * 60_000);
      const [
        pendingNotifications,
        failedNotifications,
        calendarErrors,
        pendingCalendarSync,
        waitingBookings,
      ] = await Promise.all([
        this.prisma.notificationDelivery.count({
          where: { status: NotificationDeliveryStatus.PENDING },
        }),
        this.prisma.notificationDelivery.count({
          where: {
            status: NotificationDeliveryStatus.FAILED,
            updatedAt: { gte: dayAgo },
          },
        }),
        this.prisma.calendarEvent.count({
          where: { syncStatus: CalendarSyncStatus.ERROR },
        }),
        this.prisma.calendarEvent.count({
          where: { syncStatus: CalendarSyncStatus.PENDING },
        }),
        this.prisma.booking.count({
          where: {
            status: {
              in: [
                BookingStatus.PENDING_APPROVAL,
                BookingStatus.CONFIRMATION_ERROR,
              ],
            },
            createdAt: { lte: waitingSince },
            expiresAt: { gt: checkedAt },
          },
        }),
      ]);

      const notificationState =
        failedNotifications > 0 ? 'ATTENTION' : 'OK';
      checks.push(
        check(
          'notifications',
          'Уведомления',
          notificationState,
          failedNotifications > 0
            ? `Не доставлено за сутки: ${failedNotifications}`
            : pendingNotifications > 0
              ? `Ожидают повторной отправки: ${pendingNotifications}`
              : 'Отправляются',
        ),
      );
      checks.push(
        check(
          'calendar',
          'Записи в календаре',
          calendarErrors > 0 ? 'ATTENTION' : 'OK',
          calendarErrors > 0
            ? `Нужно повторить синхронизацию: ${calendarErrors}`
            : pendingCalendarSync > 0
              ? `На согласовании: ${pendingCalendarSync}`
              : 'Синхронизированы',
        ),
      );
      checks.push(
        check(
          'queue',
          'Заявки на согласовании',
          waitingBookings > 0 ? 'ATTENTION' : 'OK',
          waitingBookings > 0
            ? `Ждут решения больше 15 минут: ${waitingBookings}`
            : 'Долгого ожидания нет',
        ),
      );
    } else {
      checks.push(
        check(
          'notifications',
          'Уведомления',
          'ERROR',
          'Проверка недоступна без данных',
        ),
        check(
          'calendar',
          'Записи в календаре',
          'ERROR',
          'Проверка недоступна без данных',
        ),
        check(
          'queue',
          'Заявки на согласовании',
          'ERROR',
          'Проверка недоступна без данных',
        ),
      );
    }

    const state = aggregateState(checks);
    const report: MiniAppDiagnosticsContract = {
      state,
      title:
        state === 'OK'
          ? 'Всё работает'
          : state === 'ATTENTION'
            ? 'Нужно внимание'
            : 'Есть неисправность',
      checkedAt: checkedAt.toISOString(),
      version: APP_VERSION,
      checks,
      repairs,
      diagnosticText: '',
    };
    report.diagnosticText = diagnosticText(report);
    return report;
  }

  private async sendStateNotification(
    report: MiniAppDiagnosticsContract,
  ): Promise<void> {
    const previous = this.previousState;
    this.previousState = report.state;
    if (report.state === 'OK') {
      if (previous && previous !== 'OK') {
        await this.notifications.notifyAdmin(
          '✅ Помощник записей снова работает нормально. Автоматическая проверка завершена.',
        );
      }
      return;
    }
    const now = Date.now();
    if (previous === report.state && now - this.lastAlertAt < ALERT_COOLDOWN_MS) {
      return;
    }
    this.lastAlertAt = now;
    const failed = report.checks
      .filter((item) => item.state !== 'OK')
      .map((item) => `• ${item.label}: ${item.message}`)
      .join('\n');
    await this.notifications.notifyAdmin(
      `⚠️ Помощнику записей нужно внимание.\n${failed}\n\nОткройте Mini App → Управление → Состояние помощника.`,
    );
  }

  private expectedWebhookUrl(): string | null {
    const publicBaseUrl =
      this.config.get<string | null>('app.publicBaseUrl') ?? null;
    return publicBaseUrl ? `${publicBaseUrl}/telegram/webhook` : null;
  }

  private isProduction(): boolean {
    return this.config.get<string>('app.nodeEnv') === 'production';
  }
}

function emptyRepairResult(): RepairResult {
  return {
    attempted: false,
    notificationRetries: 0,
    calendarMarkersRestored: 0,
    telegramWebhookRestored: false,
  };
}

function check(
  id: MiniAppDiagnosticCheckContract['id'],
  label: string,
  state: MiniAppDiagnosticState,
  message: string,
): MiniAppDiagnosticCheckContract {
  return { id, label, state, message };
}

function aggregateState(
  checks: MiniAppDiagnosticCheckContract[],
): MiniAppDiagnosticState {
  if (checks.some((item) => item.state === 'ERROR')) return 'ERROR';
  if (checks.some((item) => item.state === 'ATTENTION')) return 'ATTENTION';
  return 'OK';
}

function diagnosticText(report: MiniAppDiagnosticsContract): string {
  const repairs = report.repairs.attempted
    ? [
        `повторено уведомлений: ${report.repairs.notificationRetries}`,
        `восстановлено отметок календаря: ${report.repairs.calendarMarkersRestored}`,
        `адрес Telegram восстановлен: ${report.repairs.telegramWebhookRestored ? 'да' : 'не требовалось'}`,
      ].join('; ')
    : 'автовосстановление при этой проверке не запускалось';
  return [
    'Диагностика помощника записей',
    `Проверено: ${report.checkedAt}`,
    `Версия: ${report.version}`,
    `Общее состояние: ${report.title}`,
    '',
    ...report.checks.map(
      (item) =>
        `${item.state === 'OK' ? 'OK' : item.state === 'ATTENTION' ? 'ВНИМАНИЕ' : 'ОШИБКА'} — ${item.label}: ${item.message}`,
    ),
    '',
    `Что уже сделано: ${repairs}.`,
    'Прошу проверить причину и предложить безопасное исправление без удаления заявок.',
  ].join('\n');
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 500);
}
