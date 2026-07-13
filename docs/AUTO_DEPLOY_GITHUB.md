# Автоматическое обновление бота из GitHub

После настройки каждый `push` в ветку `main` запускает GitHub Actions. Сначала выполняются все тесты проекта. Только если они прошли, GitHub передаёт на VPS архив с проверенным кодом и запускает закрытый серверный сценарий развёртывания.

## Что происходит автоматически

1. GitHub Actions получает конкретный commit и выполняет `npm ci` и `npm test`.
2. В архив попадает только код и production-конфигурация сборки. `.env.production`, SQLite-база, резервные копии и локальные файлы в архив не входят.
3. Архив передаётся отдельному пользователю `meeting-deploy` по ED25519 SSH-ключу с обязательной проверкой host key.
4. Сервер собирает новый Docker image, не останавливая работающего бота.
5. Перед переключением контейнера сервер останавливает бот на короткое время и сохраняет согласованную копию SQLite в `backups/`.
6. Новый контейнер запускается и проверяется через Docker healthcheck и `GET /health`.
7. При ошибке автоматически восстанавливаются прежний image и копия базы. Глобальная очистка Docker на общем сервере не выполняется.

Автоматический откат защищает работающий бот, но не заменяет наблюдение за красным статусом GitHub Actions: неуспешное обновление всё равно следует изучить до следующей отправки кода.

## Настройки GitHub

Репозиторий: `ridrid25/pomoshchnik-naznacheniya-vstrech`.

Переменные Actions (`Settings` → `Secrets and variables` → `Actions` → `Variables`):

| Имя | Значение |
| --- | --- |
| `VPS_HOST` | `85.198.98.201` |
| `VPS_SSH_PORT` | `22` |
| `VPS_SSH_USER` | `meeting-deploy` |
| `VPS_APP_DIR` | `/opt/meeting-assistant` |
| `PUBLIC_HEALTH_URL` | `https://meeting.85.198.98.201.sslip.io/health` |

Секреты Actions (`Settings` → `Secrets and variables` → `Actions` → `Secrets`):

| Имя | Содержимое |
| --- | --- |
| `VPS_SSH_PRIVATE_KEY` | Полный приватный ED25519-ключ для пользователя `meeting-deploy` |
| `VPS_KNOWN_HOSTS` | Проверенная строка ED25519 host key сервера для `85.198.98.201` |

Не помещайте в GitHub Secrets содержимое `.env.production`: этот файл уже хранится на VPS и сохраняется при каждом обновлении.

## Однократная ручная настройка, если её нужно повторить

На своём компьютере создайте отдельный ключ без парольной фразы:

```powershell
ssh-keygen -t ed25519 -C github-actions-meeting-bot -f github_actions_meeting_bot_ed25519
```

Передайте на VPS только файл `.pub`, затем от root выполните:

```bash
cd /opt/meeting-assistant
sh scripts/install-github-deploy-access.sh /путь/к/github_actions_meeting_bot_ed25519.pub
```

Приватную часть добавьте в `VPS_SSH_PRIVATE_KEY`. Для `VPS_KNOWN_HOSTS` используйте только заранее проверенный ключ сервера, а не непроверенный результат из сети.

Если менялся сам `scripts/deploy-on-server.sh`, его новую версию должен один раз установить root. Обычные изменения приложения такого ручного действия не требуют.

## Обычная работа после настройки

Дальше вручную на сервер заходить не нужно. После отправки кода в `main` откройте вкладку `Actions` репозитория и при желании следите за сценарием `Deploy Production`. Его также можно запустить кнопкой `Run workflow`.

Успешный commit записывается на VPS в `/opt/meeting-assistant/.deployed-sha`. Резервные копии создаются в `/opt/meeting-assistant/backups/` с именем `app-before-<commit>-<время>.db`.

## Если обновление не прошло

- Если упали тесты, production вообще не меняется.
- Если не удалась передача по SSH, проверьте срок жизни/содержимое двух Secrets и пользователя `meeting-deploy`.
- Если новый контейнер не прошёл healthcheck, сервер выполнит автоматический откат и Actions покажет ошибку.
- Для диагностики откройте неуспешный run в `Actions`; серверные логи приложения доступны командой `docker compose --env-file .env.production logs --tail=150 app` в `/opt/meeting-assistant`.
