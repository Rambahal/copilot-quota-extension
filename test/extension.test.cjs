const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

async function createHarness(settings = {}) {
    const commands = new Map();
    const clients = [];
    const authRequests = [];
    const logs = [];
    const warnings = [];
    const details = [];
    const panels = [];
    const openedUrls = [];
    const configUpdates = [];
    const statusBar = { show() {} };
    const store = new Map(Object.entries(settings.globalState ?? {}));
    const globalState = {
        get: (key, fallback) => store.has(key) ? store.get(key) : fallback,
        async update(key, value) { store.set(key, value); },
        entries: () => [...store.entries()]
    };
    let session = settings.session;
    let configurationListener;
    let quotaCalls = 0;
    const vscode = {
        env: {
            async openExternal(uri) {
                openedUrls.push(uri);
                return true;
            }
        },
        Uri: { parse: value => value },
        authentication: {
            async getSession(provider, scopes, options) {
                authRequests.push({ provider, scopes, options });
                if (options.createIfNone) {
                    if (settings.cancelSignIn) throw new Error('Sign-in cancelled');
                    session = settings.signInSession ?? { accessToken: 'test-token' };
                }
                return session;
            }
        },
        commands: {
        process: { env: {} },
            registerCommand(name, handler) {
                commands.set(name, handler);
                return { dispose() {} };
            }
        },
        workspace: {
            getConfiguration: name => ({
                get: (key, fallback) => name === 'github-enterprise'
                    ? settings.githubEnterpriseUri ?? fallback
                    : settings.configuration?.[key] ?? fallback,
                async update(key, value, target) {
                    configUpdates.push({ section: name, key, value, target });
                    settings.configuration = { ...settings.configuration, [key]: value };
                }
            }),
            onDidChangeConfiguration: listener => {
                configurationListener = listener;
                return { dispose() {} };
            }
        },
        window: {
            createWebviewPanel: (viewType, title, column, options) => {
                let disposeListener;
                const panel = {
                    viewType, title, column, options,
                    webview: { html: '' },
                    reveals: 0,
                    reveal() { this.reveals++; },
                    onDidDispose(listener) { disposeListener = listener; },
                    dispose() { disposeListener?.(); }
                };
                panels.push(panel);
                return panel;
            },
            createOutputChannel: () => ({ appendLine: message => logs.push(message) }),
            createStatusBarItem: () => statusBar,
            showErrorMessage: async () => settings.action,
            showWarningMessage: async (message, ...actions) => {
                warnings.push({ message, actions });
                return settings.warningAction;
            },
            showInformationMessage: async (message, options, ...actions) => {
                details.push({ message, options, actions });
                return settings.detailsActions?.shift();
            }
        },
        StatusBarAlignment: { Right: 2 },
        ViewColumn: { Active: -1 },
        ConfigurationTarget: { Global: 1 },
        ThemeColor: class { constructor(id) { this.id = id; } },
        MarkdownString: class { appendMarkdown() {} }
    };
    class CopilotClient {
        constructor(options) {
            this.options = options;
            this.stopped = false;
            clients.push(this);
            this.rpc = { account: { getQuota: async () => {
                quotaCalls++;
                if (settings.failQuota) throw new Error('Quota request failed');
                return { quotaSnapshots: { [settings.quotaType ?? 'premium_interactions']: settings.snapshot ?? {
                    entitlementRequests: 100,
                    usedRequests: 20,
                    remainingPercentage: 80
                } } };
            } } };
        }
        async start() {
            if (settings.failStart) throw new Error('Startup failed');
        }
        async stop() { this.stopped = true; }
        async getAuthStatus() {
            return { isAuthenticated: Boolean(this.options.gitHubToken || settings.cliAuthenticated) };
        }
    }
    const context = vm.createContext({
        exports: {},
        require: name => {
            assert.equal(name, 'vscode');
            return vscode;
        },
        Error,
        process,
        setInterval: () => 1,
        clearInterval() {}
    });
    const sdk = new vm.SyntheticModule(['CopilotClient'], function () {
        this.setExport('CopilotClient', CopilotClient);
    }, { context });
    await sdk.link(() => {});
    await sdk.evaluate();
    const source = fs.readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8');
    new vm.Script(source, {
        importModuleDynamically: async specifier => {
            assert.equal(specifier, '@github/copilot-sdk');
            return sdk;
        }
    }).runInContext(context);
    await context.exports.activate({ subscriptions: [], globalState });
    return {
        commands, clients, authRequests, logs, statusBar, warnings, details, panels, openedUrls, globalState, configUpdates,
        get quotaCalls() { return quotaCalls; },
        setSession(value) { session = value; },
        async setEnterpriseUri(value) {
            settings.githubEnterpriseUri = value;
            configurationListener({ affectsConfiguration: name => name === 'github-enterprise.uri' });
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

test('background refresh passes an authorized VS Code token without prompting or logging it', async () => {
    const harness = await createHarness({ session: { accessToken: 'private-test-token' } });
    assert.equal(harness.authRequests[0].provider, 'github');
    assert.equal(harness.authRequests[0].options.silent, true);
    assert.equal(harness.clients[0].options.gitHubToken, 'private-test-token');
    assert.equal(harness.clients[0].options.useLoggedInUser, false);
    assert.equal(harness.quotaCalls, 1);
    assert.match(harness.statusBar.text, /80% left/);
    assert.ok(harness.logs.every(message => !message.includes('private-test-token')));
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.clients.length, 1);
});

test('existing CLI authentication still works without a VS Code session', async () => {
    const harness = await createHarness({ cliAuthenticated: true });
    assert.equal(harness.clients[0].options.gitHubToken, undefined);
    assert.equal(harness.quotaCalls, 1);
});

test('unauthenticated startup skips quota and explicit sign-in recovers', async () => {
    const harness = await createHarness();
    assert.equal(harness.quotaCalls, 0);
    assert.equal(harness.clients[0].stopped, true);
    assert.match(harness.statusBar.tooltip, /Copilot Quota: Sign In/);
    await harness.commands.get('copilotQuota.signIn')();
    assert.equal(harness.authRequests[1].options.createIfNone, true);
    assert.equal(harness.clients[1].options.gitHubToken, 'test-token');
    assert.equal(harness.quotaCalls, 1);
});

test('GHE sign-in uses the Enterprise session and routes the SDK to the configured host', async () => {
    const harness = await createHarness({
        githubEnterpriseUri: 'https://yourcompany.ghe.com',
        session: { accessToken: 'old-token' },
        signInSession: { accessToken: 'ghe-token' }
    });

    assert.equal(harness.authRequests[0].provider, 'github-enterprise');
    await harness.commands.get('copilotQuota.signIn')();

    assert.equal(harness.authRequests[1].provider, 'github-enterprise');
    assert.equal(harness.authRequests[1].options.clearSessionPreference, true);
    assert.equal(harness.clients.length, 2, harness.logs.join('\n'));
    assert.equal(harness.clients[0].stopped, true);
    assert.equal(harness.clients[1].options.gitHubToken, 'ghe-token');
    assert.equal(harness.clients[1].options.env.COPILOT_GH_HOST, 'https://yourcompany.ghe.com');
    assert.equal(harness.quotaCalls, 2);
});

test('Enterprise URL setting changes replace the client even when the token is unchanged', async () => {
    const harness = await createHarness({ session: { accessToken: 'test-token' } });
    await harness.setEnterpriseUri('https://example.ghe.com');
    assert.equal(harness.clients.length, 2);
    assert.equal(harness.clients[0].stopped, true);
    assert.equal(harness.authRequests[1].provider, 'github-enterprise');
    assert.equal(harness.authRequests[1].options.silent, true);
    assert.equal(harness.clients[1].options.env.COPILOT_GH_HOST, 'https://example.ghe.com');
    await harness.setEnterpriseUri('https://other.ghe.com');
    assert.equal(harness.clients[1].stopped, true);
    assert.equal(harness.clients[2].options.env.COPILOT_GH_HOST, 'https://other.ghe.com');
    await harness.setEnterpriseUri(undefined);
    assert.equal(harness.clients[2].stopped, true);
    assert.equal(harness.authRequests[3].provider, 'github');
    assert.equal(harness.clients[3].options.env, undefined);
    assert.equal(harness.quotaCalls, 4);
});

test('Sign In action runs after the refresh lock is released', async () => {
    const harness = await createHarness({ action: 'Sign In' });
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.quotaCalls, 1);
    assert.match(harness.statusBar.text, /80% left/);
});

test('Retry performs another request and discards failed clients', async () => {
    const harness = await createHarness({ cliAuthenticated: true, failQuota: true, action: 'Retry' });
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.quotaCalls, 3);
    assert.equal(harness.clients.length, 3);
    assert.ok(harness.clients.every(client => client.stopped));
});

test('startup failures do not cache a broken client', async () => {
    const settings = { cliAuthenticated: true, failStart: true };
    const harness = await createHarness(settings);
    assert.equal(harness.clients[0].stopped, true);
    settings.failStart = false;
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.clients.length, 2);
    assert.equal(harness.quotaCalls, 1);
});

test('token changes and sign-out replace the cached client on refresh', async () => {
    const harness = await createHarness({ session: { accessToken: 'old-token' } });
    harness.setSession({ accessToken: 'new-token' });
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.clients[0].stopped, true);
    assert.equal(harness.clients[1].options.gitHubToken, 'new-token');
    harness.setSession(undefined);
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.clients[1].stopped, true);
    assert.equal(harness.quotaCalls, 2);
    assert.match(harness.statusBar.text, /quota unavailable/);
});

test('cancelled sign-in is handled without a quota request', async () => {
    const harness = await createHarness({ cancelSignIn: true });
    await harness.commands.get('copilotQuota.signIn')();
    assert.equal(harness.quotaCalls, 0);
    assert.match(harness.statusBar.tooltip, /Sign-in cancelled/);
});

test('usage warnings fire at 50, 75 and 90 percent used without repeating on refresh', async () => {
    const settings = {
        cliAuthenticated: true,
        snapshot: { entitlementRequests: 100, usedRequests: 49, remainingPercentage: 51 }
    };
    const harness = await createHarness(settings);
    assert.equal(harness.warnings.length, 0);
    for (const used of [50, 74, 75, 89, 90, 100]) {
        settings.snapshot.usedRequests = used;
        settings.snapshot.remainingPercentage = 100 - used;
        await harness.commands.get('copilotQuota.refresh')();
        await harness.commands.get('copilotQuota.refresh')();
    }
    assert.equal(harness.warnings.length, 3);
    for (const [index, threshold] of [50, 75, 90].entries()) {
        assert.match(harness.warnings[index].message, new RegExp(`${threshold}% warning`));
        assert.match(harness.warnings[index].message, /lower usage multiplier/);
    }
});

test('burn rate details show projected remaining and windowed usage pacing', async () => {
    const date = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const settings = {
        cliAuthenticated: true,
        snapshot: {
            entitlementRequests: 1000,
            usedRequests: 900,
            remainingPercentage: 10,
            resetDate: date
        }
    };
    const harness = await createHarness(settings);
    await harness.commands.get('copilotQuota.showDetails')();
    assert.equal(harness.details.length, 1);
    assert.match(harness.details[0].options.detail, /Daily average: \d+ requests/);
    assert.match(harness.details[0].options.detail, /Estimated usage until reset: 180 \(≈ \$1\.80\) — about \$0\.80 over budget/);
    assert.match(harness.details[0].options.detail, /Projected remaining at reset:/);
    assert.match(harness.details[0].options.detail, /may run out before reset/);
});

test('a snapshot-time reset date is ignored and the configured cycle day anchors the projection', async () => {
    const key = 'copilotQuota.usageHistory:["github.com","cli"]:premium_interactions';
    const snapshotTime = new Date(Date.now() - 30 * 1000).toISOString();
    const settings = {
        cliAuthenticated: true,
        snapshot: { entitlementRequests: 10000, usedRequests: 1050, remainingPercentage: 89.5, resetDate: snapshotTime }
    };
    const harness = await createHarness(settings);
    await harness.commands.get('copilotQuota.showDetails')();
    const detail = harness.details[0].options.detail;
    assert.match(detail, /Daily average: \d+ requests/);
    assert.match(detail, /Estimated usage until reset: [\d,]+ \(≈ \$[\d,]+\.\d{2}\)\n/);
    assert.doesNotMatch(detail, /over budget/);
    assert.match(detail, /Projected remaining at reset:/);
    assert.match(detail, /Resets: .*2026/);
    assert.doesNotMatch(detail, /assumed/);

    settings.configuration = { cycleResetDay: 0 };
    const disabled = await createHarness(settings);
    await disabled.commands.get('copilotQuota.showDetails')();
    assert.doesNotMatch(disabled.details[0].options.detail, /Daily average|Projected remaining|may run out/);
    assert.match(disabled.details[0].options.detail, /Resets: Not provided/);

    settings.globalState = { [key]: { resetDate: snapshotTime, samples: [{ time: Date.now() - 3 * 60 * 60 * 1000, used: 1038 }] } };
    const measured = await createHarness(settings);
    await measured.commands.get('copilotQuota.showDetails')();
    assert.match(measured.details[0].options.detail, /Daily average: 96 requests/);
    assert.doesNotMatch(measured.details[0].options.detail, /Projected remaining|may run out/);
});

test('burn rate falls back to locally recorded usage when no reset date can be determined', async () => {
    const key = 'copilotQuota.usageHistory:["github.com","cli"]:premium_interactions';
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const harness = await createHarness({
        cliAuthenticated: true,
        configuration: { cycleResetDay: 0 },
        snapshot: { entitlementRequests: 1000, usedRequests: 250, remainingPercentage: 75 },
        globalState: { [key]: { resetDate: null, samples: [{ time: twoDaysAgo, used: 98 }] } }
    });
    await harness.commands.get('copilotQuota.showDetails')();
    assert.match(harness.details[0].options.detail, /Daily average: 76 requests/);
    assert.doesNotMatch(harness.details[0].options.detail, /Estimated usage until reset:/);
    assert.equal(harness.globalState.get(key).samples.length, 2);
    assert.equal(harness.warnings.length, 0);
});

test('usage history restarts when used requests drop but survives a drifting reset date', async () => {
    const key = 'copilotQuota.usageHistory:["github.com","cli"]:premium_interactions';
    const settings = {
        cliAuthenticated: true,
        snapshot: { entitlementRequests: 1000, usedRequests: 250, remainingPercentage: 75, resetDate: '2026-11-01' },
        globalState: { [key]: { resetDate: '2026-11-01', samples: [{ time: Date.now() - 60 * 60 * 1000, used: 240 }] } }
    };
    const harness = await createHarness(settings);
    assert.equal(harness.globalState.get(key).samples.length, 2);
    settings.snapshot.resetDate = '2026-11-01T00:10:00Z';
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.globalState.get(key).samples.length, 3);
    settings.snapshot.usedRequests = 5;
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.globalState.get(key).samples.map(sample => sample.used).join(), '5');
    assert.equal(harness.globalState.get(key).resetDate, '2026-11-01T00:10:00Z');
});

test('rapid usage shows a spike warning once and View Usage opens details', async () => {
    const key = 'copilotQuota.usageHistory:["github.com","cli"]:premium_interactions';
    const now = Date.now();
    const settings = {
        cliAuthenticated: true,
        warningAction: 'View Usage',
        snapshot: { entitlementRequests: 10000, usedRequests: 710, remainingPercentage: 92.9 },
        globalState: { [key]: { resetDate: null, samples: [
            { time: now - 2.5 * 24 * 60 * 60 * 1000, used: 0 },
            { time: now - 45 * 60 * 1000, used: 595 }
        ] } }
    };
    const harness = await createHarness(settings);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0].message, /unusually high: 115 requests in the last 45 minutes is about 11x the pace/);
    assert.match(harness.warnings[0].message, /7\.1% of your monthly quota in the last 3 days\.$/);
    assert.deepEqual(harness.warnings[0].actions, ['View Usage', 'Dismiss', 'Disable Warning']);
    assert.equal(harness.details.length, 1);
    settings.snapshot.usedRequests = 1200;
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.warnings.length, 1);
});

test('Disable Warning on a spike turns the setting off globally', async () => {
    const key = 'copilotQuota.usageHistory:["github.com","cli"]:premium_interactions';
    const now = Date.now();
    const harness = await createHarness({
        cliAuthenticated: true,
        warningAction: 'Disable Warning',
        snapshot: { entitlementRequests: 10000, usedRequests: 710, remainingPercentage: 92.9 },
        globalState: { [key]: { resetDate: null, samples: [{ time: now - 45 * 60 * 1000, used: 595 }] } }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0].message, /pace your allowance supports\.$/);
    assert.deepEqual(harness.configUpdates, [{ section: 'copilotQuota', key: 'spikeHourlyPercent', value: 0, target: 1 }]);
    assert.equal(harness.details.length, 0);
});

test('moderate usage, short spans and a disabled threshold do not trigger spike warnings', async () => {
    const key = 'copilotQuota.usageHistory:["github.com","cli"]:premium_interactions';
    const now = Date.now();
    const belowThreshold = await createHarness({
        cliAuthenticated: true,
        snapshot: { entitlementRequests: 10000, usedRequests: 90, remainingPercentage: 99 },
        globalState: { [key]: { resetDate: null, samples: [{ time: now - 50 * 60 * 1000, used: 0 }] } }
    });
    assert.equal(belowThreshold.warnings.length, 0);

    const shortSpan = await createHarness({
        cliAuthenticated: true,
        snapshot: { entitlementRequests: 10000, usedRequests: 500, remainingPercentage: 95 },
        globalState: { [key]: { resetDate: null, samples: [{ time: now - 10 * 60 * 1000, used: 0 }] } }
    });
    assert.equal(shortSpan.warnings.length, 0);

    const disabled = await createHarness({
        cliAuthenticated: true,
        configuration: { spikeHourlyPercent: 0 },
        snapshot: { entitlementRequests: 10000, usedRequests: 500, remainingPercentage: 95 },
        globalState: { [key]: { resetDate: null, samples: [{ time: now - 50 * 60 * 1000, used: 0 }] } }
    });
    assert.equal(disabled.warnings.length, 0);
});

test('usage jumps show only the highest warning and a new cycle rearms notifications', async () => {
    const settings = {
        cliAuthenticated: true,
        snapshot: { entitlementRequests: 100, usedRequests: 95, remainingPercentage: 5, resetDate: '2026-10-01' }
    };
    const harness = await createHarness(settings);
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0].message, /90% warning/);
    settings.snapshot.resetDate = '2026-11-01';
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.warnings.length, 1);
    settings.snapshot.usedRequests = 60;
    settings.snapshot.remainingPercentage = 40;
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.warnings.length, 2);
    assert.match(harness.warnings[1].message, /50% warning/);
});

test('unlimited, zero allowance and invalid percentage snapshots do not warn', async () => {
    for (const snapshot of [
        { entitlementRequests: -1, usedRequests: 100, remainingPercentage: 0 },
        { entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0 },
        { entitlementRequests: 100, usedRequests: 50, remainingPercentage: NaN }
    ]) {
        const harness = await createHarness({ cliAuthenticated: true, snapshot });
        assert.equal(harness.warnings.length, 0);
    }
});

test('usage dialog shows structured details and Refresh reopens the updated view', async () => {
    const harness = await createHarness({ cliAuthenticated: true, detailsActions: ['Refresh'] });
    await harness.commands.get('copilotQuota.showDetails')();
    assert.equal(harness.details.length, 2);
    assert.equal(harness.quotaCalls, 2);
    const dialog = harness.details[1];
    assert.equal(dialog.message, 'Copilot Usage: Premium model');
    assert.equal(dialog.options.modal, true);
    assert.match(dialog.options.detail, /Usage: 20% used \| 80% remaining/);
    assert.match(dialog.options.detail, /Used: 20 requests \(≈ \$0\.20\)\n\nAllowance: 100 requests \(≈ \$1\.00\)\n\nRemaining: 80 requests \(≈ \$0\.80\)/);
    assert.match(dialog.options.detail, /Resets: .*20\d\d/);
    assert.deepEqual(dialog.actions, ['Refresh', 'Model Suggestions']);
});

test('details estimate when the allowance runs out at the current rate', async () => {
    const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const early = await createHarness({
        cliAuthenticated: true,
        snapshot: { entitlementRequests: 1000, usedRequests: 750, remainingPercentage: 25, resetDate: inFiveDays }
    });
    await early.commands.get('copilotQuota.showDetails')();
    assert.match(early.details[0].options.detail, /Runs out: not before the reset at this rate/);
    assert.doesNotMatch(early.details[0].options.detail, /may run out before reset/);

    const inTwentyDays = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    const late = await createHarness({
        cliAuthenticated: true,
        snapshot: { entitlementRequests: 1000, usedRequests: 900, remainingPercentage: 10, resetDate: inTwentyDays }
    });
    await late.commands.get('copilotQuota.showDetails')();
    assert.match(late.details[0].options.detail, /Runs out: in about 1 day \(.+\), before the reset/);

    const key = 'copilotQuota.usageHistory:["github.com","cli"]:premium_interactions';
    const measured = await createHarness({
        cliAuthenticated: true,
        configuration: { cycleResetDay: 0 },
        snapshot: { entitlementRequests: 1000, usedRequests: 250, remainingPercentage: 75 },
        globalState: { [key]: { resetDate: null, samples: [{ time: Date.now() - 2 * 24 * 60 * 60 * 1000, used: 100 }] } }
    });
    await measured.commands.get('copilotQuota.showDetails')();
    assert.match(measured.details[0].options.detail, /Runs out: in about 10 days \(.+\)\n/);
});

test('cost estimates follow the configured rate and are hidden when set to zero', async () => {
    const date = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const snapshot = { entitlementRequests: 1000, usedRequests: 750, remainingPercentage: 25, resetDate: date };
    const legacy = await createHarness({ cliAuthenticated: true, snapshot, configuration: { costPerRequestUsd: 0.04 } });
    await legacy.commands.get('copilotQuota.showDetails')();
    assert.match(legacy.details[0].options.detail, /Used: 750 requests \(≈ \$30\.00\)/);
    assert.match(legacy.details[0].options.detail, /Estimated usage until reset: 150 \(≈ \$6\.00\)\n/);
    assert.doesNotMatch(legacy.details[0].options.detail, /over budget/);

    const hidden = await createHarness({ cliAuthenticated: true, snapshot, configuration: { costPerRequestUsd: 0 } });
    await hidden.commands.get('copilotQuota.showDetails')();
    assert.doesNotMatch(hidden.details[0].options.detail, /\$/);
});

test('warning suggestions explain task fit without making extra quota or model requests', async () => {
    const harness = await createHarness({
        cliAuthenticated: true,
        warningAction: 'Model Suggestions',
        snapshot: { entitlementRequests: 100, usedRequests: 75, remainingPercentage: 25 }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(harness.warnings[0].message, /docs, explanations, or small tests/);
    assert.ok(harness.warnings[0].actions.includes('Model Suggestions'));
    assert.equal(harness.details.length, 0);
    assert.equal(harness.panels.length, 1);
    const panel = harness.panels[0];
    assert.equal(panel.title, 'Model Suggestions');
    assert.equal(panel.options.enableScripts, false);
    assert.equal(panel.options.localResourceRoots.length, 0);
    assert.match(panel.webview.html, /<h1>Lower-Cost Models by Task<\/h1>/);
    assert.match(panel.webview.html, /<h2[^>]*>Docs &amp; small changes<\/h2>/);
    assert.match(panel.webview.html, /class="model">GPT-5 mini/);
    assert.match(panel.webview.html, /class="model">Claude Haiku 4.5/);
    assert.match(panel.webview.html, /class="model">GPT-5.4 mini/);
    assert.match(panel.webview.html, /repeated failed attempts/);
    assert.match(panel.webview.html, /not analysis of your current chat/);
    assert.match(panel.webview.html, /no model is always cheapest/);
    assert.match(panel.webview.html, /var\(--vscode-editor-background\)/);
    assert.match(panel.webview.html, /@media \(max-width: 560px\)/);
    assert.match(panel.webview.html, /default-src 'none'/);
    assert.doesNotMatch(panel.webview.html, /<script\b/);
    assert.equal(harness.quotaCalls, 1);
    assert.equal(harness.openedUrls.length, 0);
});

test('usage dialog suggestions offer an official pricing link without opening a browser automatically', async () => {
    const harness = await createHarness({
        cliAuthenticated: true,
        detailsActions: ['Model Suggestions']
    });
    await harness.commands.get('copilotQuota.showDetails')();
    assert.equal(harness.details.length, 1);
    assert.equal(harness.panels.length, 1);
    assert.match(harness.panels[0].webview.html,
        /href="https:\/\/docs.github.com\/en\/copilot\/reference\/copilot-billing\/models-and-pricing"/);
    assert.equal(harness.openedUrls.length, 0);
    assert.equal(harness.quotaCalls, 1);
});

test('model suggestions reuse the existing tab and reopen after disposal', async () => {
    const harness = await createHarness({
        cliAuthenticated: true,
        detailsActions: ['Model Suggestions', 'Model Suggestions', 'Model Suggestions']
    });
    await harness.commands.get('copilotQuota.showDetails')();
    await harness.commands.get('copilotQuota.showDetails')();
    assert.equal(harness.panels.length, 1);
    assert.equal(harness.panels[0].reveals, 1);
    harness.panels[0].dispose();
    await harness.commands.get('copilotQuota.showDetails')();
    assert.equal(harness.panels.length, 2);
});

test('usage dialog respects the reset date setting and unlimited quota has no warning color', async () => {
    const harness = await createHarness({
        cliAuthenticated: true,
        configuration: { showResetDate: false },
        snapshot: { entitlementRequests: -1, usedRequests: 200, remainingPercentage: 0, resetDate: '2026-10-01' }
    });
    await harness.commands.get('copilotQuota.showDetails')();
    assert.match(harness.details[0].options.detail, /Allowance: Unlimited/);
    assert.doesNotMatch(harness.details[0].options.detail, /Resets:|Remaining:|%/);
    assert.equal(harness.statusBar.backgroundColor, undefined);
});

test('warning action opens usage details and status colors follow usage thresholds', async () => {
    const settings = {
        cliAuthenticated: true, warningAction: 'View Usage',
        snapshot: { entitlementRequests: 100, usedRequests: 50, remainingPercentage: 50 }
    };
    const harness = await createHarness(settings);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.details.length, 1);
    assert.equal(harness.statusBar.backgroundColor.id, 'statusBarItem.warningBackground');
    settings.snapshot.remainingPercentage = 10;
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.statusBar.backgroundColor.id, 'statusBarItem.errorBackground');
});

test('warning state is separate per account and zero usage rearms quotas without reset dates', async () => {
    const settings = {
        session: { accessToken: 'first-token', account: { id: 'first-account' } },
        snapshot: { entitlementRequests: 100, usedRequests: 50, remainingPercentage: 50 }
    };
    const harness = await createHarness(settings);
    harness.setSession({ accessToken: 'second-token', account: { id: 'second-account' } });
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.warnings.length, 2);
    harness.setSession(settings.session);
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.warnings.length, 2);
    settings.snapshot.remainingPercentage = 100;
    await harness.commands.get('copilotQuota.refresh')();
    settings.snapshot.remainingPercentage = 50;
    await harness.commands.get('copilotQuota.refresh')();
    assert.equal(harness.warnings.length, 3);
});