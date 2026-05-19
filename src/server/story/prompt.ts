/**
 * prompt.ts — the STORY_PROMPT for the weekly promo image (#227).
 *
 * Iterated from the user's original prompt: deliberately tightened to fight
 * the image model's core weakness — it garbles dense Cyrillic text, nicknames
 * and numbers. We strip the poster down to a few big elements (headline, date,
 * one hero number, top map name, top agent name, CTA) and forbid records /
 * nicknames / stat lists / small agent thumbnails. The exact data lives in the
 * digest message this image replies to, so the poster is a teaser, not a sheet.
 * The plain-text digest (HTML stripped) is appended after `Digest text:` via
 * `appendDigestText()` — the model still reads it to pull the few allowed
 * fields.
 *
 * Delivery is a normal photo reply on the digest message (Story/Business path
 * dropped — owner has no Premium). See issue #227 / src/server/story/NOTES.md.
 */

/** Tightened gpt-image prompt — minimal on-image text to avoid garble. */
export const STORY_PROMPT = `Create a vertical 9:16 promo poster for a weekly Valorant community digest. It is a hype TEASER, not a data sheet — the exact stats live in the digest message this image replies to. Keep on-image text MINIMAL, BIG and BOLD. Few words, large type, lots of breathing room. Garbled or dense text is the main failure mode — prefer few elements rendered cleanly over many small ones. Community branding: a small "Valorant NPC" badge near the top. Do not use official Valorant logos. Use the attached images: 1. Top agent reference — the main hero character: large, on one side or partially behind the layout, preserve its vibe, pose energy, outfit and ability colors; not a real human face. 2. Top map reference — a dark, color-graded background or a single framed card, subtle, behind the text. Visual style: premium futuristic esports / cyberpunk. Dark background. The whole palette MUST be derived from the agent reference (glow, borders, accents, the big number) — cohesive with the agent, not random. No warm yellow/orange unless it is in the agent. Clean, high-contrast, readable, like a pro story cover. On-image text — ONLY the following, nothing else, all in Russian: - Headline «ДАЙДЖЕСТ НЕДЕЛИ» (largest element, at the top). - The digest date, small, under the headline. - ONE huge hero number: total matches this week, e.g. «525», with «МАТЧЕЙ ЗА НЕДЕЛЮ» beneath it. - «ТОП КАРТА» + the top map name (name only). - «ТОП АГЕНТ» + the top agent name (name only). - A bottom CTA strip: «Главные рекорды, лидеры и статистика — в полном дайджесте». Hard restrictions: - Do NOT render any records, player nicknames, K/D, per-weapon or per-pick numbers, "лучшие пики" chips, or any list of stats — those mangle, leave them to the digest text. - Do NOT draw any small agent portraits, icons, thumbnails or avatars anywhere; the big hero from the agent reference is the ONLY character. No mini character next to «ТОП АГЕНТ». - No counts / ×N next to the map or agent — names only. - No tiny text, no clutter, no full-digest copy, no real human faces, no photorealistic people, no distorted UI text. - At most about 7 short text lines on the whole image. From the digest below use ONLY: the date, the total matches number, the top map name, the top agent name. Ignore everything else (records, nicknames, weapon stats, best picks). Digest text:`;

/**
 * Strip HTML tags / entities from the digest text so the model gets clean
 * plain text. The digest is built with HTML parse_mode (`<b>`, `<i>`,
 * `<a href>`) — none of that helps an image model.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Append the plain-text digest to the prompt. The digest text comes in as
 * HTML (the same string posted to Telegram with parse_mode HTML); we strip
 * the markup first.
 */
export function appendDigestText(digestText: string): string {
  return `${STORY_PROMPT}\n\n${stripHtml(digestText)}`;
}
