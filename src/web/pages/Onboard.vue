<template>
  <div class="onboard-pending">
    <span class="badge">
      <span class="badge-dot" aria-hidden="true"></span>
      Closed alpha
    </span>

    <h1>Riot Sign-On is on the way</h1>

    <p class="hint">
      Account linking via Riot Sign-On is being reviewed by Riot Games.
      Until that lands, the bot is in coordination-only mode &mdash;
      no match data, no notifications, no rank display.
    </p>

    <p class="hint">
      Once approved, you'll see a <strong>Login with Riot</strong> button
      here. One tap, one-time authorization, no password sharing.
    </p>

    <a href="/about" class="link">Learn more about the bot</a>
  </div>
</template>

<script setup lang="ts">
// Onboarding via Riot Sign-On (RSO) is gated on Riot Production approval
// (issue #40) and RSO Client provisioning (issue #44). The previous
// Henrik trust-based form is intentionally removed (issue #41) — Henrik
// has zero coverage for console accounts, so the form never worked for
// our community.
//
// When the RSO scaffold (issue #43) ships, this page becomes a real
// "Login with Riot" CTA wired to /auth/riot/start.
</script>

<style scoped>
.onboard-pending {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 18px;
  padding: clamp(48px, 12vw, 96px) 22px;
  max-width: 520px;
  margin: 0 auto;
  color: var(--fg, #f1f1f7);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
  letter-spacing: -0.01em;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(255, 255, 255, 0.10);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  padding: 6px 12px;
  border-radius: 999px;
}

.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5be3a4;
  box-shadow: 0 0 8px #5be3a4;
}

h1 {
  font-size: clamp(24px, 4.5vw, 32px);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  background: linear-gradient(135deg, #f1f1f7 0%, #c8c9e0 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.hint {
  font-size: 15px;
  line-height: 1.55;
  color: rgba(255, 255, 255, 0.65);
  margin: 0;
}

.hint strong {
  color: #f1f1f7;
  font-weight: 500;
}

.link {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  color: #7383ff;
  text-decoration: none;
  transition: color 0.15s ease;
}

.link:hover {
  color: #b15eff;
}
</style>
