# Copilot Quota Monitor for VS Code

A small VS Code extension that shows GitHub Copilot quota information in the status bar using the official GitHub Copilot SDK.

## What it shows

- Remaining percentage
- Used requests
- Total entitlement
- Remaining requests
- Reset date
- Quota type returned by Copilot

The default quota is displayed as **Premium model**. Its SDK quota key is `premium_interactions`.

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

Repeated refreshes do not repeat a warning. If usage jumps across several thresholds, only the highest is shown. Warning history is kept in memory for the current extension session, separately by VS Code account, host, quota type, and reset date. Reloading VS Code clears it. A new reset date rearms warnings; when no reset date is provided, usage must return to zero to rearm them. CLI-only authentication shares one warning history per host and quota because no VS Code account identity is available.

Unlimited and zero-allowance quotas do not trigger usage warnings. The status bar uses a warning background at 50% used and a critical background at 90% used; unlimited quotas have no warning color.

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
code --install-extension .\copilot-quota-monitor-0.1.0.vsix
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
  "copilotQuota.showResetDate": true
}
```

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
