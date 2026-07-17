import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { MessageTemplateType } from '../generated/prisma/client';
import { MiniAppAdminGuard } from './auth/mini-app-admin.guard';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type { MiniAppAdminTemplateContract } from './mini-app.contracts';

interface TemplateBody {
  text?: unknown;
}

interface PlaceholderDefinition {
  name: string;
  label: string;
}

const BOOKING_PLACEHOLDERS: PlaceholderDefinition[] = [
  { name: 'date', label: 'Дата встречи' },
  { name: 'time', label: 'Время встречи' },
  { name: 'tz_label', label: 'Часовой пояс' },
  { name: 'duration', label: 'Длительность в минутах' },
  { name: 'meeting_format', label: 'Формат встречи' },
  { name: 'meeting_note', label: 'Примечание о формате' },
];

const TEMPLATE_DEFINITIONS: Record<
  MessageTemplateType,
  { label: string; placeholders: PlaceholderDefinition[] }
> = {
  [MessageTemplateType.BOOKING_SUBMITTED]: {
    label: 'Заявка отправлена',
    placeholders: BOOKING_PLACEHOLDERS,
  },
  [MessageTemplateType.BOOKING_CONFIRMED]: {
    label: 'Встреча подтверждена',
    placeholders: BOOKING_PLACEHOLDERS,
  },
  [MessageTemplateType.BOOKING_REJECTED]: {
    label: 'Заявка отклонена',
    placeholders: [{ name: 'reason_optional', label: 'Причина отклонения' }],
  },
  [MessageTemplateType.BOOKING_EXPIRED]: {
    label: 'Срок заявки истёк',
    placeholders: [],
  },
  [MessageTemplateType.BOOKING_CANCELLED]: {
    label: 'Встреча отменена',
    placeholders: [],
  },
  [MessageTemplateType.RESCHEDULE_SUBMITTED]: {
    label: 'Запрос на перенос отправлен',
    placeholders: [],
  },
  [MessageTemplateType.SLOT_UNAVAILABLE]: {
    label: 'Время стало недоступно',
    placeholders: [],
  },
  [MessageTemplateType.CONFIRMATION_ERROR]: {
    label: 'Ошибка подтверждения',
    placeholders: [],
  },
};

@Controller('api/mini-app/v1/admin/templates')
@UseGuards(MiniAppAuthGuard, MiniAppAdminGuard)
export class MiniAppAdminTemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(): Promise<{ templates: MiniAppAdminTemplateContract[] }> {
    const templates = await this.prisma.messageTemplate.findMany();
    const byType = new Map(templates.map((template) => [template.type, template]));
    return {
      templates: Object.values(MessageTemplateType).flatMap((type) => {
        const template = byType.get(type);
        return template ? [toContract(template)] : [];
      }),
    };
  }

  @Patch(':type')
  @UseGuards(MiniAppOriginGuard)
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('type') rawType: string,
    @Body() body: TemplateBody,
  ): Promise<{ template: MiniAppAdminTemplateContract }> {
    const type = parseType(rawType);
    const text = parseText(body.text, TEMPLATE_DEFINITIONS[type].placeholders);
    const template = await this.prisma.messageTemplate.upsert({
      where: { type },
      create: { type, text },
      update: { text },
    });
    return { template: toContract(template) };
  }
}

function toContract(template: {
  type: MessageTemplateType;
  text: string;
  updatedAt: Date;
}): MiniAppAdminTemplateContract {
  const definition = TEMPLATE_DEFINITIONS[template.type];
  return {
    type: template.type,
    label: definition.label,
    text: template.text,
    allowedPlaceholders: definition.placeholders,
    updatedAt: template.updatedAt.toISOString(),
  };
}

function parseType(value: string): MessageTemplateType {
  if (Object.values(MessageTemplateType).includes(value as MessageTemplateType)) {
    return value as MessageTemplateType;
  }
  throw new BadRequestException('Неизвестный тип шаблона');
}

function parseText(value: unknown, placeholders: PlaceholderDefinition[]): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('Текст шаблона обязателен');
  }
  const text = value.trim();
  if (!text) throw new BadRequestException('Текст шаблона не может быть пустым');
  if (text.length > 4000) {
    throw new BadRequestException('Текст шаблона не должен превышать 4000 символов');
  }

  const allowed = new Set(placeholders.map((placeholder) => placeholder.name));
  const unknown = new Set<string>();
  for (const match of text.matchAll(/\{([^{}]*)\}/gu)) {
    if (!allowed.has(match[1])) unknown.add(match[1] || 'пустая переменная');
  }
  const withoutTokens = text.replace(/\{[^{}]*\}/gu, '');
  if (/[{}]/u.test(withoutTokens)) {
    throw new BadRequestException('Проверьте парные фигурные скобки в тексте');
  }
  if (unknown.size) {
    throw new BadRequestException(
      `Недопустимые переменные: ${[...unknown].map((name) => `{${name}}`).join(', ')}`,
    );
  }
  return text;
}
