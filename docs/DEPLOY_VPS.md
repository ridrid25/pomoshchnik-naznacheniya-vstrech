# Production deploy на VPS

Эта инструкция поднимает один экземпляр backend, SQLite на диске VPS и HTTPS через Caddy. В production Telegram работает через webhook, long polling отключён. По умолчанию backend публикуется только на `127.0.0.1:3020`, чтобы его мог безопасно обслуживать уже установленный на VPS Caddy. Встроенный Caddy-контейнер доступен через профиль `bundled-proxy` для чистого VPS, где порты `80/443` свободны.

## 1. Что потребуется

- VPS с Ubuntu 22.04/24.04 и открытыми TCP-портами `22`, `80`, `443`, а также UDP `443` для HTTP/3;
- Docker Engine и Docker Compose plugin по официальной инструкции Docker;
- домен или поддомен с `A`-записью на IP VPS;
- Telegram bot token, числовой Telegram ID администратора и Google OAuth credentials;
- OAuth redirect URI вида `https://bot.example.com/google/oauth/callback` в Google Cloud Console.

Не устанавливайте сторонние SMS add-on для Google Calendar: текущий MVP отправляет напоминания через Telegram или SMTP Email и не хранит номера телефонов.

## 2. Подготовка каталога

Разместите репозиторий на сервере, например в `/opt/meeting-assistant`, затем выполните:

```bash
cd /opt/meeting-assistant
mkdir -p data backups
chown -R 1000:1000 data backups
cp .env.production.example .env.production
chmod 600 .env.production
```

Не копируйте локальные `.env`, `data/` и `backups/` на VPS и не перезаписывайте существующий `.env.production` при последующих обновлениях.

## 3. Production-переменные

Откройте `.env.production` только на VPS и заполните:

- `DOMAIN` — публичный домен без `https://`;
- `APP_BIND_PORT` — необязательный локальный порт backend, по умолчанию `3020`;
- `TELEGRAM_BOT_TOKEN` — токен от BotFather;
- `TELEGRAM_WEBHOOK_SECRET` — случайный секрет, например результат `openssl rand -hex 32`;
- `ADMIN_TELEGRAM_ID` — числовой Telegram ID владельца;
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`;
- `GOOGLE_OAUTH_REDIRECT_URI=https://DOMAIN/google/oauth/callback` с реальным доменом;
- `PUBLIC_BASE_URL=https://DOMAIN` — публичный HTTPS-адрес без пути в конце;
- `ADMIN_ACTION_SECRET` — отдельный случайный секрет для ссылок из Google Calendar, например результат `openssl rand -hex 32`;
- `MINI_APP_SESSION_SECRET` — отдельный случайный секрет не короче 32 символов, например результат `openssl rand -hex 32`;
- `MINI_APP_SESSION_TTL_SECONDS=7200` — срок защищённой Mini App-сессии;
- `MINI_APP_INIT_DATA_MAX_AGE_SECONDS=600` — допустимый возраст Telegram `initData`;
- SMTP-поля — только после выбора почтового провайдера.

Обязательные production-значения нельзя хранить в Git или присылать в чат.

## 4. Проверка и первый запуск

```bash
docker compose --env-file .env.production config
docker compose --env-file .env.production build --pull
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=100 app
```

Если на VPS уже работает системный Caddy, добавьте в его `/etc/caddy/Caddyfile` отдельный блок и безопасно перезагрузите конфигурацию:

```caddyfile
bot.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3020
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

На чистом VPS без reverse proxy запускайте встроенный Caddy:

```bash
docker compose --env-file .env.production --profile bundled-proxy up -d --build
docker compose --env-file .env.production --profile bundled-proxy logs --tail=100 app caddy
```

Ожидаемый результат: `app` получает статус `healthy`, выбранный Caddy выпускает TLS-сертификат, а `https://DOMAIN/health` возвращает JSON со `status=ok`.

Дополнительно проверьте Mini App:

```bash
curl --fail --silent --show-error "https://DOMAIN/mini-app" | grep 'Запись на встречу'
curl --fail --silent --show-error "https://DOMAIN/mini-app/app.js" | grep 'idempotencyKey'
sh scripts/verify-production-mini-app.sh /opt/meeting-assistant
```

При каждом старте backend настраивает стандартную кнопку меню Telegram через `setChatMenuButton`. Она должна иметь тип `commands` и раскрывать рабочие команды бота. Mini App открывается отдельной кнопкой `web_app` в сообщении главного меню и ведёт строго на `https://DOMAIN/mini-app`.

## 5. Установка Telegram webhook

На VPS загрузите переменные только в текущую shell-сессию:

```bash
set -a
. ./.env.production
set +a

curl --fail --silent --show-error \
  --request POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://${DOMAIN}/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'

curl --fail --silent --show-error \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"

unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
```

`getWebhookInfo` должен вернуть нужный HTTPS URL и пустое `last_error_message`.

## 6. Эксплуатация

```bash
# Статус и health
docker compose --env-file .env.production ps
curl --fail --silent --show-error "https://$(grep '^DOMAIN=' .env.production | cut -d= -f2)/health"

# Логи backend; для системного Caddy используйте journalctl -u caddy
docker compose --env-file .env.production logs --tail=200 app
journalctl -u caddy --since '10 minutes ago' --no-pager

# Рестарт backend без удаления данных
docker compose --env-file .env.production restart app

# Обновление после доставки новых файлов
docker compose --env-file .env.production up -d --build

# Остановка и повторный запуск
docker compose --env-file .env.production stop
docker compose --env-file .env.production start
```

Не используйте `docker compose down -v`: ключ `-v` удаляет именованные данные Caddy. Каталоги `data/` и `backups/` нельзя удалять при обновлении.

## 7. Безопасная резервная копия SQLite

Для простой согласованной копии кратко остановите только backend:

```bash
cd /opt/meeting-assistant
docker compose --env-file .env.production stop app
cp data/app.db "backups/app-$(date -u +%Y%m%dT%H%M%SZ).db"
docker compose --env-file .env.production start app
docker compose --env-file .env.production ps
```

Проверьте, что backup имеет ненулевой размер. Храните дополнительную копию вне VPS.

## 8. Проверка устойчивости

1. Создайте тестовую заявку в Telegram.
2. Запомните количество записей и размер `data/app.db`.
3. Выполните `docker compose --env-file .env.production restart app`.
4. Дождитесь статуса `healthy`.
5. Убедитесь, что заявка сохранилась и бот продолжает отвечать.
6. Проверьте `getWebhookInfo` и отсутствие новых ошибок в логах Caddy/backend.

## 9. Диагностика

- `app` не стартует: проверьте обязательные переменные и `docker compose ... logs app`;
- Caddy не выпускает сертификат: проверьте DNS, доступность `80/443` и firewall;
- Telegram не отвечает: проверьте `getWebhookInfo`, webhook secret и строки `telegram.webhook.received`;
- Google OAuth не завершается: redirect URI в Google Cloud должен в точности совпадать с production URL;
- SQLite сообщает `permission denied`: повторите `chown -R 1000:1000 data backups`.
