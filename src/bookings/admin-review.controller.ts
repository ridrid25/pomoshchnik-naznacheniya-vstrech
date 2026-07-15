import { Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { PrismaService } from '../database/prisma.service';
import { BookingStatus, MeetingFormat } from '../generated/prisma/client';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { AdminReviewTokenService } from './admin-review-token.service';
import {
  BookingDecisionService,
  type BookingDecisionAction,
  type BookingDecisionOutcome,
} from './booking-decision.service';

@Controller('admin/review')
export class AdminReviewController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminReviewTokenService,
    private readonly decisions: BookingDecisionService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  @Get(':token')
  async showReview(
    @Param('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    const payload = this.tokens.verifyToken(token);
    if (!payload) {
      this.send(response, 403, page('Ссылка недействительна', invalidLinkBody()));
      return;
    }
    const booking = await this.prisma.booking.findUnique({
      where: { id: payload.bookingId },
      include: { user: true },
    });
    if (!booking) {
      this.send(response, 404, page('Заявка не найдена', invalidLinkBody()));
      return;
    }
    const calendarUrl = await this.calendarDayUrl(
      booking.startAt,
      booking.timezone,
    );

    const actions =
      booking.status === BookingStatus.PENDING_APPROVAL
        ? `<div class="actions">
            <form method="post" action="/admin/review/${escapeAttribute(token)}/confirm">
              <button class="confirm" type="submit">✓ Подтвердить</button>
            </form>
            <form method="post" action="/admin/review/${escapeAttribute(token)}/reject">
              <button class="reject" type="submit">✕ Отклонить</button>
            </form>
          </div>
          <p class="hint">Действие выполнится только после нажатия кнопки. Простое открытие этой страницы ничего не меняет.</p>`
        : `<div class="result neutral">${escapeHtml(statusLabel(booking.status))}</div>
           <p class="hint">Эта заявка уже обработана. Повторное нажатие ничего не изменит.</p>`;
    this.send(
      response,
      200,
      page(
        'Заявка на встречу',
        `<div class="status">⏳ Ожидает вашего решения</div>
         ${bookingCard(booking)}
         ${actions}`,
        calendarUrl,
      ),
    );
  }

  @Post(':token/:action')
  async submitDecision(
    @Param('token') token: string,
    @Param('action') actionValue: string,
    @Res() response: Response,
  ): Promise<void> {
    const payload = this.tokens.verifyToken(token);
    const action = parseAction(actionValue);
    if (!payload || !action) {
      this.send(response, 403, page('Ссылка недействительна', invalidLinkBody()));
      return;
    }
    try {
      const result = await this.decisions.decide(payload.bookingId, action);
      const booking = await this.prisma.booking.findUnique({
        where: { id: payload.bookingId },
        include: { user: true },
      });
      const calendarUrl = booking
        ? await this.calendarDayUrl(booking.startAt, booking.timezone)
        : null;
      const content = `${booking ? bookingCard(booking) : ''}${decisionResult(result.outcome)}`;
      this.send(
        response,
        200,
        page('Решение сохранено', content, calendarUrl),
      );
    } catch {
      this.send(
        response,
        500,
        page(
          'Не удалось выполнить действие',
          '<div class="result error">Заявка не изменена. Вернитесь в Telegram и повторите действие.</div>',
        ),
      );
    }
  }

  private send(response: Response, status: number, html: string): void {
    response
      .status(status)
      .set({
        'Cache-Control': 'no-store, max-age=0',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      })
      .type('html')
      .send(html);
  }

  private async calendarDayUrl(
    startAt: Date,
    timezone: string,
  ): Promise<string | null> {
    try {
      return await this.googleCalendar.getCalendarDayUrl(startAt, timezone);
    } catch {
      return null;
    }
  }
}

function parseAction(value: string): BookingDecisionAction | null {
  return value === 'confirm' || value === 'reject' ? value : null;
}

function bookingCard(booking: {
  title: string;
  startAt: Date;
  durationMinutes: number;
  timezone: string;
  comment: string | null;
  meetingFormat: MeetingFormat;
  user: { telegramDisplayName: string; telegramUsername: string | null };
}): string {
  const dateTime = new Intl.DateTimeFormat('ru-RU', {
    timeZone: booking.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(booking.startAt);
  return `<section class="card">
    <h2>${escapeHtml(booking.title)}</h2>
    <dl>
      <dt>Когда</dt><dd>${escapeHtml(dateTime)} (${escapeHtml(booking.timezone)})</dd>
      <dt>Длительность</dt><dd>${booking.durationMinutes} минут</dd>
      <dt>Формат</dt><dd>${booking.meetingFormat === MeetingFormat.ONLINE ? 'Онлайн · Google Meet' : 'Личная встреча'}</dd>
      <dt>Кто</dt><dd>${escapeHtml(booking.user.telegramDisplayName)}${booking.user.telegramUsername ? ` (@${escapeHtml(booking.user.telegramUsername)})` : ''}</dd>
      <dt>Комментарий</dt><dd>${escapeHtml(booking.comment || 'Без комментария')}</dd>
    </dl>
  </section>`;
}

function decisionResult(outcome: BookingDecisionOutcome): string {
  const result: Record<BookingDecisionOutcome, [string, string]> = {
    CONFIRMED: ['success', '✓ Заявка подтверждена. Серое событие стало обычной встречей.'],
    REJECTED: ['rejected', '✕ Заявка отклонена. Серое событие убрано из календаря.'],
    BLOCKED: ['rejected', '✕ Заявка отклонена, пользователь заблокирован.'],
    SLOT_UNAVAILABLE: ['error', 'Время уже занято. Заявка закрыта.'],
    CONFIRMATION_ERROR: ['error', 'Не удалось создать событие Google Calendar. Проверьте Telegram.'],
    ALREADY_PROCESSED: ['neutral', 'Эта заявка уже была обработана ранее. Повторное действие не выполнено.'],
  };
  return `<div class="result ${result[outcome][0]}">${result[outcome][1]}</div>`;
}

function statusLabel(status: BookingStatus): string {
  const labels: Record<BookingStatus, string> = {
    PENDING_APPROVAL: '⏳ Ожидает решения',
    CONFIRMED: '✓ Заявка уже подтверждена',
    REJECTED: '✕ Заявка уже отклонена',
    EXPIRED: 'Время на решение истекло',
    CANCELLED_BY_USER: 'Заявку отменил пользователь',
    SLOT_UNAVAILABLE: 'Время стало недоступно',
    CONFIRMATION_ERROR: 'Ошибка подтверждения',
  };
  return labels[status];
}

function invalidLinkBody(): string {
  return '<div class="result error">Эта ссылка повреждена или срок её действия истёк. Откройте заявку в Telegram.</div>';
}

function page(title: string, body: string, calendarUrl: string | null = null): string {
  const calendarAction = calendarUrl
    ? `<a class="calendar-link" href="${escapeHtml(calendarUrl)}">← Вернуться в Google Calendar</a>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#202124;scroll-behavior:smooth}*{box-sizing:border-box}body{margin:0;padding:24px 16px 104px}main{max-width:620px;margin:0 auto}h1{font-size:26px;margin:0 0 18px}h2{font-size:21px;margin:0 0 18px}.status{color:#5f6368;font-weight:650;margin:0 0 12px}.card{background:#fff;border:1px solid #dadce0;border-radius:18px;padding:22px;box-shadow:0 2px 8px #3c40431a}dl{display:grid;grid-template-columns:150px 1fr;gap:10px 14px;margin:0}dt{color:#5f6368}dd{margin:0;white-space:pre-wrap}.actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.actions form{margin:0}.actions button{width:100%;min-height:54px;border:0;border-radius:14px;color:#fff;font-size:17px;font-weight:750;cursor:pointer}.confirm{background:#188038}.reject{background:#c5221f}.hint{color:#5f6368;font-size:14px;line-height:1.45}.result{margin-top:18px;padding:18px;border-radius:14px;font-weight:700;line-height:1.45}.success{background:#e6f4ea;color:#137333}.rejected{background:#fce8e6;color:#a50e0e}.error{background:#fce8e6;color:#a50e0e}.neutral{background:#e8f0fe;color:#174ea6}.calendar-link{display:flex;min-height:54px;align-items:center;justify-content:center;margin-top:18px;padding:12px 18px;border-radius:14px;background:#1a73e8;color:#fff;font-size:16px;font-weight:750;text-align:center;text-decoration:none}.scroll-controls{position:fixed;right:14px;bottom:18px;z-index:10;display:grid;gap:8px}.scroll-controls[hidden]{display:none}.scroll-control{width:48px;height:48px;border:1px solid #dadce0;border-radius:50%;background:#fff;color:#1a73e8;box-shadow:0 4px 16px #3c404333;font-size:24px;font-weight:800}.scroll-control:disabled{opacity:.35}@media(max-width:520px){body{padding:18px 12px 104px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:10px}.actions{grid-template-columns:1fr}}
  </style></head><body><main id="page-top"><h1>${escapeHtml(title)}</h1>${body}${calendarAction}<span id="page-end"></span></main><nav class="scroll-controls" id="scrollControls" aria-label="Быстрая прокрутка" hidden><button class="scroll-control" id="scrollUp" type="button" aria-label="Прокрутить вверх">↑</button><button class="scroll-control" id="scrollDown" type="button" aria-label="Прокрутить вниз">↓</button></nav><script>
  (()=>{const controls=document.getElementById('scrollControls');const up=document.getElementById('scrollUp');const down=document.getElementById('scrollDown');const stops=()=>[...document.querySelectorAll('h1,.card,.actions,.result,.calendar-link,#page-end')].filter((element)=>element.offsetParent!==null).map((element)=>Math.max(0,Math.round(element.getBoundingClientRect().top+scrollY-12))).filter((value,index,all)=>index===0||value!==all[index-1]);const refresh=()=>{const max=Math.max(0,document.documentElement.scrollHeight-innerHeight);controls.hidden=max<24;up.disabled=scrollY<12;down.disabled=scrollY>max-12};const move=(direction)=>{const current=scrollY;const positions=stops();const target=direction>0?positions.find((value)=>value>current+24):positions.reverse().find((value)=>value<current-24);scrollTo({top:target??(direction>0?document.documentElement.scrollHeight:0),behavior:'smooth'})};up.addEventListener('click',()=>move(-1));down.addEventListener('click',()=>move(1));addEventListener('scroll',refresh,{passive:true});addEventListener('resize',refresh);refresh()})();
  </script></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(encodeURIComponent(value));
}
