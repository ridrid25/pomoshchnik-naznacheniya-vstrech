# Помощник назначения встреч

Backend Telegram-бота для согласования встреч в личном Google Calendar владельца.

## Текущий этап

Этап 1: базовый NestJS-каркас, HTTP-контур, health endpoint, Telegram webhook endpoint, конфигурация, JSON-логирование и обработка ошибок.

## Требования

- Node.js 20 или новее;
- npm 10 или новее.

## Локальный запуск

```powershell
Copy-Item .env.example .env
npm install
npm run build
npm start
```

После запуска:

- `GET http://localhost:3000/health`
- `POST http://localhost:3000/telegram/webhook`

## Проверки

```powershell
npm run typecheck
npm test
```

`npm test` собирает приложение, запускает его на свободном локальном порту и проверяет health endpoint, Telegram webhook, webhook-secret и глобальный формат ошибок.

## Безопасность

Секреты хранятся только в локальном `.env`, который исключен из Git. В `.env.example` должны находиться только пустые значения и безопасные примеры.
