/**
 * member-gate.ts — the single place a member loses or regains the right to
 * write in the group.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * Read-only is applied from three unrelated triggers: a fresh join without a
 * nick, the daily sweep, and a pending nick that turned out not to exist. Each
 * used to restrict on its own, and only one of them ever told the person what
 * had happened — so a member could silently lose the ability to write with no
 * explanation anywhere. Observed live on 2026-08-29: a member admitted by
 * manual approval was muted instantly and had nothing to read about it, because
 * the welcome message deliberately omits the rule and the pinned messages were
 * removed.
 *
 * The fix is structural rather than three more `notify` calls: gating a member
 * is ONE operation — restrict, record, explain — and it is not possible to do
 * part of it, because there is only one function that does any of it.
 *
 * ── How someone ends up here ────────────────────────────────────────────────
 * The guard bot asks for a nick at the door, so most people never get gated.
 * But the door is not the only way in, and the other ways are ordinary, not
 * exotic:
 *   - the owner approves a pending join request by hand (the requester opened
 *     the Mini App and closed it without entering a nick);
 *   - a member or admin adds someone directly, which creates no join request
 *     at all.
 * Both arrive as a plain `chat_member` update. Treat entry path as irrelevant:
 * whoever is in the group without a nick gets gated and gets told why.
 */

import { eq } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/**
 * Permissions of a gated member: present in the chat, able to read, unable to
 * contribute anything.
 *
 * Lives here rather than in the cron that happened to need it first — these
 * describe the gate, and the cron is only one of its callers.
 */
export const READONLY_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
} as const;

export const FULL_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
} as const;

/**
 * The two permission sets the bot ever applies. Callers used to each declare
 * their own narrow signature (`typeof READONLY_PERMISSIONS` here, `typeof
 * FULL_PERMISSIONS` there), which made the same Telegram call incompatible with
 * itself depending on which module you asked. One contract, one type.
 */
export type ChatPermissions = typeof READONLY_PERMISSIONS | typeof FULL_PERMISSIONS;

export type RestrictChatMember = (
  chatId: number,
  userId: number,
  permissions: ChatPermissions,
) => Promise<void>;

/**
 * Why someone is being gated. Carries whatever the explanation needs, so the
 * copy can live in one place instead of at each call site.
 */
export type GateReason =
  | { kind: 'no_nick' }
  | { kind: 'nick_not_found'; riotName: string; riotTag: string };

export interface MemberGateDeps {
  db: AnyDb;
  /** Telegram Bot API: restrict a chat member. */
  restrictChatMember: RestrictChatMember;
  /**
   * Deliver a personal, chat-invisible explanation. Best-effort by contract:
   * it must never throw, and a failure must not undo the restriction.
   * Absent only in tests that exercise pure gating.
   */
  notify?: (args: { chatId: number; userId: number; html: string }) => Promise<unknown>;
  /** Public HTTPS base of the Mini App, used in the explanation. */
  getMiniAppUrl?: () => string;
  /** Injectable now timestamp in ms, defaults to Date.now(). */
  getNowMs?: () => number;
}

/** HTML-escape — same rules as publisher/templates.ts. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The explanation a gated member receives. One function, so the wording cannot
 * drift between the three triggers.
 */
export function gateNoticeHtml(reason: GateReason, appUrl: string): string {
  const cta = appUrl
    ? `<a href="${esc(appUrl)}">Открыть список участников</a> и ввести свой Riot ID — доступ откроется сразу.`
    : 'Открой список участников и введи свой Riot ID — доступ откроется сразу.';

  if (reason.kind === 'nick_not_found') {
    return (
      `Не получилось подтвердить твой Riot ID <b>${esc(reason.riotName)}#${esc(reason.riotTag)}</b> — Valorant такого не знает.\n` +
      `Скорее всего опечатка: легко перепутать латинскую <b>I</b> со строчной <b>l</b>, а букву <b>O</b> с нулём.\n` +
      `Писать в чат пока не получится. ${cta}`
    );
  }

  return (
    'Ты в чате, но писать пока не можешь — не указан игровой ник.\n' +
    'По нику в списке участников видно, кто есть кто в игре, ради этого всё и затевалось.\n' +
    cta
  );
}

export interface GateResult {
  /** Chats where the restriction actually landed. */
  restrictedIn: number[];
  /** Whether the person was told. False when every delivery path failed. */
  notified: boolean;
}

/**
 * Gate a member: restrict them everywhere we can, record it, and explain it.
 *
 * Returns without touching anything if the restriction failed in every chat —
 * there is nothing to record and nothing to explain. `restricted_at` is written
 * only after at least one chat accepted the restriction, so a failed gate is
 * retried by the next sweep rather than being silently marked done.
 *
 * The notice is sent once, not once per chat, and its failure is swallowed:
 * being unreachable must not leave someone un-gated.
 */
export async function gateMember(
  deps: MemberGateDeps,
  args: { chatIds: Iterable<number>; userId: number; reason: GateReason; source: string },
): Promise<GateResult> {
  const { userId, reason, source } = args;
  const getNowMs = deps.getNowMs ?? (() => Date.now());

  const restrictedIn: number[] = [];
  for (const chatId of args.chatIds) {
    try {
      await deps.restrictChatMember(chatId, userId, READONLY_PERMISSIONS);
      restrictedIn.push(chatId);
      logger.info(
        { module: 'member-gate', source, chat_id: chatId, telegram_id: userId, reason: reason.kind },
        'Member gated (read-only)',
      );
    } catch (err) {
      logger.warn(
        { module: 'member-gate', source, chat_id: chatId, telegram_id: userId, err },
        'restrictChatMember failed — not recording the gate for this chat',
      );
    }
  }

  if (restrictedIn.length === 0) {
    return { restrictedIn, notified: false };
  }

  await deps.db
    .update(users)
    .set({ restricted_at: getNowMs() })
    .where(eq(users.telegram_id, userId));

  let notified = false;
  if (deps.notify) {
    const appUrl = deps.getMiniAppUrl?.() ?? '';
    try {
      await deps.notify({
        chatId: restrictedIn[0]!,
        userId,
        html: gateNoticeHtml(reason, appUrl),
      });
      notified = true;
    } catch (err) {
      // notify is contractually best-effort; this catch is the belt to its
      // braces. A silent gate is bad, an un-gated member is worse.
      logger.warn(
        { module: 'member-gate', source, telegram_id: userId, err },
        'Gate notice failed — member is gated but uninformed',
      );
    }
  } else {
    logger.warn(
      { module: 'member-gate', source, telegram_id: userId },
      'No notify wired — member gated silently',
    );
  }

  return { restrictedIn, notified };
}

/**
 * The inverse: give the right to write back, once a nick is on file.
 *
 * Lives beside `gateMember` on purpose — the two are one concept, and splitting
 * them is how the gate drifted out of sync with its explanation in the first
 * place.
 *
 * `restricted_at` is cleared only when every chat succeeded; a partial success
 * leaves the row marked so the next onboard attempt retries the rest.
 */
export async function ungateMember(
  deps: MemberGateDeps,
  args: { chatIds: Iterable<number>; userId: number },
): Promise<{ fullyLifted: boolean }> {
  const { userId } = args;

  let anyFailed = false;
  for (const chatId of args.chatIds) {
    try {
      await deps.restrictChatMember(chatId, userId, FULL_PERMISSIONS);
    } catch (err) {
      logger.warn(
        { module: 'member-gate', chat_id: chatId, telegram_id: userId, err },
        'Failed to unrestrict user in chat — will retry on next onboard',
      );
      anyFailed = true;
    }
  }

  if (anyFailed) return { fullyLifted: false };

  await deps.db
    .update(users)
    .set({ restricted_at: null })
    .where(eq(users.telegram_id, userId));
  logger.info(
    { module: 'member-gate', telegram_id: userId },
    'Member ungated after onboard',
  );
  return { fullyLifted: true };
}
