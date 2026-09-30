import * as vscode from 'vscode';
import type { CopilotClient } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };

type QuotaSnapshot = {
    entitlementRequests: number;
    usedRequests: number;
    remainingPercentage: number;
    resetDate?: string | null;
};

type QuotaResult = {
    quotaSnapshots?: Record<string, QuotaSnapshot>;
};

let client: CopilotClient | undefined;
let clientToken: string | undefined;
let clientHost: string | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let modelSuggestionsPanel: vscode.WebviewPanel | undefined;
let lastSnapshot: QuotaSnapshot | undefined;
let lastQuotaType = 'premium_interactions';
let loading = false;
let quotaAccount = 'cli';
const warnedThresholds = new Map<string, number>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel('Copilot Quota');
    context.subscriptions.push(outputChannel);
    log('Extension activated.');

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'copilotQuota.showDetails';
    statusBar.tooltip = 'GitHub Copilot quota';
    statusBar.text = '$(sync~spin) Copilot: loading…';
    statusBar.show();
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotQuota.refresh', () => refresh(true)),
        vscode.commands.registerCommand('copilotQuota.signIn', () => refresh(true, true)),
        vscode.commands.registerCommand('copilotQuota.showDetails', showDetails),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('copilotQuota')) {
                configureRefreshTimer();
                void refresh(false);
            } else if (event.affectsConfiguration('github-enterprise.uri')) {
                void refresh(false);
            }
        })
    );

    configureRefreshTimer();
    await refresh(false);
}

export async function deactivate(): Promise<void> {
    modelSuggestionsPanel?.dispose();
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }

    if (client) {
        try {
            await client.stop();
        } catch {
            // Best-effort shutdown.
        }
        client = undefined;
    }
}

function configureRefreshTimer(): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }

    const minutes = vscode.workspace
        .getConfiguration('copilotQuota')
        .get<number>('refreshIntervalMinutes', 5);

    refreshTimer = setInterval(() => void refresh(false), minutes * 60_000);
}

async function getClient(signIn: boolean): Promise<CopilotClient> {
    const enterpriseHost = vscode.workspace
        .getConfiguration('github-enterprise')
        .get<string>('uri');
    const authProvider = enterpriseHost ? 'github-enterprise' : 'github';
    const session = await vscode.authentication.getSession(authProvider, ['read:user'],
        signIn
            ? { createIfNone: true, clearSessionPreference: true }
            : { silent: true });
    const token = session?.accessToken;
    quotaAccount = JSON.stringify([enterpriseHost ?? 'github.com', session?.account?.id ?? 'cli']);

    if (client && clientToken === token && clientHost === enterpriseHost) {
        log('Reusing Copilot SDK client.');
        return client;
    }

    if (client) {
        const previousClient = client;
        client = undefined;
        clientToken = undefined;
        await previousClient.stop();
    }

    log('Creating and starting Copilot SDK client.');
    const { CopilotClient } = await import('@github/copilot-sdk');
    const runtimeOptions = enterpriseHost
        ? { env: { ...process.env, COPILOT_GH_HOST: enterpriseHost } }
        : {};
    const newClient = new CopilotClient(token
        ? { ...runtimeOptions, gitHubToken: token, useLoggedInUser: false }
        : runtimeOptions);

    try {
        await newClient.start();
        const auth = await newClient.getAuthStatus();
        if (!auth.isAuthenticated) {
            throw new Error('Copilot SDK is not authenticated. Run Copilot Quota: Sign In, or authenticate Copilot CLI and refresh.');
        }
        client = newClient;
        clientToken = token;
        clientHost = enterpriseHost;
        log(`Copilot SDK client authenticated using ${token ? 'VS Code GitHub authentication' : 'SDK/CLI authentication'}.`);
        return newClient;
    } catch (error) {
        await newClient.stop().catch(() => undefined);
        throw error;
    }
}

async function getQuota(signIn: boolean): Promise<{ type: string; snapshot: QuotaSnapshot }> {
    const configuredType = vscode.workspace
        .getConfiguration('copilotQuota')
        .get<string>('quotaType', 'premium_interactions');
    log(`Requesting quota. Configured quota type: ${configuredType}`);

    const copilot = await getClient(signIn);
    const result = await copilot.rpc.account.getQuota({}) as QuotaResult;
    const snapshots = result.quotaSnapshots ?? {};
    log(`Quota response keys: ${Object.keys(snapshots).join(', ') || '(none)'}`);
    log(`Quota response: ${safeJson(result)}`);

    let quotaType = configuredType;
    let snapshot = snapshots[quotaType];

    // Gracefully fall back if a plan/runtime exposes a different set of quota keys.
    if (!snapshot) {
        const first = Object.entries(snapshots).find(([, value]) => value != null);
        if (first) {
            quotaType = first[0];
            snapshot = first[1];
        }
    }

    if (!snapshot) {
        const available = Object.keys(snapshots);
        log(`Configured quota type '${configuredType}' was not selected. Available quotas: ${available.join(', ') || '(none)'}`);
        throw new Error(
            available.length
                ? `Quota '${configuredType}' was not returned. Available quotas: ${available.join(', ')}`
                : 'No Copilot quota information was returned for this account.'
        );
    }

    log(`Selected quota '${quotaType}': ${safeJson(snapshot)}`);
    return { type: quotaType, snapshot };
}

async function refresh(showErrors: boolean, signIn = false): Promise<void> {
    if (loading) {
        return;
    }

    loading = true;
    setStatusLoading();
    let retryAction: string | undefined;

    try {
        const { type, snapshot } = await getQuota(signIn);
        log(`Updating status bar from quota '${type}' with remainingPercentage=${String(snapshot.remainingPercentage)}, usedRequests=${String(snapshot.usedRequests)}, entitlementRequests=${String(snapshot.entitlementRequests)}.`);
        lastQuotaType = type;
        lastSnapshot = snapshot;
        updateStatusBar(type, snapshot);
        warnAboutUsage(type, snapshot);
    } catch (error) {
        const failedClient = client;
        client = undefined;
        clientToken = undefined;
        await failedClient?.stop().catch(() => undefined);
        lastSnapshot = undefined;
        const message = error instanceof Error ? error.message : String(error);
        log(`Quota refresh failed: ${message}`);
        if (error instanceof Error && error.stack) {
            log(error.stack);
        }
        setStatusError(message);

        if (showErrors) {
            retryAction = await vscode.window.showErrorMessage(
                `Copilot quota could not be read: ${message}`,
                'Sign In',
                'Retry'
            );
        }
    } finally {
        loading = false;
    }

    if (retryAction === 'Retry' || retryAction === 'Sign In') {
        await refresh(false, retryAction === 'Sign In');
    }
}

function warnAboutUsage(type: string, snapshot: QuotaSnapshot): void {
    if (snapshot.entitlementRequests <= 0 || !Number.isFinite(snapshot.remainingPercentage)) return;

    const used = 100 - Math.max(0, Math.min(100, snapshot.remainingPercentage));
    const key = JSON.stringify([quotaAccount, type, snapshot.resetDate ?? null]);
    if (!snapshot.resetDate && used === 0) {
        warnedThresholds.delete(key);
    }
    const threshold = [90, 75, 50].find(value => used >= value);
    if (threshold === undefined || threshold <= (warnedThresholds.get(key) ?? 0)) return;

    warnedThresholds.set(key, threshold);
    void vscode.window.showWarningMessage(
        `Copilot: ${formatPercent(used)}% of your ${formatQuotaType(type)} allowance is used (${threshold}% warning). For docs, explanations, or small tests, consider GPT-5 mini if available at lower cost or a lower usage multiplier than your current model.`,
        'View Usage',
        'Model Suggestions'
    ).then(choice => {
        if (choice === 'View Usage') return showDetails();
        if (choice === 'Model Suggestions') return showModelSuggestions();
    }).then(undefined, error => log(`Unable to show usage warning: ${String(error)}`));
}

async function showModelSuggestions(): Promise<void> {
    if (modelSuggestionsPanel) {
        modelSuggestionsPanel.reveal();
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'copilotQuota.modelSuggestions',
        'Model Suggestions',
        vscode.ViewColumn.Active,
        { enableScripts: false, localResourceRoots: [] }
    );
    modelSuggestionsPanel = panel;
    panel.onDidDispose(() => { modelSuggestionsPanel = undefined; });
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <title>Lower-Cost Models by Task</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: 14px;
            line-height: 1.6;
            letter-spacing: 0;
        }
        main { max-width: 860px; margin: 0 auto; padding: 32px 28px; }
        header { padding-bottom: 24px; }
        h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.3; font-weight: 600; }
        h2 { margin: 0 0 6px; font-size: 16px; line-height: 1.4; font-weight: 600; }
        p { margin: 0; }
        a { color: var(--vscode-textLink-foreground); text-underline-offset: 3px; }
        a:hover { color: var(--vscode-textLink-activeForeground); }
        a:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 4px; }
        .intro { margin-bottom: 12px; color: var(--vscode-descriptionForeground); }
        .recommendation {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
            gap: 24px;
            padding: 22px 0;
            border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
        }
        .task-detail { color: var(--vscode-descriptionForeground); }
        .model { font-size: 18px; font-weight: 600; margin-bottom: 6px; line-height: 1.4; }
        .note { margin-top: 8px; color: var(--vscode-descriptionForeground); }
        .guidance {
            margin-top: 8px;
            padding: 18px 20px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            background: var(--vscode-textBlockQuote-background);
        }
        ul { margin: 8px 0 0; padding-left: 20px; }
        li + li { margin-top: 6px; }
        footer { margin-top: 24px; color: var(--vscode-descriptionForeground); font-size: 13px; }
        footer p + p { margin-top: 8px; }
        h1, h2, p, a, li { overflow-wrap: anywhere; }
        @media (max-width: 560px) {
            main { padding: 24px 18px; }
            .recommendation { grid-template-columns: minmax(0, 1fr); gap: 12px; }
        }
    </style>
</head>
<body>
    <main>
        <header>
            <h1>Lower-Cost Models by Task</h1>
            <p class="intro">Start with a model that fits the task. Use deeper reasoning when it earns its cost.</p>
            <a href="https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing">Compare current model pricing</a>
        </header>
        <section class="recommendation" aria-labelledby="docs-task">
            <div>
                <h2 id="docs-task">Docs &amp; small changes</h2>
                <p class="task-detail">Explanations, small functions and focused tests</p>
            </div>
            <div>
                <p class="model">GPT-5 mini</p>
                <p>A budget starting point for well-scoped coding and writing.</p>
                <p class="note">Larger models are often unnecessary for these tasks.</p>
            </div>
        </section>
        <section class="recommendation" aria-labelledby="fixes-task">
            <div>
                <h2 id="fixes-task">Quick fixes</h2>
                <p class="task-detail">Repetitive edits and lightweight coding questions</p>
            </div>
            <div>
                <p class="model">Claude Haiku 4.5</p>
                <p>A fast alternative when you prefer Claude.</p>
                <p class="note">Compare its cost with mini models; it is not necessarily the cheapest.</p>
            </div>
        </section>
        <section class="recommendation" aria-labelledby="explore-task">
            <div>
                <h2 id="explore-task">Codebase exploration</h2>
                <p class="task-detail">Finding implementations and gathering context</p>
            </div>
            <div>
                <p class="model">GPT-5.4 mini</p>
                <p>Suited to search-driven agent work.</p>
                <p class="note">Gather the relevant files before spending on deeper reasoning.</p>
            </div>
        </section>
        <section class="guidance" aria-labelledby="complex-task">
            <h2 id="complex-task">Complex bugs &amp; architecture</h2>
            <ul>
                <li>Start with a focused reproduction and tests.</li>
                <li>Escalate to a stronger reasoning model when the cheaper model cannot resolve the issue.</li>
                <li>Avoid repeated failed attempts; they can cost more overall.</li>
            </ul>
        </section>
        <footer>
            <p>General suggestions, not analysis of your current chat. Availability depends on your plan and organization.</p>
            <p>Check current pricing or your plan's usage multiplier before switching manually. Token volume, caching and retries affect total cost; no model is always cheapest.</p>
            <p>Keep context and requested output focused.</p>
        </footer>
    </main>
</body>
</html>`;
}

function log(message: string): void {
    outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return '[Unable to serialize value]';
    }
}

function updateStatusBar(type: string, snapshot: QuotaSnapshot): void {
    if (!statusBar) return;

    const unlimited = snapshot.entitlementRequests < 0;
    const remaining = Math.max(0, Math.min(100, snapshot.remainingPercentage));

    statusBar.text = unlimited
        ? '$(github) Copilot: unlimited'
        : `$(github) Copilot: ${formatPercent(remaining)}% left`;

    statusBar.tooltip = buildTooltip(type, snapshot);
    statusBar.backgroundColor = unlimited ? undefined : getStatusBackground(remaining);
}

function setStatusLoading(): void {
    if (!statusBar) return;
    statusBar.text = '$(sync~spin) Copilot: checking…';
    statusBar.tooltip = 'Checking GitHub Copilot quota…';
    statusBar.backgroundColor = undefined;
}

function setStatusError(message: string): void {
    if (!statusBar) return;
    statusBar.text = '$(warning) Copilot: quota unavailable';
    statusBar.tooltip = `Unable to read Copilot quota.\n\n${message}\n\nClick to retry/details.`;
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
}

function buildTooltip(type: string, snapshot: QuotaSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;

    md.appendMarkdown(`**GitHub Copilot quota**\n\n`);
    md.appendMarkdown(`Quota: ${formatQuotaType(type)}\n\n`);

    if (snapshot.entitlementRequests < 0) {
        md.appendMarkdown(`**Allowance:** Unlimited\n\n`);
    } else {
        const remainingRequests = Math.max(
            0,
            snapshot.entitlementRequests - snapshot.usedRequests
        );

        md.appendMarkdown(`**Used:** ${snapshot.usedRequests.toLocaleString()} / ${snapshot.entitlementRequests.toLocaleString()}\n\n`);
        md.appendMarkdown(`**Remaining:** ${remainingRequests.toLocaleString()} requests (${formatPercent(snapshot.remainingPercentage)}%)\n\n`);
    }

    const showReset = vscode.workspace
        .getConfiguration('copilotQuota')
        .get<boolean>('showResetDate', true);

    if (showReset && snapshot.resetDate) {
        md.appendMarkdown(`**Resets:** ${formatDate(snapshot.resetDate)}\n\n`);
    }

    md.appendMarkdown(`Click to view details or use **Copilot Quota: Refresh**.`);
    return md;
}

async function showDetails(): Promise<void> {
    if (!lastSnapshot) {
        await refresh(true);
    }

    if (!lastSnapshot) return;

    const snapshot = lastSnapshot;
    const unlimited = snapshot.entitlementRequests < 0;
    const remainingRequests = unlimited
        ? undefined
        : Math.max(0, snapshot.entitlementRequests - snapshot.usedRequests);
    const remaining = Math.max(0, Math.min(100, snapshot.remainingPercentage));

    const lines = [
        unlimited
            ? 'Allowance: Unlimited'
            : `Usage: ${formatPercent(100 - remaining)}% used | ${formatPercent(remaining)}% remaining`,
        `Used: ${snapshot.usedRequests.toLocaleString()} requests`
    ];

    if (!unlimited) {
        lines.push(
            `Allowance: ${snapshot.entitlementRequests.toLocaleString()} requests`,
            `Remaining: ${remainingRequests!.toLocaleString()} requests`
        );
    }

    const showReset = vscode.workspace.getConfiguration('copilotQuota').get<boolean>('showResetDate', true);
    if (showReset) {
        lines.push(snapshot.resetDate ? `Resets: ${formatDate(snapshot.resetDate)}` : 'Resets: Not provided');
    }

    const choice = await vscode.window.showInformationMessage(
        `Copilot Usage: ${formatQuotaType(lastQuotaType)}`,
        { modal: true, detail: lines.join('\n\n') },
        'Refresh',
        'Model Suggestions'
    );

    if (choice === 'Refresh') {
        await refresh(true);
        if (lastSnapshot) await showDetails();
    } else if (choice === 'Model Suggestions') {
        await showModelSuggestions();
    }
}

function formatPercent(value: number): string {
    return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

function formatQuotaType(type: string): string {
    return type === 'premium_interactions' ? 'Premium model' : type;
}

function formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
    });
}

function getStatusBackground(remaining: number): vscode.ThemeColor | undefined {
    if (remaining <= 10) {
        return new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    if (remaining <= 50) {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_[\]{}<>]/g, '\\$&');
}
