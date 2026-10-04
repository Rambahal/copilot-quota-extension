# Copilot Quota Monitor for VS Code

A small VS Code extension that shows GitHub Copilot quota information in the status bar using the official GitHub Copilot SDK.

## What it shows

- Remaining percentage
- Used requests
- Total entitlement
- Remaining requests
- Reset date
- Quota type returned by Copilot
- Burn rate: daily average, when the allowance runs out, projected usage and cost until reset
- Warnings at 50 / 75 / 90 % used and when usage spikes

The default quota is displayed as **Premium model**. Its SDK quota key is `premium_interactions`.

## UI preview

Illustrative values for a 1,000-request allowance, 12 days into the cycle. The real UI uses VS Code's native status bar, hover and dialog styling.

**Status bar item**

> `$(github) Copilot: 58% left`

**Hover tooltip**

> **GitHub Copilot quota**
>
> Quota: Premium model
>
> **Used:** 420 / 1,000 (≈ $4.20)
>
> **Remaining:** 580 requests (58%) (≈ $5.80)
>
> **Daily average:** 35 requests (≈ $0.35)
>
> **Runs out:** in about 17 days (Oct 27, 2026, 9:00 AM), before the reset
>
> **Estimated usage until reset:** 630 (≈ $6.30) — about $0.50 over budget
>
> **Projected remaining at reset:** ░░░░░░░░░░░░░░░░░░░░ 0%
>
> ⚠ At your current usage rate, your quota may run out before reset.
>
> **Resets:** Nov 1, 2026, 12:00 AM
>
> Click to view details or use **Copilot Quota: Refresh**.

**Details dialog** (click the status bar item)

> **Copilot Usage: Premium model**
>
> Usage: 42% used | 58% remaining
>
> Used: 420 requests (≈ $4.20)
>
> Allowance: 1,000 requests (≈ $10.00)
>
> Remaining: 580 requests (≈ $5.80)
>
> Daily average: 35 requests (≈ $0.35)
>
> Runs out: in about 17 days (Oct 27, 2026, 9:00 AM), before the reset
>
> Estimated usage until reset: 630 (≈ $6.30) — about $0.50 over budget
>
> Projected remaining at reset: ░░░░░░░░░░░░░░░░░░░░ 0%
>
> ⚠ At your current usage rate, your quota may run out before reset.
>
> Resets: Nov 1, 2026, 12:00 AM
>
> `[ Refresh ]` `[ Model Suggestions ]` `[ Cancel ]`

When usage is on track, the lines read instead:

> Runs out: not before the reset at this rate
>
> Estimated usage until reset: 360 (≈ $3.60)
>
> Projected remaining at reset: ████░░░░░░░░░░░░░░░░ 22%

**Threshold warning** (50 / 75 / 90 % used)

> ⚠ Copilot: 75% of your Premium model allowance is used (75% warning). For docs, explanations, or small tests, consider GPT-5 mini if available at lower cost or a lower usage multiplier than your current model. Estimated burn rate is 35 requests/day, with projected remaining of 0%.
>
> `[ View Usage ]` `[ Model Suggestions ]`

**Usage spike warning**

> ⚠ Your current usage rate is unusually high: 30 requests in the last 30 minutes is about 43x the pace your allowance supports. You've used 9% of your monthly quota in the last 2 days.
>
> `[ View Usage ]` `[ Dismiss ]` `[ Disable Warning ]`

## Usage warnings and details

Warnings appear in VS code status bar when the selected quota reaches **50%, 75%, and 90% used**, based on the SDK's remaining percentage. They suggest GPT-5 mini for docs, explanations, and small tests when it is available at a lower cost or usage multiplier than your current model; the extension does not switch models automatically. Use **View Usage** in a warning or click the status bar to open a native VS Code dialog with usage, allowance, remaining requests, reset date, and a Refresh action.

Choose **Model Suggestions** from a warning or the usage dialog for task-based guidance:

| Use case | Suggested starting point | Reason |
| --- | --- | --- |
| Documentation, explanations, small functions, focused tests | GPT-5 mini | Budget option for well-scoped everyday coding and writing. |
| Quick fixes, repetitive edits, lightweight coding questions | Claude Haiku 4.5 | Fast alternative when you prefer Claude; not necessarily cheaper than mini models. |
| Codebase exploration and locating implementations | GPT-5.4 mini | Suited to search-driven agent work before deeper analysis. |
| Complex debugging or architecture | Focus the reproduction first; escalate when needed | Repeated failures with a cheaper model can cost more than a successful stronger-model attempt. |

These are general recommendations, not automatic analysis of your chat or a live ranking of models available to your account. They make no AI calls. Availability depends on your plan and organization; total cost depends on tokens, caching, retries, and your billing model. Check **Model Pricing** in the suggestions dialog before switching. Guidance is based on GitHub's [model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison) and [pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), reviewed September 30, 2026. Names and prices can change.

Repeated refreshes do not repeat a warning. If usage jumps across several thresholds, only the highest is shown. Warning history is kept in memory for the current extension session, separately by VS Code account, host and quota type. Reloading VS Code clears it. Warnings re-arm when a new billing cycle is detected (the used counter drops) or usage returns to zero. CLI-only authentication shares one warning history per host and quota because no VS Code account identity is available.

A separate **usage spike** warning fires when more than `copilotQuota.spikeHourlyPercent` of the monthly allowance is consumed within one hour (needs at least 20 minutes of recorded history). It is muted for an hour after showing and offers **Dismiss** and **Disable Warning** actions.

Unlimited and zero-allowance quotas do not trigger usage warnings. The status bar uses a warning background at 50% used and a critical background at 90% used; unlimited quotas have no warning color.

## Burn rate and projections

Each refresh records the used counter locally (VS Code global state, 30 days, per account and quota). From this and the billing cycle the extension derives:

- **Daily average** — requests per day so far this cycle (or measured from recorded samples when the cycle start is unknown).
- **Runs out** — when the remaining allowance is exhausted at that rate, and whether that is before the reset.
- **Estimated usage until reset** — additional requests expected before the reset, with the overage cost if the month's total exceeds the allowance.
- **Projected remaining at reset** — share of the allowance expected to be left when the cycle resets.

On token-based (AI Credits) billing the SDK's `resetDate` is the snapshot time, not a cycle boundary, so the cycle is anchored on `copilotQuota.cycleResetDay` instead. A genuine future reset date from the API is always preferred when present.

## Requirements

- VS Code 1.134+
- Node.js 20.19+ or Node.js 22.12+ for the current Copilot SDK
- A GitHub Copilot subscription/account supported by the Copilot SDK
- GitHub authentication authorized for this extension in VS Code, or Copilot CLI authentication available to the SDK

The current GitHub Copilot SDK documentation says the Node.js SDK requires Node.js `^20.19.0` or `>=22.12.0`, and the SDK bundles the Copilot CLI runtime. See the GitHub documentation for authentication details.

## Install

Download the VSIX from the [GitHub Releases](https://github.com/Rambahal/copilot-quota-extension/releases) page, then install it in VS Code using **Extensions → … → Install from VSIX…**. Once installed, the quota monitor appears in the status bar.

Alternatively, run this command from the folder containing the downloaded VSIX, with the VS Code `code` command available on your PATH:

```powershell
code --install-extension .\copilot-quota-monitor-0.2.0.vsix
```

## Authentication

Run **Copilot Quota: Sign In** from the Command Palette and authorize access to the GitHub account that has your Copilot subscription. The extension passes the VS Code-managed GitHub token to the SDK in memory; it does not persist or log the token. Signing into the GitHub Copilot extension alone does not automatically authorize this extension or sign in the SDK's CLI runtime.

For a GitHub Enterprise Cloud with data residency, open **Preferences: Open User Settings (JSON)** from the Command Palette and configure VS Code's GitHub Enterprise authentication provider. Replace the example URL below with your organization's actual URL:

```json
{
        "github-enterprise.uri": "https://yourcompany.ghe.com"
}
```

Then run **Copilot Quota: Sign In** and authorize the Enterprise account. The extension uses VS Code's `github-enterprise` authentication session and passes the configured host to the Copilot runtime.

You can also edit this setting in the Settings UI by searching for `@id:github-enterprise.uri`. No environment variable needs to be set manually: the extension forwards this URL internally through `COPILOT_GH_HOST`. Changes to the URL refresh the connection automatically. Remove the setting to use GitHub.com. This shared VS Code setting also affects other extensions using the GitHub Enterprise authentication provider.

Background refreshes never open sign-in prompts. They reuse an authorized VS Code GitHub session when available, otherwise they fall back to the SDK's CLI/environment authentication. You can still authenticate Copilot CLI separately and run **Copilot Quota: Refresh**. If authentication fails, click the status bar and choose **Sign In**, or use the sign-in command directly.

## Settings

```json
{
  "copilotQuota.refreshIntervalMinutes": 5,
  "copilotQuota.quotaType": "premium_interactions",
  "copilotQuota.showResetDate": true,
  "copilotQuota.cycleResetDay": 1,
  "copilotQuota.costPerRequestUsd": 0.01,
  "copilotQuota.spikeHourlyPercent": 1
}
```

- `cycleResetDay` — day of month (00:00 UTC) the allowance resets. Used when the API does not report a future reset date (token-based billing returns the snapshot time instead). GitHub AI Credits reset on the 1st. `0` disables projections in that case.
- `costPerRequestUsd` — USD per quota unit for the cost estimates. AI Credits are $0.01; legacy request-based plans charge $0.04 per additional premium request. `0` hides cost estimates.
- `spikeHourlyPercent` — warn when more than this percentage of the monthly allowance is consumed within one hour. `0` disables spike warnings (the warning's **Disable Warning** button sets this).

If your account/runtime exposes another quota key, the extension automatically falls back to the first available quota when the configured key is missing.

## Architecture

```text
VS Code Extension Host
        |
        v
@github/copilot-sdk
        |
        | JSON-RPC
        v
GitHub Copilot CLI runtime
        |
        v
account.getQuota()
        |
        v
status bar + details
```

## Important terminology

Copilot's current billing/usage model is not simply a monthly number of raw model tokens. `account.getQuota()` reports account entitlement/quota snapshots, including request allowance, used requests, remaining percentage, and reset date. Session-level APIs separately expose input/output token counts for SDK sessions.
