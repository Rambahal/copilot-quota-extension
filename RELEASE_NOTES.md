# Copilot Quota Monitor v0.1.0

Track your GitHub Copilot allowance directly in the VS Code status bar.

## Highlights

- View remaining quota, used requests, allowance, and reset date.
- Receive usage warnings at 50%, 75%, and 90% used without repeated alerts on every refresh.
- Open a theme-aware Model Suggestions tab with task-based recommendations and a link to current pricing.
- Sign in through VS Code's GitHub authentication, with SDK/CLI authentication available as a fallback.
- Support GitHub Enterprise Cloud with data residency through the `github-enterprise.uri` setting.
- Refresh automatically or on demand, with improved retry handling and recovery from failed SDK startup.

## Installation

1. Download `copilot-quota-monitor-0.1.0.vsix` from this release's Assets section.
2. In VS Code, open Extensions and choose **Install from VSIX...** from the menu.
3. Select the downloaded package and reload VS Code if prompted.
4. Run **Copilot Quota: Sign In** and authorize the GitHub account with your Copilot subscription.

## Requirements

- Windows x64 for the attached build, which bundles the Windows x64 Copilot runtime.
- VS Code 1.134 or later.
- A Node.js runtime compatible with the SDK: `^20.19.0` or `>=22.12.0`.
- A GitHub Copilot account supported by the SDK.

## Notes

Quota availability and reset dates depend on the account and SDK response. Model suggestions are general guidance, make no AI calls, and do not switch models automatically. Model availability and pricing vary by plan and organization.

Background refreshes do not open sign-in prompts. Usage-warning history resets when VS Code reloads.