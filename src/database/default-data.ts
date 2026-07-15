import {
  MessageTemplateType,
  type PrismaClient,
} from '../generated/prisma/client';

const DEFAULT_TEMPLATES: Array<{
  type: MessageTemplateType;
  text: string;
}> = [
  {
    type: MessageTemplateType.BOOKING_SUBMITTED,
    text: 'Ваша заявка отправлена на согласование. Решение ожидается в течение 48 часов. Дата: {date}. Время: {time} ({tz_label}). Длительность: {duration} мин.',
  },
  {
    type: MessageTemplateType.BOOKING_CONFIRMED,
    text: 'Встреча подтверждена. Дата: {date}. Время: {time} ({tz_label}). Длительность: {duration} мин. Формат: {meeting_format}. {meeting_note}',
  },
  {
    type: MessageTemplateType.BOOKING_REJECTED,
    text: 'Заявка отклонена. {reason_optional}',
  },
  {
    type: MessageTemplateType.BOOKING_EXPIRED,
    text: 'Заявка закрыта автоматически, так как не была обработана в течение 48 часов. Вы можете создать новую заявку.',
  },
  {
    type: MessageTemplateType.BOOKING_CANCELLED,
    text: 'Встреча отменена. Если событие уже было создано, оно отменено и в Google Calendar.',
  },
  {
    type: MessageTemplateType.RESCHEDULE_SUBMITTED,
    text: 'Запрос на перенос отправлен на согласование. Текущая встреча пока остается без изменений.',
  },
  {
    type: MessageTemplateType.SLOT_UNAVAILABLE,
    text: 'Выбранное время стало недоступно. Создайте новую заявку.',
  },
  {
    type: MessageTemplateType.CONFIRMATION_ERROR,
    text: 'Не удалось подтвердить встречу из-за технической ошибки. Администратор уже получил уведомление.',
  },
];

export async function ensureDefaultData(prisma: PrismaClient): Promise<void> {
  await prisma.scheduleSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      minimumLeadTimeMinutes: 1440,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxMeetingsPerDay: 4,
      bookingHorizonDays: 30,
      timezone: 'Europe/Moscow',
    },
  });

  const workingPeriodCount = await prisma.scheduleWorkingPeriod.count({
    where: { scheduleSettingsId: 1 },
  });
  if (workingPeriodCount === 0) {
    await prisma.scheduleWorkingPeriod.createMany({
      data: [1, 2, 3, 4, 5].map((weekday) => ({
        scheduleSettingsId: 1,
        weekday,
        startMinute: 9 * 60,
        endMinute: 18 * 60,
        enabled: true,
      })),
    });
  }

  for (const template of DEFAULT_TEMPLATES) {
    await prisma.messageTemplate.upsert({
      where: { type: template.type },
      update: {},
      create: template,
    });
  }
}
