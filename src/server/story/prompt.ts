/**
 * prompt.ts — the STORY_PROMPT for the weekly promo image (#227).
 *
 * Iteration of the user's rich prompt with the fixes the user asked for after
 * reviewing real output:
 *   (1) data-binding — every name/number must be read from the appended
 *       digest; the old literal example "Miks 24×"… was being copied
 *       instead of the real top agent.
 *   (2) aspect — model canvas is ~2:3, so all "9:16" wording was replaced
 *       with full-frame ~2:3 to stop the model overflowing the bottom.
 *   (3) no-clip rule — nothing may run off any edge.
 *   (4) RENDER THE WHOLE DIGEST (not a teaser): the user wants every section
 *       on the image — all records, leaders, top-3 maps with counts, top-3
 *       agents with counts, total matches, date. Image-model text garble
 *       scales with density; if prompt-only ever hits its ceiling, the next
 *       step is a deterministic text-overlay compositing layer, not more
 *       prompt tweaks.
 *
 * The whole plain-text digest (HTML stripped) is appended after the trailing
 * `Digest text:` line via `appendDigestText()` so the model has the actual
 * numbers/records to teaser.
 *
 * Delivery is a normal photo reply on the digest message (Story/Business path
 * dropped — owner has no Premium). See issue #227 / src/server/story/NOTES.md.
 */

/** User's gpt-image prompt + data-binding / aspect / no-clip fixes (see above). */
export const STORY_PROMPT = `Create a vertical portrait promo poster for a weekly Valorant community digest. The canvas is a tall portrait at roughly 2:3 (about 1024×1536). Design for the FULL image edge to edge. Every block, including the bottom CTA, MUST fit fully inside the frame with comfortable margins; nothing may be clipped or run off any edge.

Main goal:
Render the WHOLE weekly digest as a stylish poster for a Telegram gaming community. Include every section of the digest at the end of this message — all records / near-miss lines, weekly leaders, total matches, the digest date, every top-map with its count, every top-agent with its count. Nothing from the digest should be missing from the image. The hero character and the map reference are background art; the digest content has priority and must all fit, even if the hero is rendered smaller.
CRITICAL: every name and number printed on the image MUST be copied from the digest text at the END of this message. Never invent a value, and never reuse any example/placeholder value written in these instructions.

Community branding:
- Telegram group name: “Valorant NPC”
- Add “Valorant NPC” as the community name / branding on the story
- Place it subtly near the top, footer, or as a small badge
- Do not use official Valorant logos

Use the attached images:
1. Top agent reference — use this agent as the main hero visual.
2. Top map reference — use this map as the featured map/environment visual.

Visual style:
- Premium futuristic esports / cyberpunk / Valorant-inspired digest poster
- Dark background
- The main color palette MUST be derived from the attached top agent reference image
- Analyze the agent image and use its dominant and accent colors as the digest palette
- Use the agent’s main colors for glow, HUD borders, panels, highlights, numbers, dividers, and CTA accents
- Keep the palette cohesive with the agent, not random
- Background should stay dark and premium
- Neon accents are allowed, but they must match the agent’s colors
- Avoid introducing unrelated strong colors that are not present in the agent reference
- Avoid excessive yellow/orange warmth unless those colors are clearly part of the agent’s palette
- Do not over-warm the image
- HUD panels, glowing borders, tech UI elements, subtle grid, sharp esports layout
- Dynamic, polished, high-energy, but clean and readable
- The design should look like a professional Telegram story cover

Character:
- Use the attached top agent reference as the main hero character
- Preserve the recognizable vibe, pose energy, outfit colors, face feel, and ability/energy style
- Place the hero large on one side or partially in the background
- The hero must support the layout and not cover important text
- Do not create a random real person
- Do not use a real human face

Map:
- Use the attached top map reference as the featured map
- Integrate it as a framed map preview, background element, or cyber-HUD card
- Add a clear “Top map” block based on the digest data
- Slightly color-grade the map preview to harmonize with the agent-derived palette

Content logic:
Read the digest text at the end and render EVERY section it contains, verbatim from it (not just highlights):
- Digest date — the date after “Дайджест за неделю ·”
- ALL record / near-miss lines (the lines with emoji like 💀 🥩 🤕 ⚰️ 🤠 ⏳ 🏅 🍿 🔪 🔫 etc., or starting with “Был(а) близок к рекорду”) — each with its short label, the player nick, and the number. Every such line in the digest must appear, not only the strongest 2–4.
- Total matches — the number N in “мы сыграли N матчей”
- Weekly leaders — the “🏆 Больше всех матчей” line (player nick + match count), and any other similar leader lines present
- Top maps — every bullet under “🗺 Чаще всего играли на” (each map name + its ×count, in the digest’s order — not just the first)
- Top picks / agents — every bullet under “🎭 Чаще всего пикали” (each agent name + its ×count, in the digest’s order — not just the first)
The very first agent in “Чаще всего пикали” is the top agent of the week; the very first map in “Чаще всего играли на” is the top map. If a section is missing from the digest, omit it. Never fabricate or carry over names/numbers from anywhere else, including these instructions.

Text language:
Use Russian.

Required headline:
“ДАЙДЖЕСТ НЕДЕЛИ”

Required date:
Use the date from the digest.

Sections on the poster (include every one that the digest contains):
- Small “Valorant NPC” branding badge
- The digest date
- “Рекорды недели” — every record / near-miss line from the digest, each as a short row
- “За неделю сыграно: N матчей”
- “Лидеры недели” — the “Больше всех матчей” leader, and any other leader lines
- “Топ карты” — every map from “Чаще всего играли на”, with its ×count, in the digest’s order
- “Топ агенты” / “Лучшие пики” — every agent from “Чаще всего пикали”, with its ×count, in the digest’s order

Picks / agents section:
- Do NOT draw agent icons or portraits in this section
- Show every agent from the digest’s “Чаще всего пикали” list as a clean text chip / HUD tag, in the digest’s order
- Each chip = agent name + its pick count, formatted “<Имя> <N>×”
- This describes the FORMAT only — never print these instructions’ wording or any placeholder; use the real agents and counts from the digest
- Keep the section compact and readable

Layout:
- Vertical portrait poster using the full image (~2:3); keep safe margins on every side
- Big readable headline at the top with the digest date right under it
- Small “Valorant NPC” branding badge
- Hero character to one side as background art; shrink it if the digest content needs more space — content has priority over hero size
- Featured map as a small framed element, not dominant
- Records section: every record / near-miss row from the digest as one short row each (emoji or icon, player nick, number, brief label) — fit them all
- Leaders block: total matches number + “Больше всех матчей” leader (+ any other leader lines)
- Top maps block: each map name with its ×count, in digest order
- Top agents / picks block: each agent name with its ×count, in digest order, text-only chips
- Use a compact dashboard / multi-column grid if needed to fit everything; nothing must clip or run off any edge
- Keep type readable; if space is tight, shrink the hero further rather than the data text

Typography:
- Bold esports-style sans-serif headline
- Clean readable UI text
- Strong contrast between text and background
- Highlight numbers using colors sampled from the agent palette
- Keep player nicknames readable
- Use short text blocks only

Restrictions:
- Do not draw icons or portraits for best picked agents
- Do not use official Valorant logos
- Avoid warm yellow/orange lighting unless it exists in the agent reference
- Avoid muddy colors
- Avoid excessive bloom
- Avoid unreadable tiny text
- Avoid random human faces
- Avoid photorealistic people
- Avoid low contrast
- Avoid distorted UI text
- Never clip or run text off the top, bottom, or side edges — every block must sit fully inside the frame; if space is tight, shrink the hero (and the map element) rather than dropping data or letting text overflow
- Never show any agent name or number that is not in the digest below (no example or placeholder values)

Digest text:`;

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
 * Append the whole plain-text digest after the prompt's `Digest text:` line.
 * The digest comes in as HTML (the same string posted to Telegram with
 * parse_mode HTML); we strip the markup first.
 */
export function appendDigestText(digestText: string): string {
  return `${STORY_PROMPT}\n\n${stripHtml(digestText)}`;
}
