# Valorant Community Telegram Bot — План реализации

## Что строим
Telegram бот для управления группой ~30 украинских Valorant игроков:
1. Юзер пишет боту → вводит Riot ID (`Name#TAG`)
2. Бот валидирует через Riot API → получает PUUID
3. Бот добавляет юзера в Telegram группу
4. Бот ставит юзера админом с `custom_title` = его Riot ID (напр. `rudi#1001`)
5. Периодическая джоба каждые 6ч синхронизирует ники (PUUID → текущий ник → обновляет тайтл если изменился)
6. Периодическая джоба каждые 10 мин проверяет новые матчи — если кто-то сделал ACE, бот пишет в группу с ссылкой на матч

---

## Стек
- **Runtime**: Bun
- **Язык**: TypeScript
- **Telegram библиотека**: `grammy`
- **Riot API**: нативный `fetch` (встроен в Bun), база `https://europe.api.riotgames.com`
- **Хранилище**: JSON файл `data/users.json` (БД не нужна для 30 юзеров)
- **Деплой**: Docker на личном NAS

---

## Структура проекта
```
valorant-community-bot/
├── src/
│   ├── index.ts        # Entry point — запускает бота + периодическую джобу
│   ├── bot.ts          # grammy бот, /start хендлер, хендлер сообщений
│   ├── riot.ts         # Riot API: validateByName(), getByPuuid()
│   ├── storage.ts      # loadUsers(), saveUsers(), addUser(), updateUser()
│   └── jobs.ts         # syncNicknames() каждые 6ч + checkAces() каждые 10мин
├── data/
│   └── users.json      # { "users": [...] } — создаётся при первом запуске
├── .env                # секреты (см. ниже)
├── .env.example        # шаблон для .env
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## ACE Detection

### Логика
- Джоба запускается каждые 10 минут через `setInterval` в `jobs.ts`
- Для каждого юзера: запрос последних матчей → берём первый (последний сыгранный) → сравниваем `matchId` с `lastMatchId` в `users.json`
- Если `matchId` новый → анализируем раунды на ACE
- ACE = в одном раунде у игрока kills == 5
- Если ACE найден → отправляем в группу сообщение + ссылка на tracker.gg

### Закрытый профиль
- Henrik's API возвращает ошибку или пустой массив матчей для закрытых профилей
- В этом случае просто пропускаем юзера, уведомление не отправляем
- Не нужно ничего писать юзеру — просто тихий skip

### Ссылка на матч
```
https://tracker.gg/valorant/match/{matchId}
```
matchId из Henrik's API совпадает с Riot internal ID — tracker.gg использует тот же формат.

### Пример уведомления в группу
```
🔥 rudi#1001 сделал ACE!
👉 https://tracker.gg/valorant/match/...
```

---

## Модель данных (`data/users.json`)
```typescript
interface User {
  telegramId: number;
  telegramUsername?: string;
  riotId: string;        // "Name#TAG" — обновляется при синке
  puuid: string;         // внутренний ID Riot — никогда не меняется
  lastMatchId?: string;  // последний обработанный матч (для ACE detection)
  addedAt: string;       // ISO дата
}
```

```json
{
  "users": [
    {
      "telegramId": 123456789,
      "telegramUsername": "rudi",
      "riotId": "rudi#1001",
      "puuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "lastMatchId": "EU-1234567890",
      "addedAt": "2026-04-09T12:00:00Z"
    }
  ]
}
```

---

## Riot API
Используем **Henrik's Valorant API** — неофициальный публичный враппер, не требует ключа. Запросы идут к Henrik's серверам, не напрямую к Riot — блокировки нет.

| Действие | Endpoint |
|---|---|
| Валидация + получить PUUID | `GET https://api.henrikdev.xyz/valorant/v1/account/{name}/{tag}` |
| Получить текущий ник по PUUID | `GET https://api.henrikdev.xyz/valorant/v1/by-puuid/account/{puuid}` |
| Последние матчи игрока | `GET https://api.henrikdev.xyz/valorant/v3/matches/{region}/{name}/{tag}` |
| Детали матча | `GET https://api.henrikdev.xyz/valorant/v2/match/{matchId}` |

- Ответ аккаунта: `{ data: { puuid, name, tag, ... } }`
- Ответ матча содержит раунды с убийствами по каждому игроку
- Без регистрации, без ключа, бесплатно
- Нагрузка: ~3-6 req/min для 30 юзеров — в пределах нормы

---

## Telegram API — важные нюансы
- `addChatMember(GROUP_ID, telegramId)` — работает потому что юзер сначала написал боту
- `promoteChatMember(GROUP_ID, telegramId, { can_manage_chat: true, custom_title: "rudi#1001" })`
  - Нужно передать хотя бы одно `can_*: true` чтобы `custom_title` заработал
  - `custom_title` максимум 16 символов, `#` поддерживается
  - `rudi#1001` = 9 символов ✓
- Бот должен быть админом группы с правами "Добавление участников" + "Назначение администраторов"

---

## Флоу диалога с ботом
```
Юзер: /start
Бот:  Привет! Чтобы вступить в группу, введи свой Riot ID в формате: NickName#TAG

Юзер: rudi#1001
Бот:  [запрос к Riot API — валидация]
Бот:  Найден аккаунт rudi#1001 ✓ Добавляю тебя в группу...
      [addChatMember → promoteChatMember с custom_title]
Бот:  Готово! Ты в группе с тайтлом "rudi#1001" 🎯

(если аккаунт не найден)
Бот:  Аккаунт не найден. Проверь правильность написания и попробуй снова.

(если уже зарегистрирован)
Бот:  Ты уже в группе с тайтлом "rudi#1001".
```

---

## Environment Variables
```bash
# .env
TELEGRAM_TOKEN=         # токен от @BotFather
GROUP_ID=               # ID Telegram группы (отрицательное число, напр. -1001234567890)
OWNER_ID=               # твой Telegram user ID
```

---

## Docker
```dockerfile
# Dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY src ./src
CMD ["bun", "run", "src/index.ts"]
```

```yaml
# docker-compose.yml
services:
  bot:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data
```

---

## Что подготовить перед реализацией
- [ ] Создать бота через @BotFather → получить `TELEGRAM_TOKEN`
- [ ] Добавить бота в группу → дать права "Добавление участников" + "Назначение администраторов"
- [ ] Узнать `GROUP_ID` (добавить @userinfobot в группу или через API)
- [ ] Узнать свой `OWNER_ID`

---

## Проверка после реализации
1. Добавить бота в тест-группу с нужными правами
2. Написать боту `/start` → ввести реальный Riot ID → убедиться что добавлен в группу с правильным тайтлом
3. Сменить ник в игре → подождать 6ч (или запустить синк вручную) → убедиться что тайтл обновился
4. Проверить что `data/users.json` записывается корректно
5. `docker compose up --build` на NAS → убедиться что бот живёт после рестарта
