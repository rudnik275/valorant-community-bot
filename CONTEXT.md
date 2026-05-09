# CONTEXT.md — Valorant Community Bot Glossary

Domain terminology used throughout the codebase. See issue #2 for full architecture.

## Glossary

**Match record** — компактная denorm-форма ranked-матча в БД; хранит PUUID игрока, дату, исход, агента, K/D/A и ключевые агрегаты матча без необходимости повторно запрашивать API (см. #2 секция 10).

**Detected event** — строка таблицы `detected_events` со статусом `pending` / `posted` / `digest-only` / `silent` / `opted-out`; представляет один заметный игровой момент (эйс, клатч, антистат), готовый к публикации в чат.

**Scan-tick** — фоновый cron-job (croner), запускается каждые 30 минут; тянет новые матчи из Henrik API для всех зарегистрированных игроков и пишет Match records + Detected events в БД.

**Publisher-tick** — фоновый cron-job (croner), запускается каждые 1 минуту; читает `pending` Detected events и постит их в Telegram-чат с соблюдением Anti-spam quota.

**Silent-period** — временное окно (~первая неделя после деплоя), в течение которого события только накапливаются в БД и не публикуются в чат; позволяет набрать историческую базу без флуда.

**Anti-spam quota** — лимиты публикации событий: не более 2 сообщений в чат в день, не более 1 антистат-события на игрока в день, не более 1 сообщения на игрока, тихие часы до 12:00 по Киеву; opt-out обязателен.

**Trust-based identity** — юзер сам вводит свой Riot ID (`Name#TAG`) командой бота без OAuth/RSO; бот доверяет вводу без верификации (подходит для закрытого 30-чел. сообщества).

**Fake-admin custom_title** — паттерн для красивых тайтлов в Telegram без выдачи реальных прав: promote пользователя до anonymous admin → set_chat_administrator_custom_title → demote обратно. Права не выдаются — только заголовок.

**Allowlist (chat scope)** — список ID чатов в переменной `TELEGRAM_ALLOWED_CHAT_IDS`; бот полностью игнорирует сообщения из чатов, не вошедших в список, что исключает злоупотребление при случайном добавлении.
