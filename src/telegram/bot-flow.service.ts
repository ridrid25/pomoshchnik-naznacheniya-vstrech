import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Bot,
  Context,
  InlineKeyboard,
  type BotError,
} from 'grammy';
import type { Update } from '@grammyjs/types';

import {
  AvailabilityService,
  type AvailableSlot,
  type AvailableWeek,
} from '../availability/availability.service';
import { BookingService } from '../bookings/booking.service';
import { BookingDecisionService } from '../bookings/booking-decision.service';
import { PrismaService } from '../database/prisma.service';
import {
  BookingStatus,
  BookingType,
  CalendarSyncStatus,
  MessageTemplateType,
  MeetingFormat,
  NotificationChannel,
  UserStatus,
  type User,
} from '../generated/prisma/client';
import { JsonLoggerService } from '../logging/json-logger.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { NotificationService } from '../notifications/notification.service';

const DURATIONS = [30, 45, 60] as const;
const TIMEZONE = 'Europe/Moscow';
const MOSCOW_OFFSET = '+03:00';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type BookingStep =
  | 'duration'
  | 'format'
  | 'week'
  | 'date'
  | 'time'
  | 'email'
  | 'title'
  | 'comment'
  | 'confirm';

interface BookingDraft {
  step: BookingStep;
  durationMinutes?: number;
  weekOffset?: number;
  date?: string;
  time?: string;
  email?: string;
  title?: string;
  comment?: string;
  type?: BookingType;
  originalBookingId?: string;
  meetingFormat?: MeetingFormat;
}

@Injectable()
export class BotFlowService implements OnModuleInit, OnModuleDestroy {
  private readonly bot: Bot | null;
  private readonly adminTelegramId: string | null;
  private readonly miniAppUrl: string | null;
  private readonly devPolling: boolean;
  private readonly drafts = new Map<string, BookingDraft>();
  private readonly pendingNotificationEmail = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly config: ConfigService,
    private readonly logger: JsonLoggerService,
    private readonly googleCalendar: GoogleCalendarService,
    private readonly bookings: BookingService,
    private readonly bookingDecisions: BookingDecisionService,
    private readonly notifications: NotificationService,
  ) {
    const token = config.get<string | null>('app.telegramBotToken');
    this.adminTelegramId = config.get<string | null>('app.adminTelegramId') ?? null;
    const publicBaseUrl = config.get<string | null>('app.publicBaseUrl') ?? null;
    this.miniAppUrl = publicBaseUrl ? `${publicBaseUrl}/mini-app` : null;
    this.devPolling = config.get<boolean>('app.telegramDevPolling') ?? false;
    const apiRoot = config.get<string | null>('app.telegramApiRoot');
    this.bot = token
      ? new Bot(token, {
          client: apiRoot ? { apiRoot } : undefined,
        })
      : null;

    if (this.bot) this.registerHandlers(this.bot);
  }

  async onModuleInit(): Promise<void> {
    if (!this.bot) {
      this.logger.logEvent('BotFlowService', 'telegram.bot.disabled');
      return;
    }

    await this.bot.init();
    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Открыть главное меню' },
      { command: 'menu', description: 'Показать кнопки меню' },
      { command: 'book', description: 'Записаться на встречу' },
      { command: 'bookings', description: 'Мои заявки' },
      { command: 'notifications', description: 'Канал уведомлений' },
      { command: 'admin', description: 'Управление встречами' },
    ]);
    await this.configureMiniAppMenu();

    if (!this.devPolling) {
      this.logger.logEvent('BotFlowService', 'telegram.webhook.ready');
      return;
    }

    await this.bot.api.deleteWebhook({ drop_pending_updates: false });
    void this.bot
      .start({
        allowed_updates: ['message', 'callback_query'],
        onStart: (botInfo) => {
          this.logger.logEvent('BotFlowService', 'telegram.polling.started', {
            bot_id: botInfo.id,
            bot_username: botInfo.username,
          });
        },
      })
      .catch((error: unknown) => {
        this.logger.errorEvent(
          'BotFlowService',
          'telegram.polling.failed',
          { error_message: errorMessage(error) },
          error instanceof Error ? error.stack : undefined,
        );
      });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bot?.isRunning()) await this.bot.stop();
  }

  async handleUpdate(update: unknown): Promise<void> {
    if (!this.bot) {
      this.logger.logEvent('BotFlowService', 'telegram.update.skipped', {
        reason: 'bot_token_not_configured',
      });
      return;
    }

    if (!isTelegramUpdate(update)) {
      this.logger.errorEvent('BotFlowService', 'telegram.update.invalid', {
        error_message: 'Update must contain numeric update_id',
      });
      return;
    }

    await this.bot.handleUpdate(update);
  }

  private registerHandlers(bot: Bot): void {
    bot.catch(async (botError: BotError<Context>) => {
      this.logger.errorEvent(
        'BotFlowService',
        'telegram.update.failed',
        {
          update_id: botError.ctx.update.update_id,
          error_message: errorMessage(botError.error),
        },
        botError.error instanceof Error ? botError.error.stack : undefined,
      );
      if (botError.error instanceof MissingBookingDraftError) {
        await botError.ctx.reply(
          'Этот сценарий уже завершен или устарел. Откройте главное меню и начните заново.',
          { reply_markup: new InlineKeyboard().text('Главное меню', 'menu:main') },
        );
      }
    });

    bot.use(async (ctx, next) => {
      if (ctx.chat && ctx.chat.type !== 'private') {
        await ctx.reply('Бот работает только в личных сообщениях.');
        return;
      }
      await next();
    });

    bot.command('start', async (ctx) => {
      const user = await this.ensureUser(ctx);
      this.drafts.delete(String(user.telegramId));
      this.pendingNotificationEmail.delete(String(user.telegramId));
      await this.showMainMenu(ctx, user);
    });

    bot.command('menu', async (ctx) => {
      const user = await this.ensureUser(ctx);
      await this.showMainMenu(ctx, user);
    });

    bot.command('book', async (ctx) => {
      const user = await this.ensureUser(ctx);
      this.drafts.set(String(user.telegramId), { step: 'duration' });
      this.logFlow('booking.flow.started', user, { source: 'command' });
      await this.renderDraftStep(ctx, user);
    });

    bot.command('bookings', async (ctx) => {
      const user = await this.ensureUser(ctx);
      await this.showUserBookings(ctx, user);
    });

    bot.command('notifications', async (ctx) => {
      const user = await this.ensureUser(ctx);
      await this.showNotificationMenu(ctx, user);
    });

    bot.command('admin', async (ctx) => {
      const user = await this.ensureAdmin(ctx);
      if (!user) return;
      await this.showAdminMenu(ctx);
    });

    bot.callbackQuery('menu:main', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      await this.showMainMenu(ctx, user);
    });

    bot.callbackQuery('booking:new', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      this.drafts.set(String(user.telegramId), { step: 'duration' });
      this.logFlow('booking.flow.started', user);
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery(/^booking:duration:(30|45|60)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const draft = this.requireDraft(user);
      draft.durationMinutes = Number(ctx.match[1]);
      draft.step = 'format';
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery(/^booking:format:(online|in_person)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const draft = this.requireDraft(user);
      draft.meetingFormat =
        ctx.match[1] === 'online'
          ? MeetingFormat.ONLINE
          : MeetingFormat.IN_PERSON;
      draft.step = 'week';
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery(/^booking:week:(\d+)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const draft = this.requireDraft(user);
      const weekOffset = Number(ctx.match[1]);
      if (
        !draft.durationMinutes ||
        !(await this.availability.getAvailableWeekOffsets(
          draft.durationMinutes,
        )).includes(weekOffset)
      ) {
        await ctx.reply('Эта неделя находится вне горизонта записи.');
        return;
      }
      draft.weekOffset = weekOffset;
      draft.step = 'date';
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery(/^booking:date:(\d{4}-\d{2}-\d{2})$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const draft = this.requireDraft(user);
      const selectedDate = ctx.match[1];
      if (
        !draft.durationMinutes ||
        !(await this.availability.getAvailableDates(
          draft.durationMinutes,
          draft.weekOffset ?? 0,
        )).includes(selectedDate)
      ) {
        await ctx.reply('Эта дата больше недоступна. Выберите дату из меню.');
        return;
      }
      draft.date = selectedDate;
      draft.step = 'time';
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery(/^booking:time:(\d{2}:\d{2})$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const draft = this.requireDraft(user);
      const selectedTime = ctx.match[1];
      if (
        !draft.date ||
        !draft.durationMinutes ||
        !(await this.availability.getAvailableSlots(
          draft.date,
          draft.durationMinutes,
        )).some((slot) => slot.time === selectedTime)
      ) {
        await ctx.reply('Это время недоступно. Выберите время из меню.');
        return;
      }
      draft.time = selectedTime;
      draft.step = 'email';
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery('booking:email:keep', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      if (!user.lastConfirmedEmail) {
        await ctx.reply('Сохраненный email отсутствует. Введите адрес сообщением.');
        return;
      }
      const draft = this.requireDraft(user);
      draft.email = user.lastConfirmedEmail;
      draft.step = 'title';
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery('booking:email:skip', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      if (user.notificationChannel !== NotificationChannel.TELEGRAM) {
        await ctx.reply(
          'Для уведомлений по email адрес обязателен. Сначала выберите Telegram в разделе «Уведомления» или укажите email.',
        );
        return;
      }
      const draft = this.requireDraft(user);
      draft.email = undefined;
      draft.step = 'title';
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery('booking:comment:skip', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const draft = this.requireDraft(user);
      draft.comment = undefined;
      draft.step = 'confirm';
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery('booking:back', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const draft = this.requireDraft(user);
      draft.step = previousStep(draft.step);
      this.logFlow('booking.flow.back', user, { step: draft.step });
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery('booking:cancel', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      this.drafts.delete(String(user.telegramId));
      this.logFlow('booking.flow.cancelled', user);
      await ctx.reply('Запись отменена. Заявка и резерв не создавались.', {
        reply_markup: mainMenuKeyboard(
          this.isAdmin(user.telegramId),
          this.miniAppUrl,
        ),
      });
    });

    bot.callbackQuery('booking:submit', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      await this.submitBooking(ctx, user);
    });

    bot.callbackQuery('bookings:list', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      await this.showUserBookings(ctx, user);
    });

    bot.callbackQuery(/^bookings:view:([a-z0-9]+)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const booking = await this.prisma.booking.findFirst({
        where: { id: ctx.match[1], userId: user.id },
      });
      if (!booking) {
        await ctx.reply('Заявка не найдена.');
        return;
      }
      const keyboard = new InlineKeyboard();
      if (
        booking.status === BookingStatus.PENDING_APPROVAL ||
        booking.status === BookingStatus.CONFIRMED
      ) {
        keyboard
          .text('🗑 Отменить встречу', `bookings:cancel:${booking.id}`)
          .row();
      }
      if (booking.status === BookingStatus.CONFIRMED) {
        keyboard
          .text('🔄 Перенести встречу', `bookings:reschedule:${booking.id}`)
          .row();
      }
      keyboard.text('← К моим заявкам', 'bookings:list');
      await ctx.reply(formatBooking(booking), { reply_markup: keyboard });
    });

    bot.callbackQuery(/^bookings:reschedule:([a-z0-9]+)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const original = await this.prisma.booking.findFirst({
        where: {
          id: ctx.match[1],
          userId: user.id,
          status: BookingStatus.CONFIRMED,
        },
      });
      if (!original) {
        await ctx.reply('Подтверждённая встреча для переноса не найдена.');
        return;
      }
      this.drafts.set(String(user.telegramId), {
        step: 'week',
        durationMinutes: original.durationMinutes,
        email: original.emailSnapshot ?? user.lastConfirmedEmail ?? undefined,
        title: original.title,
        comment: original.comment ?? undefined,
        type: BookingType.RESCHEDULE,
        originalBookingId: original.id,
        meetingFormat: original.meetingFormat,
      });
      this.logFlow('booking.reschedule.started', user, {
        original_booking_id: original.id,
      });
      await ctx.reply(
        '🔄 Перенос встречи\n\nСтарая встреча останется в календаре, пока новое время не будет подтверждено. Выберите новую неделю.',
      );
      await this.renderDraftStep(ctx, user);
    });

    bot.callbackQuery(/^bookings:cancel:([a-z0-9]+)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const booking = await this.prisma.booking.findFirst({
        where: { id: ctx.match[1], userId: user.id },
      });
      if (!booking) {
        await ctx.reply('Заявка не найдена.');
        return;
      }
      await ctx.reply(
        `Точно отменить встречу «${booking.title}»?`,
        {
          reply_markup: new InlineKeyboard()
            .text('✅ Да, отменить', `bookings:cancel-confirm:${booking.id}`)
            .text('← Нет', `bookings:view:${booking.id}`),
        },
      );
    });

    bot.callbackQuery(
      /^bookings:cancel-confirm:([a-z0-9]+)$/u,
      async (ctx) => {
        await ctx.answerCallbackQuery();
        const user = await this.ensureUser(ctx);
        await this.bookings.cancelByUser(ctx.match[1], user.id);
        this.logFlow('booking.cancelled_by_user', user, {
          booking_id: ctx.match[1],
        });
        await this.notifications.notifyUser({
          userId: user.id,
          bookingId: ctx.match[1],
          eventType: 'BOOKING_CANCELLED',
          templateType: MessageTemplateType.BOOKING_CANCELLED,
          subject: 'Встреча отменена',
          fallbackText:
            'Встреча отменена. Если событие уже было создано, оно отменено и в Google Calendar.',
        });
        await ctx.reply('Готово. Слот освобождён.', {
          reply_markup: mainMenuKeyboard(
            this.isAdmin(user.telegramId),
            this.miniAppUrl,
          ),
        });
        if (this.adminTelegramId) {
          await this.sendTelegramNotification(
            BigInt(this.adminTelegramId),
            `Пользователь отменил заявку ${ctx.match[1]}.`,
          );
        }
      },
    );

    bot.callbackQuery('notification:menu', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      await this.showNotificationMenu(ctx, user);
    });

    bot.callbackQuery('notification:telegram', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { notificationChannel: NotificationChannel.TELEGRAM },
      });
      this.pendingNotificationEmail.delete(String(user.telegramId));
      this.logFlow('notification.preference.changed', updated, {
        notification_channel: NotificationChannel.TELEGRAM,
      });
      await ctx.reply('Канал уведомлений изменен: Telegram.', {
        reply_markup: notificationKeyboard(updated),
      });
    });

    bot.callbackQuery('notification:email', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      if (user.lastConfirmedEmail && isEmail(user.lastConfirmedEmail)) {
        const updated = await this.prisma.user.update({
          where: { id: user.id },
          data: { notificationChannel: NotificationChannel.EMAIL },
        });
        this.logFlow('notification.preference.changed', updated, {
          notification_channel: NotificationChannel.EMAIL,
        });
        await ctx.reply(
          `Канал уведомлений изменен: email (${updated.lastConfirmedEmail}).`,
          { reply_markup: notificationKeyboard(updated) },
        );
        return;
      }
      this.pendingNotificationEmail.add(String(user.telegramId));
      await ctx.reply(
        '✉️ Укажите адрес электронной почты\n\nНапишите его в поле сообщения внизу и нажмите «Отправить».\nНапример: name@example.com',
        {
          reply_markup: new InlineKeyboard().text(
            'Отмена',
            'notification:cancel',
          ),
        },
      );
    });

    bot.callbackQuery('notification:cancel', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureUser(ctx);
      this.pendingNotificationEmail.delete(String(user.telegramId));
      await this.showNotificationMenu(ctx, user);
    });

    bot.callbackQuery('admin:menu', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.ensureAdmin(ctx);
      if (!user) return;
      await this.showAdminMenu(ctx);
    });

    bot.callbackQuery('admin:bookings', async (ctx) => {
      await ctx.answerCallbackQuery();
      const admin = await this.ensureAdmin(ctx);
      if (!admin) return;
      const bookings = await this.prisma.booking.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { user: true },
      });
      const keyboard = new InlineKeyboard();
      for (const booking of bookings) {
        keyboard
          .text(
            formatBookingButton(booking).slice(0, 60),
            `admin:booking:${booking.id}`,
          )
          .row();
      }
      keyboard.text('Назад', 'admin:menu');
      await ctx.reply(
        bookings.length ? 'Последние заявки:' : 'Заявок пока нет.',
        { reply_markup: keyboard },
      );
    });

    bot.callbackQuery(/^admin:booking:([a-z0-9]+)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const admin = await this.ensureAdmin(ctx);
      if (!admin) return;
      const booking = await this.prisma.booking.findUnique({
        where: { id: ctx.match[1] },
        include: { user: true, calendarEvent: true },
      });
      if (!booking) {
        await ctx.reply('Заявка не найдена.');
        return;
      }
      const { date, time } = localDateTime(booking.startAt, booking.timezone);
      const calendarAccountEmail = await this.googleCalendar.getAccountEmail();
      const calendarUrl = googleCalendarDayUrl(date, calendarAccountEmail);
      const slotAvailable =
        booking.status === BookingStatus.PENDING_APPROVAL
          ? await this.availability.isSlotAvailable(
              date,
              time,
              booking.durationMinutes,
              new Date(),
              booking.id,
            )
          : null;
      const keyboard = new InlineKeyboard();
      if (booking.status === BookingStatus.PENDING_APPROVAL) {
        keyboard
          .text('✅ Подтвердить', `admin:confirm:${booking.id}`)
          .text('❌ Отклонить', `admin:reject:${booking.id}`)
          .row();
      }
      keyboard
        .url('📅 Открыть этот день в Google Calendar', calendarUrl)
        .row()
        .text('🚫 Заблокировать', `admin:block:${booking.userId}`)
        .text('🔓 Разблокировать', `admin:unblock:${booking.userId}`)
        .row()
        .text('← К списку', 'admin:bookings');
      await ctx.reply(
        [
          formatAdminBooking(booking, slotAvailable),
          '',
          'Если кнопка не откроется, нажмите или скопируйте ссылку в браузер:',
          calendarUrl,
        ].join('\n'),
        {
          reply_markup: keyboard,
        },
      );
    });

    bot.callbackQuery(/^admin:(confirm|reject):([a-z0-9]+)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const admin = await this.ensureAdmin(ctx);
      if (!admin) return;
      const bookingId = ctx.match[2];
      const action = ctx.match[1] === 'confirm' ? 'confirm' : 'reject';
      const result = await this.bookingDecisions.decide(bookingId, action);
      this.logFlow('admin.booking.status.changed', admin, {
        booking_id: bookingId,
        booking_status: result.bookingStatus,
      });
      const replies = {
        CONFIRMED: '✅ Заявка подтверждена, встреча создана в Google Calendar.',
        REJECTED: 'Заявка отклонена, резерв времени снят.',
        BLOCKED: 'Заявка отклонена, пользователь заблокирован.',
        SLOT_UNAVAILABLE: 'Слот уже недоступен. Заявка закрыта, резерв снят.',
        CONFIRMATION_ERROR: 'Не удалось создать событие Google Calendar. Заявка помечена как ошибка подтверждения, резерв снят.',
        ALREADY_PROCESSED: 'Эта заявка уже обработана. Повторное действие не выполнено.',
      } as const;
      await ctx.reply(replies[result.outcome]);
    });

    bot.callbackQuery(/^admin:(block|unblock):([a-z0-9]+)$/u, async (ctx) => {
      await ctx.answerCallbackQuery();
      const admin = await this.ensureAdmin(ctx);
      if (!admin) return;
      const active = ctx.match[1] === 'block';
      const userId = ctx.match[2];
      await this.bookings.setUserBlocked(userId, active, admin.telegramId);
      this.logFlow(active ? 'admin.user.blocked' : 'admin.user.unblocked', admin, {
        target_user_id: userId,
      });
      await ctx.reply(active ? 'Пользователь заблокирован.' : 'Пользователь разблокирован.');
    });

    bot.callbackQuery('admin:settings', async (ctx) => {
      await ctx.answerCallbackQuery();
      const admin = await this.ensureAdmin(ctx);
      if (!admin) return;
      const googleStatus = await this.googleCalendar.getStatus();
      const keyboard = new InlineKeyboard();
      if (googleStatus.configured && !googleStatus.authorized) {
        keyboard
          .url('🔗 Подключить Google Calendar', this.googleCalendar.createAuthorizationUrl())
          .row();
      }
      keyboard.text('← Назад', 'admin:menu');
      await ctx.reply(
        [
          '🛠 Настройки интеграций',
          '',
          `Google OAuth: ${googleStatus.configured ? 'настроен' : 'нужны Client ID, Secret и Redirect URI'}`,
          `Google Calendar: ${googleStatus.authorized ? '✅ подключён' : '❌ не подключён'}`,
        ].join('\n'),
        { reply_markup: keyboard },
      );
    });

    bot.on('message:text', async (ctx) => {
      const user = await this.ensureUser(ctx);
      const key = String(user.telegramId);
      const text = ctx.message.text.trim();

      if (this.pendingNotificationEmail.has(key)) {
        if (!isEmail(text)) {
          await ctx.reply(
            '⚠️ Не получилось распознать адрес.\n\nПроверьте, чтобы он выглядел примерно так: name@example.com\nЗатем отправьте исправленный адрес ещё раз.',
          );
          return;
        }
        const updated = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            lastConfirmedEmail: text.toLowerCase(),
            notificationChannel: NotificationChannel.EMAIL,
          },
        });
        this.pendingNotificationEmail.delete(key);
        this.logFlow('notification.preference.changed', updated, {
          notification_channel: NotificationChannel.EMAIL,
        });
        await ctx.reply(`Email сохранен. Уведомления будут приходить на ${text}.`, {
          reply_markup: notificationKeyboard(updated),
        });
        return;
      }

      const draft = this.drafts.get(key);
      if (!draft) {
        await this.showMainMenu(ctx, user);
        return;
      }

      if (draft.step === 'email') {
        if (!isEmail(text)) {
          await ctx.reply(
            '⚠️ Не получилось распознать адрес.\n\nПроверьте, чтобы он выглядел примерно так: name@example.com\nЗатем отправьте исправленный адрес ещё раз.',
          );
          return;
        }
        draft.email = text.toLowerCase();
        draft.step = 'title';
        await this.prisma.user.update({
          where: { id: user.id },
          data: { lastConfirmedEmail: draft.email },
        });
      } else if (draft.step === 'title') {
        if (text.length < 2 || text.length > 120) {
          await ctx.reply('Название должно содержать от 2 до 120 символов.');
          return;
        }
        draft.title = text;
        draft.step = 'comment';
      } else if (draft.step === 'comment') {
        if (text.length > 1000) {
          await ctx.reply('Комментарий должен быть не длиннее 1000 символов.');
          return;
        }
        draft.comment = text;
        draft.step = 'confirm';
      } else {
        await this.renderDraftStep(ctx, user);
        return;
      }

      this.logFlow('booking.flow.step.changed', user, { step: draft.step });
      await this.renderDraftStep(ctx, user);
    });

    bot.on('callback_query:data', async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Кнопка устарела. Откройте меню заново.' });
    });
  }

  private async ensureUser(ctx: Context): Promise<User> {
    if (!ctx.from) throw new Error('Telegram update has no user');
    const telegramId = BigInt(ctx.from.id);
    return this.prisma.user.upsert({
      where: { telegramId },
      update: {
        telegramUsername: ctx.from.username ?? null,
        telegramDisplayName: displayName(ctx),
      },
      create: {
        telegramId,
        telegramUsername: ctx.from.username ?? null,
        telegramDisplayName: displayName(ctx),
      },
    });
  }

  private async ensureAdmin(ctx: Context): Promise<User | null> {
    const user = await this.ensureUser(ctx);
    if (this.isAdmin(user.telegramId)) return user;
    this.logFlow('admin.access.denied', user);
    await ctx.reply('У вас нет доступа к административному разделу.');
    return null;
  }

  private isAdmin(telegramId: bigint): boolean {
    return this.adminTelegramId !== null && String(telegramId) === this.adminTelegramId;
  }

  private async showMainMenu(ctx: Context, user: User): Promise<void> {
    await ctx.reply(
      '🏠 Главное меню\n\n👋 Добро пожаловать! Здесь можно записаться на встречу, посмотреть свои заявки и выбрать способ получения уведомлений.',
      {
      reply_markup: mainMenuKeyboard(
        this.isAdmin(user.telegramId),
        this.miniAppUrl,
      ),
      },
    );
  }

  private async configureMiniAppMenu(): Promise<void> {
    if (!this.bot || !this.miniAppUrl) {
      this.logger.logEvent('BotFlowService', 'telegram.mini_app.disabled');
      return;
    }
    try {
      await this.bot.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Записаться',
          web_app: { url: this.miniAppUrl },
        },
      });
      this.logger.logEvent(
        'BotFlowService',
        'telegram.mini_app.menu_configured',
        { mini_app_url: this.miniAppUrl },
      );
    } catch (error: unknown) {
      this.logger.errorEvent(
        'BotFlowService',
        'telegram.mini_app.menu_configuration_failed',
        { error_message: errorMessage(error) },
      );
    }
  }

  private async showAdminMenu(ctx: Context): Promise<void> {
    await ctx.reply('⚙️ Управление встречами', {
      reply_markup: new InlineKeyboard()
        .text('📋 Заявки', 'admin:bookings')
        .row()
        .text('🛠 Настройки', 'admin:settings')
        .row()
        .text('🏠 Главное меню', 'menu:main'),
    });
  }

  private async showNotificationMenu(ctx: Context, user: User): Promise<void> {
    const channel = user.notificationChannel === NotificationChannel.EMAIL
      ? `Email (${user.lastConfirmedEmail ?? 'адрес не задан'})`
      : 'Telegram';
    await ctx.reply(`🔔 Уведомления\n\nСейчас выбран канал: ${channel}.\nКуда присылать сообщения о заявках и встречах?`, {
      reply_markup: notificationKeyboard(user),
    });
  }

  private async showUserBookings(ctx: Context, user: User): Promise<void> {
    const bookings = await this.prisma.booking.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const keyboard = new InlineKeyboard();
    for (const booking of bookings) {
      keyboard
        .text(
          formatBookingButton(booking).slice(0, 60),
          `bookings:view:${booking.id}`,
        )
        .row();
    }
    keyboard.text('🏠 В главное меню', 'menu:main');
    await ctx.reply(
      bookings.length
        ? '📋 Мои заявки\n\nНажмите на встречу, чтобы открыть подробности.'
        : 'У вас пока нет заявок.',
      { reply_markup: keyboard },
    );
  }

  private requireDraft(user: User): BookingDraft {
    const draft = this.drafts.get(String(user.telegramId));
    if (!draft) throw new MissingBookingDraftError();
    return draft;
  }

  private async renderDraftStep(ctx: Context, user: User): Promise<void> {
    const draft = this.requireDraft(user);
    this.logFlow('booking.flow.step.opened', user, { step: draft.step });
    switch (draft.step) {
      case 'duration':
        await ctx.reply('⏱ Сколько времени потребуется на встречу?', {
          reply_markup: durationKeyboard(),
        });
        break;
      case 'format':
        await ctx.reply(
          '📍 Как будет проходить встреча?\n\n🌐 Онлайн — создадим Google Meet.\n🤝 Лично — без видеоссылки.',
          { reply_markup: meetingFormatKeyboard() },
        );
        break;
      case 'week':
        if (!draft.durationMinutes) throw new Error('Duration is missing');
        await ctx.reply('🗓 Выберите удобную неделю\n\nНа кнопках указаны реальные диапазоны дат со свободным временем.', {
          reply_markup: weekKeyboard(
            await this.availability.getAvailableWeeks(
              draft.durationMinutes,
            ),
          ),
        });
        break;
      case 'date':
        if (!draft.durationMinutes) throw new Error('Duration is missing');
        {
          const dates = await this.availability.getAvailableDates(
            draft.durationMinutes,
            draft.weekOffset ?? 0,
          );
          await ctx.reply(
            `📅 Выберите день\n\nСвободные даты: ${formatCompactDateRange(dates)}`,
            { reply_markup: dateKeyboard(dates) },
          );
        }
        break;
      case 'time':
        if (!draft.durationMinutes || !draft.date) {
          throw new Error('Duration or date is missing');
        }
        await ctx.reply(`🕐 Выберите время начала\n\n📅 ${formatLongDate(draft.date)}\n⏱ ${draft.durationMinutes} минут\n🌍 Время московское`, {
          reply_markup: timeKeyboard(
            await this.availability.getAvailableSlots(
              draft.date,
              draft.durationMinutes,
            ),
          ),
        });
        break;
      case 'email':
        if (user.notificationChannel === NotificationChannel.TELEGRAM) {
          await ctx.reply(
            user.lastConfirmedEmail
              ? `📨 Подтверждение придёт в Telegram. Email указывать необязательно.\n\nЕсли хотите получить ещё и приглашение в Google Calendar, используйте сохранённый адрес ${user.lastConfirmedEmail} или напишите другой. Иначе нажмите «Пропустить».`
              : '📨 Подтверждение придёт в Telegram. Email указывать необязательно.\n\nЕсли хотите получить ещё и приглашение в Google Calendar, напишите адрес одним сообщением. Иначе нажмите «Пропустить».',
            {
              reply_markup: emailKeyboard(
                Boolean(user.lastConfirmedEmail),
                true,
              ),
            },
          );
          break;
        }
        await ctx.reply(
          user.lastConfirmedEmail
            ? `✉️ Куда отправить приглашение в календарь?\n\nСохранённый адрес: ${user.lastConfirmedEmail}\n\nНажмите кнопку ниже или напишите другой адрес в поле сообщения.`
            : '✉️ Укажите адрес электронной почты\n\nНапишите его в поле сообщения внизу и нажмите «Отправить».\nНапример: name@example.com\n\nНа этот адрес придёт приглашение в Google Calendar.',
          {
            reply_markup: emailKeyboard(
              Boolean(user.lastConfirmedEmail),
              false,
            ),
          },
        );
        break;
      case 'title':
        await ctx.reply('📝 Как назвать встречу?\n\nНапример: «Консультация по проекту».', {
          reply_markup: navigationKeyboard(true),
        });
        break;
      case 'comment':
        await ctx.reply('💬 Хотите что-то добавить?\n\nНапишите комментарий или нажмите «Пропустить».', {
          reply_markup: new InlineKeyboard()
            .text('Без комментария', 'booking:comment:skip')
            .row()
            .text('← Назад', 'booking:back')
            .text('✕ Отмена', 'booking:cancel'),
        });
        break;
      case 'confirm':
        await ctx.reply(formatDraft(draft), {
          reply_markup: new InlineKeyboard()
            .text('✅ Отправить заявку', 'booking:submit')
            .row()
            .text('← Назад', 'booking:back')
            .text('✕ Отмена', 'booking:cancel'),
        });
        break;
    }
  }

  private async submitBooking(ctx: Context, user: User): Promise<void> {
    const draft = this.requireDraft(user);
    if (!isCompleteDraft(draft)) {
      throw new Error('Booking draft is incomplete');
    }
    if (user.status === UserStatus.BANNED) {
      await ctx.reply('Вы не можете создавать новые заявки.');
      return;
    }
    if (
      !(await this.availability.isSlotAvailable(
        draft.date,
        draft.time,
        draft.durationMinutes,
      ))
    ) {
      draft.step = 'time';
      this.logFlow('booking.slot.rejected', user, {
        date: draft.date,
        reason: 'slot_no_longer_available',
      });
      await ctx.reply(
        'Пока вы заполняли заявку, это время стало недоступно. Выберите другой слот.',
      );
      await this.renderDraftStep(ctx, user);
      return;
    }
    const startAt = new Date(`${draft.date}T${draft.time}:00${MOSCOW_OFFSET}`);
    const booking = await this.bookings.create({
      userId: user.id,
      durationMinutes: draft.durationMinutes,
      startAt,
      timezone: TIMEZONE,
      title: draft.title,
      comment: draft.comment,
      email: draft.email,
      type: draft.type,
      originalBookingId: draft.originalBookingId,
      meetingFormat: draft.meetingFormat,
    });
    this.drafts.delete(String(user.telegramId));
    this.logFlow('booking.created', user, { booking_id: booking.id });
    if (this.adminTelegramId) {
      await this.sendAdminBookingNotification(booking);
    }
    const isReschedule = booking.type === BookingType.RESCHEDULE;
    await this.notifications.notifyUser({
      userId: user.id,
      bookingId: booking.id,
      eventType: isReschedule ? 'RESCHEDULE_SUBMITTED' : 'BOOKING_SUBMITTED',
      templateType: isReschedule
        ? MessageTemplateType.RESCHEDULE_SUBMITTED
        : MessageTemplateType.BOOKING_SUBMITTED,
      subject: isReschedule
        ? 'Запрос на перенос отправлен'
        : 'Заявка на встречу отправлена',
      fallbackText: isReschedule
        ? 'Запрос на перенос отправлен на согласование. Текущая встреча пока остается без изменений.'
        : 'Ваша заявка отправлена на согласование. Решение ожидается в течение 48 часов. Дата: {date}. Время: {time} ({tz_label}). Длительность: {duration} мин.',
      variables: bookingTemplateVariables(booking),
    });
    await ctx.reply(
      isReschedule
        ? 'Запрос на перенос принят. Старая встреча пока остаётся без изменений.'
        : 'Заявка принята. Решение ожидается в течение 48 часов.',
      {
        reply_markup: mainMenuKeyboard(
          this.isAdmin(user.telegramId),
          this.miniAppUrl,
        ),
      },
    );
  }

  private async sendAdminBookingNotification(booking: {
    id: string;
    title: string;
    startAt: Date;
    durationMinutes: number;
    timezone: string;
    comment: string | null;
    emailSnapshot: string | null;
    type: BookingType;
    status: BookingStatus;
    meetingFormat: MeetingFormat;
    user: User;
    calendarEvent: { syncStatus: CalendarSyncStatus } | null;
  }): Promise<void> {
    if (!this.bot || !this.adminTelegramId) return;
    try {
      await this.bot.api.sendMessage(
        this.adminTelegramId,
        formatAdminBooking(booking, null),
        {
          reply_markup: new InlineKeyboard()
            .text('✅ Подтвердить', `admin:confirm:${booking.id}`)
            .text('❌ Отклонить', `admin:reject:${booking.id}`)
            .row()
            .text('📋 Открыть заявку', `admin:booking:${booking.id}`),
        },
      );
    } catch (error: unknown) {
      this.logger.errorEvent('BotFlowService', 'admin.notification.failed', {
        booking_id: booking.id,
        error_message: errorMessage(error),
      });
    }
  }

  private async sendTelegramNotification(
    telegramId: bigint,
    text: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendMessage(String(telegramId), text);
    } catch (error: unknown) {
      this.logger.errorEvent('BotFlowService', 'user.notification.failed', {
        telegram_user_id: String(telegramId),
        error_message: errorMessage(error),
      });
    }
  }

  private logFlow(
    event: string,
    user: User,
    fields: Record<string, unknown> = {},
  ): void {
    this.logger.logEvent('BotFlowService', event, {
      telegram_user_id: String(user.telegramId),
      user_id: user.id,
      ...fields,
    });
  }
}

function mainMenuKeyboard(
  isAdmin: boolean,
  miniAppUrl: string | null,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (miniAppUrl) {
    keyboard.webApp('✨ Открыть приложение', miniAppUrl).row();
  }
  keyboard
    .text('📅 Записаться в чате', 'booking:new')
    .row()
    .text('📋 Мои заявки', 'bookings:list')
    .text('🔔 Уведомления', 'notification:menu');
  if (isAdmin) keyboard.row().text('⚙️ Управление встречами', 'admin:menu');
  return keyboard;
}

function durationKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  DURATIONS.forEach((duration, index) => {
    keyboard.text(`${duration} мин`, `booking:duration:${duration}`);
    if (index === 2) keyboard.row();
  });
  return keyboard.row().text('✕ Отменить запись', 'booking:cancel');
}

function meetingFormatKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🌐 Онлайн · Google Meet', 'booking:format:online')
    .row()
    .text('🤝 Лично · без видеоссылки', 'booking:format:in_person')
    .row()
    .text('← Назад', 'booking:back')
    .text('✕ Отмена', 'booking:cancel');
}

function weekKeyboard(weeks: AvailableWeek[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  weeks.forEach((week, index) => {
    const prefix = week.offset === 0 ? '📍 Эта неделя' : index === 0 ? '⭐ Ближайшая' : '📆';
    keyboard
      .text(
        `${prefix} · ${formatWeekRange(week)}`,
        `booking:week:${week.offset}`,
      )
      .row();
  });
  if (weeks.length === 0) {
    keyboard.text('Свободных недель пока нет', 'booking:back').row();
  }
  return keyboard
    .text('← Назад', 'booking:back')
    .text('✕ Отмена', 'booking:cancel');
}

function dateKeyboard(dates: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  dates.forEach((date, index) => {
    keyboard.text(formatDateLabel(date), `booking:date:${date}`);
    if ((index + 1) % 2 === 0) keyboard.row();
  });
  return keyboard
    .row()
    .text('← К неделям', 'booking:back')
    .text('✕ Отмена', 'booking:cancel');
}

function timeKeyboard(slots: AvailableSlot[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  slots.forEach((slot, index) => {
    keyboard.text(slot.time, `booking:time:${slot.time}`);
    if ((index + 1) % 3 === 0) keyboard.row();
  });
  if (slots.length === 0) {
    keyboard.text('Нет свободного времени — выбрать другой день', 'booking:back').row();
  }
  return keyboard
    .row()
    .text('← К датам', 'booking:back')
    .text('✕ Отмена', 'booking:cancel');
}

function emailKeyboard(
  hasSavedEmail: boolean,
  canSkipEmail: boolean,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (hasSavedEmail) keyboard.text('✅ Использовать сохранённый адрес', 'booking:email:keep').row();
  if (canSkipEmail) keyboard.text('⏭ Пропустить — ответ в Telegram', 'booking:email:skip').row();
  return keyboard
    .text('← Ко времени', 'booking:back')
    .text('✕ Отмена', 'booking:cancel');
}

function navigationKeyboard(withBack: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (withBack) keyboard.text('← Назад', 'booking:back');
  return keyboard.text('✕ Отмена', 'booking:cancel');
}

function notificationKeyboard(user: User): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      user.notificationChannel === NotificationChannel.TELEGRAM
        ? '✅ Telegram'
        : '💬 Telegram',
      'notification:telegram',
    )
    .text(
      user.notificationChannel === NotificationChannel.EMAIL ? '✅ Email' : '✉️ Email',
      'notification:email',
    )
    .row()
    .text('🏠 Главное меню', 'menu:main');
}

function previousStep(step: BookingStep): BookingStep {
  const order: BookingStep[] = [
    'duration',
    'format',
    'week',
    'date',
    'time',
    'email',
    'title',
    'comment',
    'confirm',
  ];
  const index = order.indexOf(step);
  return order[Math.max(0, index - 1)];
}

function formatDateLabel(date: string): string {
  const value = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
    timeZone: 'UTC',
  })
    .format(new Date(`${date}T00:00:00.000Z`))
    .replaceAll('.', '');
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatLongDate(date: string): string {
  const value = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatWeekRange(week: AvailableWeek): string {
  const start = new Date(`${week.startDate}T00:00:00.000Z`);
  const end = new Date(`${week.endDate}T00:00:00.000Z`);
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const startMonth = shortMonth(start);
  const endMonth = shortMonth(end);
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${startDay}–${endDay} ${endMonth}`
    : `${startDay} ${startMonth} – ${endDay} ${endMonth}`;
}

function formatCompactDateRange(dates: string[]): string {
  if (dates.length === 0) return 'нет свободных дней';
  const first = new Date(`${dates[0]}T00:00:00.000Z`);
  const last = new Date(`${dates.at(-1)}T00:00:00.000Z`);
  return first.getUTCMonth() === last.getUTCMonth()
    ? `${first.getUTCDate()}–${last.getUTCDate()} ${shortMonth(last)}`
    : `${first.getUTCDate()} ${shortMonth(first)} – ${last.getUTCDate()} ${shortMonth(last)}`;
}

function shortMonth(value: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    month: 'short',
    timeZone: 'UTC',
  })
    .format(value)
    .replaceAll('.', '');
}

function formatDraft(draft: BookingDraft): string {
  return [
    '✅ Всё готово — проверьте заявку',
    '',
    `📅 ${draft.date ? formatLongDate(draft.date) : 'Дата не выбрана'}`,
    `🕐 ${draft.time} · ${TIMEZONE}`,
    `⏱ ${draft.durationMinutes} минут`,
    `📍 ${meetingFormatLabel(draft.meetingFormat)}`,
    `📝 ${draft.title}`,
    `✉️ ${draft.email ?? 'Не указан — ответ в Telegram'}`,
    `💬 ${draft.comment ?? 'Без комментария'}`,
  ].join('\n');
}

function formatBooking(booking: {
  title: string;
  startAt: Date;
  durationMinutes: number;
  status: BookingStatus;
  timezone: string;
  meetingFormat: MeetingFormat;
  type: BookingType;
}): string {
  const endAt = new Date(booking.startAt.getTime() + booking.durationMinutes * 60_000);
  return [
    booking.type === BookingType.RESCHEDULE
      ? `🔄 Перенос встречи «${booking.title}»`
      : `📌 Встреча «${booking.title}»`,
    '',
    `📅 ${humanDate(booking.startAt, booking.timezone)}`,
    `🕐 ${humanTime(booking.startAt, booking.timezone)}–${humanTime(endAt, booking.timezone)} · Москва`,
    `⏱ ${booking.durationMinutes} минут`,
    `📍 ${meetingFormatLabel(booking.meetingFormat)}`,
    `📋 ${statusLabel(booking.status)}`,
  ].join('\n');
}

function formatAdminBooking(
  booking: {
    title: string;
    startAt: Date;
    durationMinutes: number;
    timezone: string;
    meetingFormat: MeetingFormat;
    type: BookingType;
    status: BookingStatus;
    comment: string | null;
    emailSnapshot: string | null;
    user: User;
    calendarEvent?: { syncStatus: CalendarSyncStatus } | null;
  },
  slotAvailable: boolean | null,
): string {
  const endAt = new Date(booking.startAt.getTime() + booking.durationMinutes * 60_000);
  const slotLine =
    slotAvailable === null
      ? null
      : slotAvailable
        ? '🟢 Время свободно — можно подтверждать'
        : '🔴 Время уже занято — подтверждать нельзя';
  return [
    booking.type === BookingType.RESCHEDULE
      ? '🔄 Заявка на перенос'
      : '🆕 Заявка на встречу',
    '',
    `📝 ${booking.title}`,
    `📅 ${humanDate(booking.startAt, booking.timezone)}`,
    `🕐 ${humanTime(booking.startAt, booking.timezone)}–${humanTime(endAt, booking.timezone)} · Москва`,
    `⏱ ${booking.durationMinutes} минут`,
    `📍 ${meetingFormatLabel(booking.meetingFormat)}`,
    `📋 ${statusLabel(booking.status)}`,
    slotLine,
    booking.calendarEvent?.syncStatus === CalendarSyncStatus.PENDING
      ? '⬜ В календаре: бледная запись «⏳ На согласовании»'
      : null,
    '',
    `👤 ${booking.user.telegramDisplayName}`,
    booking.user.telegramUsername
      ? `🔗 @${booking.user.telegramUsername}`
      : '🔗 Username отсутствует',
    `✉️ ${booking.emailSnapshot ?? 'не указан'}`,
    `🔔 Ответ: ${booking.user.notificationChannel === NotificationChannel.EMAIL ? 'Email' : 'Telegram'}`,
    `💬 ${booking.comment ?? 'Без комментария'}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function formatBookingButton(booking: {
  title: string;
  startAt: Date;
  timezone: string;
  status: BookingStatus;
}): string {
  return `${statusIcon(booking.status)} ${shortDate(booking.startAt, booking.timezone)} ${humanTime(booking.startAt, booking.timezone)} · ${booking.title}`;
}

function bookingTemplateVariables(
  booking: {
    startAt: Date;
    durationMinutes: number;
    timezone: string;
    meetingFormat: MeetingFormat;
  },
): Record<string, string | number> {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: booking.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(booking.startAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return {
    date: `${part('day')}.${part('month')}.${part('year')}`,
    time: `${part('hour')}:${part('minute')}`,
    tz_label: booking.timezone,
    duration: booking.durationMinutes,
    meeting_format: meetingFormatLabel(booking.meetingFormat),
    meeting_note:
      booking.meetingFormat === MeetingFormat.ONLINE
        ? 'Ссылка Google Meet придёт в напоминании за час.'
        : 'Google Meet не создаётся.',
  };
}

function meetingFormatLabel(format?: MeetingFormat): string {
  return format === MeetingFormat.IN_PERSON
    ? '🤝 Лично · без видеоссылки'
    : '🌐 Онлайн · Google Meet';
}

function statusLabel(status: BookingStatus): string {
  const labels: Record<BookingStatus, string> = {
    [BookingStatus.PENDING_APPROVAL]: '⏳ Ожидает подтверждения',
    [BookingStatus.CONFIRMED]: '✅ Подтверждена',
    [BookingStatus.REJECTED]: '❌ Отклонена',
    [BookingStatus.EXPIRED]: '⌛ Закрыта автоматически',
    [BookingStatus.CANCELLED_BY_USER]: '🗑 Отменена',
    [BookingStatus.SLOT_UNAVAILABLE]: '⚠️ Время стало недоступно',
    [BookingStatus.CONFIRMATION_ERROR]: '⚠️ Ошибка подтверждения',
  };
  return labels[status];
}

function humanDate(value: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(value);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function shortDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
  }).format(value);
}

function humanTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

function localDateTime(value: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

function googleCalendarDayUrl(
  date: string,
  accountEmail: string | null,
): string {
  const [year, month, day] = date.split('-').map(Number);
  const url = new URL(
    `https://calendar.google.com/calendar/r/day/${year}/${month}/${day}`,
  );
  if (accountEmail) url.searchParams.set('authuser', accountEmail);
  return url.toString();
}

function statusIcon(status: BookingStatus): string {
  switch (status) {
    case BookingStatus.CONFIRMED:
      return '✅';
    case BookingStatus.PENDING_APPROVAL:
      return '⏳';
    case BookingStatus.CANCELLED_BY_USER:
      return '🗑';
    case BookingStatus.REJECTED:
      return '❌';
    default:
      return '•';
  }
}

function displayName(ctx: Context): string {
  if (!ctx.from) return 'Telegram user';
  return [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
}

function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value) && value.length <= 254;
}

function isCompleteDraft(draft: BookingDraft): draft is BookingDraft & {
  durationMinutes: number;
  date: string;
  time: string;
  title: string;
  meetingFormat: MeetingFormat;
} {
  return Boolean(
    draft.durationMinutes &&
      draft.date &&
      draft.time &&
      draft.title &&
      draft.meetingFormat,
  );
}

function isTelegramUpdate(update: unknown): update is Update {
  return (
    typeof update === 'object' &&
    update !== null &&
    'update_id' in update &&
    typeof (update as { update_id: unknown }).update_id === 'number'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MissingBookingDraftError extends Error {
  constructor() {
    super('Booking draft is missing');
    this.name = 'MissingBookingDraftError';
  }
}
