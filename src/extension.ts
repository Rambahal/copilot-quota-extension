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
let refreshTimer: NodeJS.Timeout | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let lastSnapshot: QuotaSnapshot | undefined;
let lastQuotaType = 'premium_interactions';
let loading = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'copilotQuota.showDetails';
    statusBar.tooltip = 'GitHub Copilot quota';
    statusBar.text = '$(sync~spin) Copilot: loading…';
    statusBar.show();
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotQuota.refresh', () => refresh(true)),
        vscode.commands.registerCommand('copilotQuota.showDetails', showDetails),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('copilotQuota')) {
                configureRefreshTimer();
                void refresh(false);
            }
        })
    );

    configureRefreshTimer();
    await refresh(false);
}

export async function deactivate(): Promise<void> {
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

async function getClient(): Promise<CopilotClient> {
    if (client) {
        return client;
    }

    const { CopilotClient } = await import('@github/copilot-sdk');
    client = new CopilotClient();

    await client.start();
    return client;
}

async function getQuota(): Promise<{ type: string; snapshot: QuotaSnapshot }> {
    const configuredType = vscode.workspace
        .getConfiguration('copilotQuota')
        .get<string>('quotaType', 'premium_interactions');

    const copilot = await getClient();
    const result = await copilot.rpc.account.getQuota({}) as QuotaResult;
    const snapshots = result.quotaSnapshots ?? {};

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
        throw new Error(
            available.length
                ? `Quota '${configuredType}' was not returned. Available quotas: ${available.join(', ')}`
                : 'No Copilot quota information was returned for this account.'
        );
    }

    return { type: quotaType, snapshot };
}

async function refresh(showErrors: boolean): Promise<void> {
    if (loading) {
        return;
    }

    loading = true;
    setStatusLoading();

    try {
        const { type, snapshot } = await getQuota();
        lastQuotaType = type;
        lastSnapshot = snapshot;
        updateStatusBar(type, snapshot);
    } catch (error) {
        lastSnapshot = undefined;
        const message = error instanceof Error ? error.message : String(error);
        setStatusError(message);

        if (showErrors) {
            const action = await vscode.window.showErrorMessage(
                `Copilot quota could not be read: ${message}`,
                'Retry'
            );
            if (action === 'Retry') {
                await refresh(false);
            }
        }
    } finally {
        loading = false;
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
    statusBar.backgroundColor = getStatusBackground(remaining);
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

    const lines = [
        `Quota: ${formatQuotaType(lastQuotaType)}`,
        unlimited
            ? 'Allowance: Unlimited'
            : `Used: ${snapshot.usedRequests.toLocaleString()} / ${snapshot.entitlementRequests.toLocaleString()}`,
        unlimited
            ? `Remaining: ${formatPercent(snapshot.remainingPercentage)}%`
            : `Remaining: ${remainingRequests!.toLocaleString()} (${formatPercent(snapshot.remainingPercentage)}%)`,
        snapshot.resetDate ? `Resets: ${formatDate(snapshot.resetDate)}` : 'Resets: Not provided'
    ];

    const choice = await vscode.window.showInformationMessage(
        lines.join('  •  '),
        'Refresh'
    );

    if (choice === 'Refresh') {
        await refresh(true);
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
    if (remaining <= 25) {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_[\]{}<>]/g, '\\$&');
}
