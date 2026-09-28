# Copilot Quota Monitor for VS Code

A small VS Code extension that shows GitHub Copilot quota information in the status bar using the official GitHub Copilot SDK.

## What it shows

- Remaining percentage
- Used requests
- Total entitlement
- Remaining requests
- Reset date
- Quota type returned by Copilot

The default quota is `premium_interactions`.

## Requirements

- VS Code 1.90+
- Node.js 20.19+ or Node.js 22.12+ for the current Copilot SDK
- A GitHub Copilot subscription/account supported by the Copilot SDK
- Copilot CLI authentication available to the SDK

The current GitHub Copilot SDK documentation says the Node.js SDK requires Node.js `^20.19.0` or `>=22.12.0`, and the SDK bundles the Copilot CLI runtime. See the GitHub documentation for authentication details.

## Install from source

```bash
npm install
npm run compile
code --extensionDevelopmentPath="$(pwd)"
```

On Windows PowerShell:

```powershell
npm install
npm run compile
code --extensionDevelopmentPath="$PWD"
```

Or open the folder in VS Code and press `F5`.

## Package a VSIX

```bash
npm install
npm run package
```

This produces a `.vsix` file. Install it from VS Code with **Extensions → … → Install from VSIX…**.

## Authentication

The extension does not ask for or store a GitHub token itself. The Copilot SDK uses its supported authentication mechanisms. If the SDK reports that you are not authenticated, authenticate Copilot CLI according to GitHub's current Copilot SDK documentation, then run **Copilot Quota: Refresh**.

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
