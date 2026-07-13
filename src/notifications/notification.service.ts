import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import nodemailer, { type Transporter } from 'nodemailer';

import { PrismaService } from '../database/prisma.service';
import {
  MessageTemplateType,
  NotificationChannel,
  NotificationDeliveryStatus,
} from '../generated/prisma/client';
import { JsonLoggerService } from '../logging/json-logger.service';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;

export interface UserNotificationInput {
  userId: string;
  bookingId?: string;
  eventType: string;
  templateType?: MessageTemplateType;
  subject: string;
  fallbackText: string;
  variables?: Record<string, string | number | null | undefined>;
}

@Injectable()
export class NotificationService {
  private readonly telegramBot: Bot | null;
  private readonly adminTelegramId: string | null;
  private readonly smtpTransport: Transporter | null;
  private readonly smtpFrom: string | null;
  private readonly smtpPassword: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: JsonLoggerService,
  ) {
    const telegramToken = config.get<string | null>('app.telegramBotToken');
    const telegramApiRoot = config.get<string | null>('app.telegramApiRoot');
    this.telegramBot = telegramToken
      ? new Bot(telegramToken, {
          client: telegramApiRoot ? { apiRoot: telegramApiRoot } : undefined,
        })
      : null;
    this.adminTelegramId = config.get<string | null>('app.adminTelegramId') ?? null;

    const smtpHost = config.get<string | null>('notification.smtpHost');
    const smtpUser = config.get<string | null>('notification.smtpUser');
    this.smtpPassword = config.get<string | null>('notification.smtpPassword') ?? null;
    this.smtpFrom = config.get<string | null>('notification.smtpFrom') ?? null;
    this.smtpTransport =
      smtpHost && smtpUser && this.smtpPassword && this.smtpFrom
        ? nodemailer.createTransport({
            host: smtpHost,
            port: config.get<number>('notification.smtpPort') ?? 587,
            secure: config.get<boolean>('notification.smtpSecure') ?? false,
            auth: { user: smtpUser, pass: this.smtpPassword },
            tls: { rejectUnauthorized: true },
            disableFileAccess: true,
            disableUrlAccess: true,
          })
        : null;
  }

  isEmailConfigured(): boolean {
    return Boolean(this.smtpTransport && this.smtpFrom);
  }

  async notifyUser(input: UserNotificationInput): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new Error('Notification user not found');
    const template = input.templateType
      ? await this.prisma.messageTemplate.findUnique({
          where: { type: input.templateType },
        })
      : null;
    const text = renderTemplate(
      template?.text ?? input.fallbackText,
      input.variables ?? {},
    );
    const recipient =
      user.notificationChannel === NotificationChannel.EMAIL
        ? user.lastConfirmedEmail
        : String(user.telegramId);
    if (!recipient) {
      await this.notifyAdminTechnicalFailure(
        `Невозможно отправить ${input.eventType}: для выбранного канала отсутствует адрес получателя. Пользователь ${user.id}.`,
      );
      this.logger.errorEvent('NotificationService', 'notification.recipient.missing', {
        user_id: user.id,
        booking_id: input.bookingId,
        event_type: input.eventType,
        channel: user.notificationChannel,
      });
      return;
    }
    const delivery = await this.prisma.notificationDelivery.create({
      data: {
        userId: user.id,
        bookingId: input.bookingId,
        channel: user.notificationChannel,
        eventType: input.eventType,
        recipient,
        subject: input.subject,
        text,
      },
    });
    await this.attemptDelivery(delivery.id);
  }

  async retryPending(now = new Date()): Promise<number> {
    const pending = await this.prisma.notificationDelivery.findMany({
      where: {
        status: NotificationDeliveryStatus.PENDING,
        attempts: { lt: MAX_ATTEMPTS },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: 50,
      select: { id: true },
    });
    for (const { id } of pending) await this.attemptDelivery(id);
    return pending.length;
  }

  private async attemptDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
    });
    if (!delivery || delivery.status !== NotificationDeliveryStatus.PENDING) return;
    try {
      if (delivery.channel === NotificationChannel.TELEGRAM) {
        if (!this.telegramBot) throw new Error('Telegram transport is not configured');
        await this.telegramBot.api.sendMessage(delivery.recipient, delivery.text);
      } else {
        if (!this.smtpTransport || !this.smtpFrom) {
          throw new Error('SMTP transport is not configured');
        }
        await this.smtpTransport.sendMail({
          from: this.smtpFrom,
          to: delivery.recipient,
          subject: delivery.subject,
          text: delivery.text,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
      }
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.SENT,
          attempts: { increment: 1 },
          sentAt: new Date(),
          lastError: null,
        },
      });
      this.logger.logEvent('NotificationService', 'notification.sent', {
        delivery_id: delivery.id,
        user_id: delivery.userId,
        booking_id: delivery.bookingId,
        event_type: delivery.eventType,
        channel: delivery.channel,
      });
    } catch (error: unknown) {
      const attempts = delivery.attempts + 1;
      const isFinal = attempts >= MAX_ATTEMPTS;
      const safeError = this.safeError(error);
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts,
          status: isFinal
            ? NotificationDeliveryStatus.FAILED
            : NotificationDeliveryStatus.PENDING,
          nextAttemptAt: new Date(
            Date.now() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)],
          ),
          lastError: safeError,
        },
      });
      this.logger.errorEvent('NotificationService', 'notification.delivery.failed', {
        delivery_id: delivery.id,
        user_id: delivery.userId,
        booking_id: delivery.bookingId,
        event_type: delivery.eventType,
        channel: delivery.channel,
        attempts,
        final: isFinal,
        error_message: safeError,
      });
      if (isFinal) {
        await this.notifyAdminTechnicalFailure(
          `Не удалось доставить уведомление ${delivery.eventType} после ${MAX_ATTEMPTS} попыток. Заявка: ${delivery.bookingId ?? 'не указана'}, пользователь: ${delivery.userId}.`,
        );
      }
    }
  }

  private async notifyAdminTechnicalFailure(text: string): Promise<void> {
    if (!this.telegramBot || !this.adminTelegramId) return;
    try {
      await this.telegramBot.api.sendMessage(
        this.adminTelegramId,
        `⚠️ Техническое уведомление\n${text}`,
      );
    } catch (error: unknown) {
      this.logger.errorEvent('NotificationService', 'admin.notification.failed', {
        error_message: this.safeError(error),
      });
    }
  }

  private safeError(error: unknown): string {
    let value = error instanceof Error ? error.message : String(error);
    if (this.smtpPassword) value = value.replaceAll(this.smtpPassword, '[REDACTED]');
    return value.replace(/[\r\n]+/gu, ' ').slice(0, 500);
  }
}

function renderTemplate(
  template: string,
  variables: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{([a-z0-9_]+)\}/giu, (placeholder, key: string) => {
    const value = variables[key];
    return value === null || value === undefined ? '' : String(value);
  });
}
