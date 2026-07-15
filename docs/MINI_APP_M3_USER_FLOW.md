# Telegram Mini App: контрольная точка M3

Этап M3 превращает согласованный M2-прототип в рабочий пользовательский поток записи. Production-публикация и кнопка запуска из бота остаются задачами M6.

## Что работает

- Сервер отдаёт Mini App по `/mini-app` и локальные ресурсы по `/mini-app/app.js` и `/mini-app/styles.css`.
- Frontend создаёт серверную сессию из подписанного `Telegram.WebApp.initData`; Telegram ID, роль и `initDataUnsafe` не используются как доверенные данные.
- Мастер получает реальные недели, даты и свободные окна из M1 availability API для длительности 30, 45 или 60 минут.
- Доступны онлайн-встреча в Google Meet и личная встреча без видеоссылки.
- Review показывает выбранные данные перед отправкой.
- `POST /api/mini-app/v1/bookings` повторно проверяет окно на сервере и создаёт заявку со `source=MINI_APP` и статусом `PENDING_APPROVAL`.
- Один `idempotencyKey` возвращает одну и ту же заявку при повторной отправке. При конфликте занятого окна UI возвращает пользователя к выбору времени.
- Telegram theme, viewport, safe-area, BackButton, closing confirmation и haptic feedback подключены через официальный Web App API.
- В live-режиме скрыты демонстрационные «Мои записи» и админка; они будут подключены на M4 и M5.

## Запрос создания заявки

```http
POST /api/mini-app/v1/bookings
Origin: https://example.com
Cookie: meeting_mini_app_session=...
Content-Type: application/json
```

```json
{
  "title": "Обсуждение проекта",
  "comment": "Покажу текущий прототип",
  "meetingFormat": "ONLINE",
  "durationMinutes": 30,
  "startAt": "2026-07-20T07:30:00.000Z",
  "email": "ivan@example.com",
  "idempotencyKey": "mini-app:550e8400-e29b-41d4-a716-446655440000"
}
```

Допустимый `Origin` берётся только из `PUBLIC_BASE_URL`. Время и timezone не принимаются на доверии от frontend: timezone выбирается из серверных настроек, а слот сверяется через существующий `AvailabilityService`.

## Локальная визуальная проверка

После запуска backend страница доступна по:

```text
http://127.0.0.1:3000/mini-app?demo=1
```

`demo=1` нужен только для браузерной проверки без Telegram. Без этого параметра приложение требует подтверждённую Telegram-сессию и не переходит к mock-данным автоматически.

## Автоматическая проверка

```powershell
npm.cmd run typecheck
npm.cmd run prototype:smoke
npm.cmd run test:e2e
npm.cmd test
```

M3 E2E проверяет HTML/CSP, Telegram-сессию, реальные availability endpoints, создание заявки, защиту Origin, идемпотентный повтор, одну строку в SQLite и отображение этой заявки в существующей команде бота `/bookings`.
