# Copilot Quota Monitor v0.2.0

Track your GitHub Copilot allowance directly in the VS Code status bar, now with burn-rate projections, cost estimates and spike alerts.

## What's new

- **Burn rate everywhere** — the hover tooltip and the details dialog show *Daily average*, *Runs out* (when the allowance is exhausted and whether that is before the reset), *Estimated usage until reset* and *Projected remaining at reset*.
- **Cost estimates** — every request figure carries an approximate USD value based on `copilotQuota.costPerRequestUsd` (default $0.01 per AI credit). When the projected month exceeds the allowance, the overage is shown as "about $X over budget".
- **Usage spike warning** — a real-time alert when more than `copilotQuota.spikeHourlyPercent` (default 1 %) of the monthly allowance is consumed within an hour, with **View Usage**, **Dismiss** and **Disable Warning** actions. Muted for an hour after showing.
- **Run-out notice** — "At your current usage rate, your quota may run out before reset" appears in the tooltip and dialog only when the projection actually crosses the reset date.
- **Persistent usage history** — the used counter is sampled on each refresh and kept for 30 days in VS Code global state, per account and quota, so measured rates survive reloads.

## Fixes

- Burn rate was hidden whenever the API reset date was missing or already past.
- *Projected remaining* ignored requests already used and over-reported the remaining allowance.
- A drifting reset date reset the usage history and re-armed threshold warnings on every refresh. New cycles are now detected from the used counter dropping.
- *Runs out* could show a date after the reset while the warning said the quota would run out before it.

## New settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `copilotQuota.cycleResetDay` | `1` | Day of month (UTC) the allowance resets, used when the API has no future reset date. `0` disables projections in that case. |
| `copilotQuota.costPerRequestUsd` | `0.01` | USD per quota unit for cost estimates. Use `0.04` for legacy request-based plans, `0` to hide. |
| `copilotQuota.spikeHourlyPercent` | `1` | Spike threshold as a percentage of the monthly allowance per hour. `0` disables. |

## Installation

1. Download `copilot-quota-monitor-0.2.0.vsix` from this release's Assets section.
2. In VS Code, open Extensions and choose **Install from VSIX...** from the menu.
3. Select the downloaded package and reload VS Code if prompted.
4. Run **Copilot Quota: Sign In** and authorize the GitHub account with your Copilot subscription.

## Requirements

- Windows x64 for the attached build, which bundles the Windows x64 Copilot runtime.
- VS Code 1.134 or later.
- A Node.js runtime compatible with the SDK: `^20.19.0` or `>=22.12.0`.
- A GitHub Copilot account supported by the SDK.

## Notes

Projections are estimates derived from the account's aggregate quota snapshot; per-model token costs are not exposed by the API. Model suggestions are general guidance, make no AI calls, and do not switch models automatically. Model availability and pricing vary by plan and organization.

Background refreshes do not open sign-in prompts. Threshold-warning history resets when VS Code reloads; usage samples persist.

## Previous releases

### v0.1.2

- Burn-rate context in usage details when a reset date is available.
- Theme-aware Model Suggestions tab with task-based recommendations and a pricing link.
- Sign-in through VS Code GitHub authentication with SDK/CLI fallback.
- GitHub Enterprise Cloud data-residency support via `github-enterprise.uri`.
- Improved retry handling and recovery from failed SDK startup.