# Prototype notes — weekly-digest image, two-phase prepare/publish flow

> Throwaway. See `prototype-flow.ts`. Run: `bun src/server/story/prototype-flow.ts`
> Relates to issue **#227** (Story/Business path blocked — no Premium).

## Question

Is the two-phase **prepare (Fri 18:45 Kyiv) / publish (Fri 19:00 Kyiv)** state
machine — single digest build at 18:45, image generated & PNG stashed, saved text
posted verbatim at 19:00 with the PNG as a photo reply — sound enough, across every
crash / restart / OpenAI-failure / missing-refs / double-tick path, to graft onto
the battle-tested `scheduled-digest.ts`? (User chose this over decoupled loops:
the image must exactly match the posted text.)

## What the run showed

All 10 scenarios behave as designed:

- weekIso of Fri 18:45 == Fri 19:00 → the prepare→publish handoff key is stable.
- Every image-failure path (OpenAI hard-fail, missing refs, sendPhoto throw, no
  `OPENAI_API_KEY`) still delivers the **digest text on time**; image is silently
  absent. Matches the user-locked fallback.
- Missed 18:45 tick → 19:00 falls back to a fresh build, text-only — digest never
  blocked.
- Double 18:45 = no-op (dedup on `prepared|published`); double 19:00 = no-op
  (dedup on `published`).
- `no_content` week recorded at 18:45 → 19:00 posts nothing (current behaviour).
- 8a (crash *during* the best-effort image step, status already `published`):
  re-run is a clean no-op — **no double text**. This is why the design flips
  `published` immediately after the text send, before the image (mirrors #255).

## The one residual the prototype flushed out — needs a product call

**Scenario 8b:** crash in the window *after* the text `sendMessage` succeeds but
*before* the `status=published` write. Outcome: the digest text **was delivered
exactly once**, but the row is stuck at `status=prepared`.

- Weekly cron fires **once per week** and Croner does **not** replay missed ticks,
  so in production this self-resolves: the digest is posted once, the row stays
  `prepared` until the next (different) `weekIso` — purely cosmetic.
- The only way 8b causes a **double text post** is a *manual* re-run of the publish
  tick in that same week while the row is still `prepared`.

Two ways forward:
1. **Accept it.** No code; document that a manual re-publish in the crash week can
   double-post. Simplest; matches "row only after successful send" spirit (#255).
2. **Harden:** write a pre-send `publishing` intent marker before `sendMessage`; on
   restart, a row in `publishing` means "text may already be out — do not re-send,
   require manual confirm." One extra status + one extra write.

## VERDICT

**Validated — proceed.** The two-phase prepare(18:45)/publish(19:00) state machine
is sound for grafting onto `scheduled-digest.ts`.

8b decision (user, 2026-05-19): **accept as-is, no hardening.** Weekly cron fires
once and Croner does not replay missed ticks, so the stuck-`prepared` row
self-resolves in production (text posted exactly once). The only double-post path
is a *manual* re-run of publish in the crash week — accepted as a known, documented
edge. No `publishing` intent marker. This keeps the spirit of #255 ("row reflects
posted state, written right after the send").

Next: delete `prototype-flow.ts`, fold this validated design into a rewritten
**#227** (drop Story/Business/`postStory`; add reply-photo + two-phase prepare loop
+ `/test_digest_image`) for AFK dispatch.
