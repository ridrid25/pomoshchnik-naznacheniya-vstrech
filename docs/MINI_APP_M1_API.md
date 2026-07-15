# Telegram Mini App: результат этапа M1

Этап M1 добавляет серверную основу Mini App без frontend. Текущий Telegram-бот и его webhook остаются без функциональных изменений.

## Конфигурация

Для включения Mini App нужны существующие `TELEGRAM_BOT_TOKEN` и `PUBLIC_BASE_URL`, а также новые переменные:

```dotenv
MINI_APP_SESSION_SECRET=<случайная строка не короче 32 символов>
MINI_APP_SESSION_TTL_SECONDS=7200
MINI_APP_INIT_DATA_MAX_AGE_SECONDS=600
```

`PUBLIC_BASE_URL` определяет допустимый HTTP `Origin`. В production он обязан использовать HTTPS. Если конфигурация Mini App неполная, создание сессии отвечает `503`, а не переходит в небезопасный режим.

## Аутентификация

1. Frontend отправляет неизменённую строку `Telegram.WebApp.initData` в `POST /api/mini-app/v1/session` как JSON `{ "initData": "..." }`.
2. Сервер проверяет Telegram HMAC-подпись, свежесть `auth_date`, обязательные поля пользователя и отсутствие дублирующихся параметров.
3. Сервер создаёт или обновляет пользователя и возвращает его публичный профиль.
4. Сессия сохраняется в подписанной cookie `meeting_mini_app_session` с `HttpOnly`, `SameSite=Strict` и `Path=/api/mini-app`. В production добавляется `Secure`.

Содержимое `initData`, Telegram hash, bot token и session token не записываются в лог. Роль администратора вычисляется сервером по `ADMIN_TELEGRAM_ID` при каждом запросе и не принимается от клиента.

## API v1

Все маршруты, кроме создания сессии, требуют session cookie.

### Сессия и профиль

- `POST /api/mini-app/v1/session` — создать сессию; требует точный `Origin`, соответствующий `PUBLIC_BASE_URL`.
- `DELETE /api/mini-app/v1/session` — завершить сессию; требует cookie и допустимый `Origin`.
- `GET /api/mini-app/v1/me` — получить профиль и роль `USER | ADMIN`.

Профиль не содержит фотографии или аватара. `telegramId` сериализуется строкой, чтобы не терять точность JavaScript.

### Доступное время

- `GET /api/mini-app/v1/availability/weeks?duration=30`
- `GET /api/mini-app/v1/availability/dates?duration=30&weekOffset=0`
- `GET /api/mini-app/v1/availability/slots?duration=30&date=2026-07-20`

Допустимые длительности: `30`, `45`, `60` минут. Эндпоинты используют существующий `AvailabilityService`, поэтому учитывают расписание, ограничения, буферы, лимит встреч, бронирования и занятость Google Calendar.

## Новые поля заявки

- `source`: `TELEGRAM_BOT | MINI_APP | ADMIN`, по умолчанию `TELEGRAM_BOT`.
- `publicCode`: непредсказуемый публичный код вида `M-XXXXXXXXXX` для новых заявок через сервис; старые записи получают уникальный код при миграции.
- `idempotencyKey`: уникальный ключ повторной отправки. Один пользователь с тем же ключом получает уже созданную заявку; ключ другого пользователя не раскрывает чужую запись.

## Автоматическая проверка

```powershell
npm.cmd run typecheck
npm.cmd run test:e2e
npm.cmd run db:smoke
npm.cmd run booking:smoke
npm.cmd test
```

E2E-тест проверяет валидную, подменённую и истёкшую подпись Telegram, роли, блокировку запросов без сессии, защиту Origin, параметры cookie, выход и чтение расписания. Database smoke проверяет, что повторная инициализация не затирает настройки администратора. Booking smoke проверяет публичный код и идемпотентное создание заявки.
