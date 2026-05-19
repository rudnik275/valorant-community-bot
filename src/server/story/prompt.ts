/**
 * prompt.ts — the STORY_PROMPT for the weekly promo image (#227).
 *
 * The user's full rich prompt with three targeted fixes the user asked for
 * after reviewing output: (1) data-binding — every name/number must be read
 * from the appended digest (the old literal example "Miks 24×"… was being
 * copied instead of the real top agent); (2) aspect — model canvas is ~2:3,
 * so all "9:16" wording was replaced with full-frame ~2:3 to stop the model
 * overflowing the bottom; (3) an explicit no-clip rule. Keep the rich layout;
 * only adjust wording for these three concerns.
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
Turn the provided weekly digest text into a stylish teaser poster for a Telegram gaming community.
This is NOT the full digest. Do not place the entire digest text on the image.
Analyze the digest yourself and choose only the strongest highlights for a short, readable promo.
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
Read the digest text at the end and extract ONLY these, verbatim from it:
- Digest date — the date written after “Дайджест за неделю ·”
- Total matches — the number N in “мы сыграли N матчей”
- Top map — the FIRST bullet under “Чаще всего играли на” (its name and its ×count)
- Top agent / most picked agent — the FIRST bullet under “Чаще всего пикали” (its name and its ×count). Use whatever the digest lists first there; do NOT assume any specific agent.
- Best picks — the bullets under “Чаще всего пикали” (top 2–4), each as agent name + its ×count
- Records — 2–4 of the strongest record / “близок к рекорду” lines (number + short label)
If a value is not present in the digest, omit that block. Never fabricate or carry over names/numbers from anywhere else, including these instructions.

Text language:
Use Russian.

Required headline:
“ДАЙДЖЕСТ НЕДЕЛИ”

Required date:
Use the date from the digest.

Recommended blocks:
- “Valorant NPC”
- “матчей за неделю”
- “Топ карта”
- “Топ агент недели”
- “Лучшие пики”
- “Рекорды недели”
- Bottom CTA: “Главные рекорды, лидеры и статистика — в полном дайджесте”

Best picks section:
- Do NOT draw agent icons or portraits in the “Лучшие пики” section
- Show best picks only as clean text chips / HUD tags
- Each chip = an agent name + its pick count taken from the digest’s “Чаще всего пикали” list, formatted “<Имя> <N>×”
- This describes the FORMAT only — never print these instructions’ wording or any placeholder; use the real agents and counts from the digest
- Keep this section compact and readable

Layout:
- Vertical portrait poster using the full image (~2:3); keep safe margins on every side
- Big readable headline at the top
- Add small community branding: “Valorant NPC”
- Hero character on one side
- Featured map card near the upper/middle area
- Main stats in compact cards
- Best picks section must use text-only HUD chips, no character icons
- Records section with 3–4 short rows
- CTA strip at the bottom
- Keep enough spacing
- Do not make the poster overcrowded
- Avoid tiny unreadable text

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
- Avoid cluttered layout
- Avoid full digest copy-paste
- Avoid random human faces
- Avoid photorealistic people
- Avoid low contrast
- Avoid distorted UI text
- Avoid placing too much text on the image
- Never clip or run text off the top, bottom, or side edges — the bottom CTA must sit fully inside the frame; if space is tight, shrink the hero and drop the least important block instead of overflowing
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
