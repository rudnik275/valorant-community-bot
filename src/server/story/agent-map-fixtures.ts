/**
 * agent-map-fixtures.ts — resolve a digest agent/map *name* to a reference
 * PNG path on disk for the weekly promo image (#227).
 *
 * The PNGs are placed manually by the operator (see issue #227 prerequisites
 * + `src/assets/README.md`):
 *   - `src/assets/agents/<slug>.png` — agent card from playvalorant.com
 *   - `src/assets/maps/<slug>.png`   — map preview from playvalorant.com
 *
 * `buildDigest()` returns the agent/map *display name* as Henrik reports it
 * (e.g. "KAY/O", "Killjoy", "Ascent"). We normalise that to a lowercase slug
 * and check the file exists. A missing file (new agent/map the operator has
 * not added yet) returns `null` — the prepare tick treats null as
 * "skip the image, post text-only" and warns with the name. We never throw
 * and never fabricate a file.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Repo-relative assets root. Resolved against process.cwd() at call time. */
const ASSETS_ROOT = join(process.cwd(), 'src', 'assets');
const AGENTS_DIR = join(ASSETS_ROOT, 'agents');
const MAPS_DIR = join(ASSETS_ROOT, 'maps');

/**
 * Normalise a Henrik agent/map display name to a filename slug.
 *
 * Henrik names carry punctuation/spacing the filesystem slugs do not:
 *   "KAY/O"  → "kayo"
 *   "Killjoy" → "killjoy"
 *   "Ascent" → "ascent"
 *
 * Rule: lowercase, drop everything that is not [a-z0-9]. This collapses
 * slashes, spaces, apostrophes, accents-as-ascii etc. into the canonical
 * slug the operator checklist in issue #227 §11 uses.
 */
export function normalizeSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    // strip combining marks (accents) so e.g. "é" → "e"
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve the reference PNG path for an agent display name.
 * Returns `null` if `name` is empty/null or no matching file exists.
 */
export function resolveAgentImage(name: string | null | undefined): string | null {
  if (!name) return null;
  const slug = normalizeSlug(name);
  if (!slug) return null;
  const path = join(AGENTS_DIR, `${slug}.png`);
  return existsSync(path) ? path : null;
}

/**
 * Resolve the reference PNG path for a map display name.
 * Returns `null` if `name` is empty/null or no matching file exists.
 */
export function resolveMapImage(name: string | null | undefined): string | null {
  if (!name) return null;
  const slug = normalizeSlug(name);
  if (!slug) return null;
  const path = join(MAPS_DIR, `${slug}.png`);
  return existsSync(path) ? path : null;
}
