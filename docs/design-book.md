# Design Book

Визуальный язык всего интерфейса проекта (Mini App, любые будущие веб-страницы). Извлечён из снесённой публичной landing-страницы `/about` (см. историю до коммита, удаляющего `src/web/public/about.html`). Это **источник истины** — все Vue-страницы Mini App (`Onboard`, `Settings`, `MembersList`) и любые новые поверхности должны соответствовать этому документу.

## Theme

«Глубокая ночь с фиолетово-синим свечением» — тёмная база с едва уловимым тёплым центром, перекрытая прохладными акцентами. Тон спокойный, технологичный, без агрессии.

## Color tokens

Объявляются как CSS custom properties в `:root` и используются по всему проекту:

```css
:root {
  /* Backgrounds */
  --bg-0: #07070b;             /* near-black base */

  /* Foreground */
  --fg: #f1f1f7;               /* primary text (off-white) */
  --muted: #8b8b9c;            /* secondary text (cool grey) */

  /* Glass surfaces — semi-transparent layers stacked over background */
  --glass-bg: rgba(255, 255, 255, 0.045);          /* surface */
  --glass-bg-hover: rgba(255, 255, 255, 0.075);    /* surface hover */
  --glass-border: rgba(255, 255, 255, 0.10);       /* default border */
  --glass-border-strong: rgba(255, 255, 255, 0.18); /* emphasized border */

  /* Accents — gradient pair, used together for ranges/icons/highlights */
  --accent-a: #7383ff;         /* blue-purple, primary accent */
  --accent-b: #b15eff;         /* pure purple, secondary accent */

  /* Shadows */
  --shadow-deep: 0 30px 80px -20px rgba(0, 0, 0, 0.7);

  /* Status colors (ad-hoc, named usage only) */
  --status-online: #5be3a4;    /* online dot, success */
  --status-warn: rgba(255, 122, 79, 0.7); /* "no" / forbidden indicator */
}
```

**Rules:**
- Никогда не использовать чистый чёрный (`#000`) — всегда `var(--bg-0)`.
- Текст всегда `var(--fg)` или `var(--muted)`. Никаких inline-цветов вне токенов.
- Акцентные цвета — **только парой** через `linear-gradient(135deg, var(--accent-a), var(--accent-b))` для outlined элементов (icon backgrounds, brand strokes). Solid одиночный акцент допустим только для ссылок (`color: var(--accent-a)`, hover → `var(--accent-b)`).

## Background system

Тонкое многослойное окружение, которое создаёт ощущение «ауры»:

```css
body { position: relative; overflow-x: hidden; }

body::before, body::after {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
}

/* Layer 1: ambient glow — two radial gradients (blue + purple) over a darker center */
body::before {
  background:
    radial-gradient(ellipse 60% 50% at 30% 20%, rgba(115, 131, 255, 0.22), transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 90%, rgba(177, 94, 255, 0.18), transparent 60%),
    radial-gradient(ellipse 80% 60% at 50% 50%, rgba(20, 22, 40, 1), var(--bg-0) 80%);
}

/* Layer 2: subtle dotted texture, masked to the upper-center for depth */
body::after {
  background-image: radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.04) 1px, transparent 0);
  background-size: 28px 28px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 30%, black 30%, transparent 80%);
  -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 30%, black 30%, transparent 80%);
  opacity: 0.5;
}
```

Не упрощать до flat-чёрного — глубина и есть отличительный знак.

## Typography

```css
html, body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  letter-spacing: -0.01em;  /* slightly tightened by default */
}
```

**Scale (responsive via clamp):**

| Role | Size | Weight | Letter-spacing | Notes |
|---|---|---|---|---|
| H1 / hero | `clamp(36px, 6.4vw, 64px)` | 700 | `-0.03em` | Gradient text fill: `linear-gradient(135deg, var(--fg) 0%, #c8c9e0 100%)` |
| Hero sub | `clamp(16px, 2.2vw, 19px)` | 400 | `-0.01em` | `color: var(--muted)`, `line-height: 1.55`, `max-width: 620px` |
| H2 (section) | `13px` | 700 | `0.16em` | `text-transform: uppercase`, `color: var(--muted)` |
| H3 (card) | `16px` | 600 | `-0.01em` | `color: var(--fg)` |
| Body | `14px` | 400 | inherit | `color: var(--muted)`, `line-height: 1.55` |
| Footer / meta | `13px` | 400 | inherit | `color: var(--muted)`, `line-height: 1.7` |
| Pill / micro-label | `11-12px` | 500-700 | `0.14em–0.16em` | `text-transform: uppercase` |

**Numerals:** для табличных значений (счётчики, версии) добавлять `font-variant-numeric: tabular-nums`.

## Components

### Badge (status indicator with optional dot)

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  padding: 6px 12px;
  border-radius: 999px;
}

.badge-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--status-online);   /* or any status color */
  box-shadow: 0 0 8px var(--status-online);
}
```

Используется для статусных меток вверху страницы («Public community bot · closed alpha») и онлайн-индикаторов.

### Pill (metadata chip)

```css
.pill {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  padding: 7px 13px;
  border-radius: 999px;
}
```

Группа пилюль — `display: flex; flex-wrap: wrap; gap: 10px;`.

### Card (glass surface for content blocks)

```css
.card {
  position: relative;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border-radius: 18px;
  padding: 22px 22px 20px;
  box-shadow: var(--shadow-deep);
  overflow: hidden;
  isolation: isolate;
}

/* Top-down sheen — subtle highlight that gives the card "weight" */
.card::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(160deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0) 40%);
  pointer-events: none;
}
```

Сетка карточек: `display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;`.

### Card icon (gradient-tinted icon container)

```css
.card-icon {
  width: 36px; height: 36px;
  display: grid; place-items: center;
  border-radius: 10px;
  margin-bottom: 14px;
  background: linear-gradient(135deg, rgba(115,131,255,0.2), rgba(177,94,255,0.15));
  border: 1px solid var(--glass-border-strong);
  color: var(--accent-a);
}
```

Внутри `<svg>` 20×20, `stroke-width="1.8"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, `currentColor`.

### Section panel (extended glass surface, larger radius)

```css
section.panel {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border-radius: 22px;
  padding: clamp(22px, 3.2vw, 32px);
  margin-bottom: 40px;
}
```

### List item with status dot

Вместо буллетов — кастомный точечный маркер (gradient или warning):

```css
li {
  position: relative;
  padding-left: 22px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg);
}

li::before {
  content: "";
  position: absolute;
  left: 0; top: 8px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
  box-shadow: 0 0 10px rgba(115, 131, 255, 0.6);
}

li.no::before {
  background: var(--status-warn);
  box-shadow: 0 0 10px rgba(255, 122, 79, 0.5);
}

li .label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 2px;
}
```

### Footer / divider

```css
footer {
  margin-top: 64px;
  padding-top: 28px;
  border-top: 1px solid var(--glass-border);
  font-size: 13px;
  color: var(--muted);
  line-height: 1.7;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  justify-content: space-between;
}
```

## Layout

```css
main {
  max-width: 920px;
  margin: 0 auto;
  padding: clamp(56px, 10vw, 120px) 22px clamp(48px, 8vw, 96px);
}
```

- Max-width 920px для landing-style страниц. Mini App страницы могут быть уже (520px max).
- Боковой padding 22px на всех breakpoint'ах.
- Вертикальный padding clamped — top больше, чтоб контент «дышал» сверху.

## Motion

Минимально:
- `transition: color 0.15s ease;` — для ссылок и hoverable текста.
- `transition: background 0.15s ease, border-color 0.15s ease;` — для glass surface'ов на hover.
- Никаких пружин, scale на hover, parallax. Visual heaviness достигается слоями фона + shadow, не движением.

## Responsive breakpoints

```css
@media (max-width: 520px) {
  /* compact pills, tighter h1 letter-spacing */
  .meta { gap: 8px; }
  .pill { font-size: 11px; padding: 6px 11px; }
  h1 { letter-spacing: -0.02em; }
}
```

Mobile-first: всё по умолчанию работает в узких viewport'ах через clamp/auto-fit. Media queries — только для тонкой подстройки.

## Voice & copy

- **Russian** для всех user-facing текстов (Mini App, нотификации в чат).
- **Tone:** дружелюбный, без воскл. знаков и эмодзи-спама. Эмодзи — точечно, для категорий («🔥» для ace, «💥» для жертв, «📈» для rank-up). Не более одной эмодзи на сообщение.
- **Concise:** «Ранг +18 RR» лучше, чем «Ваш ранг повысился на 18 очков рейтинга».
- **No shame**: упоминая loss-streak или плохую игру — нейтрально, без подколок. «5-й проигрыш подряд» а не «снова сливаешь» и не «опять L».
- **Imperatives** для action labels: «Привязать», «Отвязать», «Сохранить», не «Привязка аккаунта»/«Сохранение».

## Применение к Mini App

Существующие страницы (`Onboard.vue`, `Settings.vue`, `MembersList.vue`) сейчас **не используют** этот язык — они в более простом стиле. Issue [#45](https://github.com/rudnik275/valorant-community-bot/issues/45) трекает приведение их к этому design book'у.

Подход — common stylesheet (`src/web/styles/design-tokens.css` или аналог) с `:root`-переменными и базовыми классами (`.card`, `.pill`, `.badge`, etc.), импортируемый в `main.ts`. Vue компоненты используют классы из этого общего файла + scoped стили только для page-specific layout.

## Что точно НЕ делаем

- Бренд-цветов Riot/Valorant. Этого визуально нет (мы не аффилированы) и юридически (даже если когда-то возьмём Production approval, ToS запрещает использовать их trade dress).
- Никакой 3D, никаких иллюстраций персонажей, никаких скриншотов из игры. Текст + glass surfaces + точечные SVG-иконки на 1.8 stroke.
- Никаких emoji-картинок (🎮🔫🎯) в UI Mini App. Эмодзи только в чат-нотификациях, и только редко.
