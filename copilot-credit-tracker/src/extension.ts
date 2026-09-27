import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { randomBytes } from 'crypto';

let server: http.Server | undefined;
let listenerRetryTimer: NodeJS.Timeout | undefined;
const viewId = 'copilot-credit-tracker.usageView';
const userIdKey = 'copilot-credit-tracker.userId';
const usernameKey = 'copilot-credit-tracker.username';
const featureIdKey = 'copilot-credit-tracker.featureId';

interface FeatureOption {
    feature_id: string;
    pi_id: string;
    name: string;
    description?: string | null;
}

interface PIOption {
    pi_id: string;
    name: string;
}

interface TelemetryAttribute {
    key: string;
    value?: {
        stringValue?: string;
        intValue?: string | number;
        doubleValue?: number;
        boolValue?: boolean;
    };
}

interface TelemetrySpan {
    attributes?: TelemetryAttribute[];
}

interface TelemetryPayload {
    resourceSpans?: Array<{
        scopeSpans?: Array<{
            spans?: TelemetrySpan[];
        }>;
    }>;
}

interface BackendUser {
    user_id: string;
    username: string;
}

class BackendResponseError extends Error {
    constructor(readonly statusCode: number, message: string) {
        super(message);
    }
}

function requestJson<T>(url: string, method = 'GET', payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const transport = target.protocol === 'https:' ? https : http;
        const body = payload === undefined ? undefined : JSON.stringify(payload);
        const request = transport.request(target, {
            method,
            headers: body ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            } : undefined,
            timeout: 10000,
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                const statusCode = response.statusCode ?? 500;
                if (statusCode < 200 || statusCode >= 300) {
                    reject(new BackendResponseError(statusCode, `Backend returned ${statusCode}: ${responseBody}`));
                    return;
                }
                try {
                    resolve(responseBody ? JSON.parse(responseBody) as T : undefined as T);
                } catch (error) {
                    reject(new Error(`Backend returned invalid JSON: ${String(error)}`));
                }
            });
        });
        request.on('timeout', () => request.destroy(new Error('Backend request timed out')));
        request.on('error', reject);
        if (body) {
            request.write(body);
        }
        request.end();
    });
}

async function postUsageWithRetry(backendUrl: string, usage: object, output: vscode.OutputChannel): Promise<boolean> {
    let retryDelayMs = 1000;
    let reportedUnavailable = false;

    while (true) {
        try {
            const result = await requestJson<{ usage_id: string }>(`${backendUrl}/usage`, 'POST', usage);
            output.appendLine(`[Usage] Sent ${result.usage_id} to backend.`);
            return true;
        } catch (error) {
            if (error instanceof BackendResponseError && error.statusCode < 500) {
                output.appendLine(`[Usage] Backend POST failed: ${String(error)}`);
                return false;
            }
            if (!reportedUnavailable) {
                output.appendLine(`[Usage] Backend unavailable; retrying this event: ${String(error)}`);
                reportedUnavailable = true;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
            retryDelayMs = Math.min(retryDelayMs * 2, 30000);
        }
    }
}

class UsageViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private readonly backendUrl: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        backendUrl: string,
        private readonly output: vscode.OutputChannel,
    ) {
        this.backendUrl = backendUrl.replace(/\/$/, '');
    }

    get selectedFeatureId(): string | undefined {
        return this.context.globalState.get<string>(featureIdKey);
    }

    get registeredUserId(): string | undefined {
        return this.context.globalState.get<string>(userIdKey);
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.getHtml(view.webview);
        view.webview.onDidReceiveMessage((message: { command?: string; username?: string; featureId?: string }) => {
            void this.handleMessage(message);
        }, undefined, this.context.subscriptions);
    }

    private async handleMessage(message: { command?: string; username?: string; featureId?: string }): Promise<void> {
        try {
            if (message.command === 'ready' || message.command === 'refresh') {
                await this.refreshState();
            } else if (message.command === 'register') {
                await this.registerUser(message.username ?? '');
            } else if (message.command === 'selectFeature' && message.featureId) {
                await this.context.globalState.update(featureIdKey, message.featureId);
                this.output.appendLine(`Selected feature ${message.featureId}`);
                await this.refreshState();
            }
        } catch (error) {
            this.output.appendLine(`[Backend] ${String(error)}`);
            await this.postState(String(error));
        }
    }

    private async registerUser(username: string): Promise<void> {
        const normalizedUsername = username.trim();
        if (!normalizedUsername) {
            throw new Error('Enter a username to register.');
        }

        let user: BackendUser;
        try {
            user = await requestJson<BackendUser>(`${this.backendUrl}/user`, 'POST', {
                username: normalizedUsername,
            });
        } catch (error) {
            // A prior registration is reused when the backend reports a duplicate username.
            const users = await requestJson<BackendUser[]>(`${this.backendUrl}/users`);
            const existingUser = users.find((candidate) => candidate.username === normalizedUsername);
            if (!existingUser) {
                throw error;
            }
            user = existingUser;
        }

        await this.context.globalState.update(userIdKey, user.user_id);
        await this.context.globalState.update(usernameKey, user.username);
        this.output.appendLine(`[Backend] Registered user ${user.username} (${user.user_id})`);
        await this.refreshState('Registered successfully.');
    }

    private async refreshState(statusMessage?: string): Promise<void> {
        if (!this.view) {
            return;
        }

        const [features, pis] = await Promise.all([
            requestJson<FeatureOption[]>(`${this.backendUrl}/features`),
            requestJson<PIOption[]>(`${this.backendUrl}/pis`),
        ]);
        const piNames = new Map(pis.map((pi) => [pi.pi_id, pi.name]));
        const username = this.context.globalState.get<string>(usernameKey);
        const userId = this.registeredUserId;
        const selectedFeatureId = this.selectedFeatureId;
        await this.view.webview.postMessage({
            command: 'state',
            username,
            registered: Boolean(userId),
            selectedFeatureId,
            features: features.map((feature) => ({
                feature_id: feature.feature_id,
                label: `${piNames.get(feature.pi_id) ?? 'PI'} / ${feature.name}`,
            })),
            status: statusMessage ?? (userId ? `Registered as ${username}.` : 'Register to start tracking usage.'),
        });
    }

    private async postState(statusMessage: string): Promise<void> {
        await this.view?.webview.postMessage({ command: 'status', status: statusMessage });
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('hex');
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Copilot Usage</title>
    <style>
        :root {
            color-scheme: light dark;
            --line: var(--vscode-panel-border, var(--vscode-widget-border));
            --muted: var(--vscode-descriptionForeground);
            --accent: var(--vscode-button-background);
            --surface: var(--vscode-editorWidget-background, var(--vscode-input-background));
        }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0 16px 20px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
        .masthead { display: flex; align-items: center; gap: 10px; padding: 18px 0 16px; border-bottom: 1px solid var(--line); }
        .mark { display: grid; width: 30px; height: 30px; place-items: center; flex: 0 0 auto; color: var(--vscode-button-foreground); background: var(--accent); font-family: Georgia, serif; font-size: 19px; font-style: italic; }
        .eyebrow, .section-kicker { margin: 0; color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
        h1 { margin: 2px 0 0; font-size: 15px; font-weight: 600; }
        main { padding-top: 20px; }
        .intro { margin: 0 0 22px; }
        .intro h2 { margin: 0 0 6px; font-family: Georgia, serif; font-size: 23px; font-weight: 400; }
        .intro p, .hint { margin: 0; color: var(--muted); line-height: 1.55; }
        .section { padding: 15px 0 17px; border-top: 1px solid var(--line); }
        .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
        .account { display: flex; align-items: center; gap: 9px; min-width: 0; }
        .account-mark { display: grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; border: 1px solid var(--line); border-radius: 50%; color: var(--vscode-textLink-foreground); font-size: 11px; font-weight: 600; }
        .account-name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
        label { display: block; margin: 0 0 6px; font-weight: 600; }
        input, select, button { min-height: 30px; color: var(--vscode-input-foreground); font: inherit; }
        input, select { width: 100%; padding: 5px 8px; border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 2px; outline-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
        input::placeholder { color: var(--vscode-input-placeholderForeground); }
        button { padding: 5px 10px; border: 1px solid transparent; border-radius: 2px; cursor: pointer; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
        button:disabled { cursor: wait; opacity: .65; }
        .primary { width: 100%; margin-top: 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        .primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
        .quiet { min-height: 26px; padding: 3px 7px; border-color: var(--line); color: var(--vscode-foreground); background: transparent; font-size: 11px; }
        .quiet:hover { background: var(--vscode-toolbar-hoverBackground); }
        .hint { margin-top: 8px; font-size: 11px; }
        .note { display: flex; gap: 9px; padding: 11px; border-left: 2px solid var(--accent); background: var(--surface); line-height: 1.5; }
        .note-mark { flex: 0 0 auto; color: var(--vscode-textLink-foreground); font-family: Georgia, serif; font-size: 15px; }
        #status { min-height: 34px; margin: 16px 0 0; padding: 9px 10px; border: 1px solid var(--line); color: var(--muted); line-height: 1.4; overflow-wrap: anywhere; }
        #status[data-kind="error"] { border-color: var(--vscode-inputValidation-errorBorder, var(--line)); color: var(--vscode-errorForeground); }
        #status[data-kind="success"] { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
        [hidden] { display: none !important; }
        @media (max-width: 260px) { body { padding-right: 11px; padding-left: 11px; } .intro h2 { font-size: 21px; } }
    </style>
</head>
<body>
    <header class="masthead">
        <div class="mark" aria-hidden="true">c</div>
        <div>
            <p class="eyebrow">Copilot / telemetry</p>
            <h1>Credit tracker</h1>
        </div>
    </header>
    <main>
        <div class="intro">
            <h2>Usage setup</h2>
            <p>Choose where your Copilot activity should be attributed.</p>
        </div>
        <section class="section" aria-labelledby="account-heading">
            <div class="section-heading">
                <p class="section-kicker" id="account-heading">Your account</p>
            </div>
            <div id="registration">
                <label for="username">Username</label>
                <input id="username" autocomplete="username" maxlength="255" placeholder="Enter your username">
                <button class="primary" id="register">Register account</button>
            </div>
            <div class="account" id="registered-account" hidden>
                <span class="account-mark" id="account-initial" aria-hidden="true"></span>
                <span class="account-name" id="account-name"></span>
            </div>
        </section>
        <section class="section" aria-labelledby="feature-heading">
            <div class="section-heading">
                <label class="section-kicker" id="feature-heading" for="feature">Tracking feature</label>
                <button class="quiet" id="refresh" aria-label="Refresh features">Refresh</button>
            </div>
            <select id="feature" disabled><option value="">Loading features...</option></select>
            <p class="hint">New usage will be assigned to this feature.</p>
        </section>
        <div class="note">
            <span class="note-mark" aria-hidden="true">i</span>
            <span>Copilot Chat telemetry is forwarded locally. Register and choose a feature to begin attribution.</span>
        </div>
        <p id="status" role="status" aria-live="polite" data-kind="info">Connecting to your usage service...</p>
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const registration = document.getElementById('registration');
        const registeredAccount = document.getElementById('registered-account');
        const accountName = document.getElementById('account-name');
        const accountInitial = document.getElementById('account-initial');
        const username = document.getElementById('username');
        const feature = document.getElementById('feature');
        const status = document.getElementById('status');
        const registerButton = document.getElementById('register');
        registerButton.addEventListener('click', () => {
            registerButton.disabled = true;
            registerButton.textContent = 'Registering...';
            setStatus('Registering account...', 'info');
            vscode.postMessage({ command: 'register', username: username.value });
        });
        document.getElementById('refresh').addEventListener('click', () => {
            setStatus('Refreshing available features...', 'info');
            vscode.postMessage({ command: 'refresh' });
        });
        feature.addEventListener('change', () => {
            feature.disabled = true;
            setStatus('Updating tracking feature...', 'info');
            vscode.postMessage({ command: 'selectFeature', featureId: feature.value });
        });
        function setStatus(message, kind) {
            status.textContent = message;
            status.dataset.kind = kind;
        }
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'state') {
                registration.hidden = message.registered;
                registeredAccount.hidden = !message.registered;
                registerButton.disabled = false;
                registerButton.textContent = 'Register account';
                if (message.username) {
                    username.value = message.username;
                    accountName.textContent = message.username;
                    accountInitial.textContent = message.username.trim().charAt(0).toUpperCase();
                }
                feature.replaceChildren();
                const emptyOption = document.createElement('option');
                emptyOption.value = '';
                emptyOption.textContent = message.features.length ? 'Select a feature' : 'No features found';
                feature.appendChild(emptyOption);
                for (const item of message.features) {
                    const option = document.createElement('option');
                    option.value = item.feature_id;
                    option.textContent = item.label;
                    feature.appendChild(option);
                }
                feature.value = message.selectedFeatureId || '';
                feature.disabled = message.features.length === 0;
                setStatus(message.status, 'success');
            } else if (message.command === 'status') {
                registerButton.disabled = false;
                registerButton.textContent = 'Register account';
                feature.disabled = false;
                setStatus(message.status, 'error');
            }
        });
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}

function attributeValue(attribute: TelemetryAttribute): string | number | boolean | undefined {
    const value = attribute.value;
    return value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? value?.boolValue;
}

async function configureCopilotTelemetry(output: vscode.OutputChannel): Promise<void> {
    const settings = vscode.workspace.getConfiguration();
    try {
        await settings.update('github.copilot.chat.otel.enabled', true, vscode.ConfigurationTarget.Global);
        await settings.update('github.copilot.chat.otel.exporterType', 'otlp-http', vscode.ConfigurationTarget.Global);
        await settings.update('github.copilot.chat.otel.otlpEndpoint', 'http://127.0.0.1:4318', vscode.ConfigurationTarget.Global);
        output.appendLine('[Telemetry] Enabled Copilot Chat OTLP export in user settings.');
    } catch (error) {
        output.appendLine(`[Telemetry] Could not update Copilot Chat settings: ${String(error)}`);
        vscode.window.showWarningMessage('Could not enable Copilot Chat telemetry. Check the Copilot Chat OTel settings.');
    }
}

export function activate(context: vscode.ExtensionContext) {

    const output = vscode.window.createOutputChannel(
        'Copilot Credit Tracker'
    );

    output.appendLine('========================================');
    output.appendLine('COPILOT CREDIT TRACKER ACTIVATED');
    output.appendLine('========================================');

    const configuration = vscode.workspace.getConfiguration('copilot-credit-tracker');
    const backendUrl = configuration.get<string>('backendUrl', 'http://127.0.0.1:8000').replace(/\/$/, '');
    const port = configuration.get<number>('otelPort', 4318);
    const usageView = new UsageViewProvider(context, backendUrl, output);
    const pendingUsage = new Map<string, Promise<boolean>>();
    const acceptedUsage = new Set<string>();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(viewId, usageView),
    );

    server = http.createServer((req, res) => {

        const chunks: Buffer[] = [];

        req.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
        });

        req.on('end', () => {

            const body = Buffer.concat(chunks);

            if (req.url !== '/v1/traces' || req.method !== 'POST') {
                res.writeHead(404);
                res.end();
                return;
            }

            try {
                const payload = JSON.parse(body.toString('utf8')) as TelemetryPayload;

                const resourceSpans =
                    payload.resourceSpans ?? [];

                for (const resourceSpan of resourceSpans) {

                    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {

                        for (const span of scopeSpan.spans ?? []) {

                            const attributes: Record<string, string | number | boolean | undefined> = {};

                            for (const attr of span.attributes ?? []) {
                                attributes[attr.key] = attributeValue(attr);
                            }

                            const nanoAiu =
                                attributes[
                                'copilot_chat.copilot_usage_nano_aiu'
                                ];

                            // Ignore spans that don't contain AIU
                            if (nanoAiu === undefined || nanoAiu === null) {
                                continue;
                            }

                            const nanoAiuNumber = Number(nanoAiu);

                            // Ignore zero-credit operations
                            if (nanoAiuNumber <= 0) {
                                continue;
                            }

                            const responseId = attributes['gen_ai.response.id'];
                            const conversationId = attributes['gen_ai.conversation.id'];
                            const userId = usageView.registeredUserId;
                            const featureId = usageView.selectedFeatureId;

                            if (!responseId || !userId || !featureId) {
                                output.appendLine('[Usage] Skipped event: response ID, registration, or feature selection is missing.');
                                continue;
                            }

                            const usage = {
                                conversion_id: String(conversationId ?? responseId),
                                response_id: String(responseId),
                                conversation_id: conversationId ? String(conversationId) : null,
                                server_request_id: attributes['copilot_chat.server_request_id']
                                    ? String(attributes['copilot_chat.server_request_id'])
                                    : null,
                                user_id: userId,
                                feature_id: featureId,
                                model: String(
                                    attributes['gen_ai.response.model'] ??
                                    attributes['gen_ai.request.model'] ??
                                    'unknown',
                                ),
                                input_tokens: Number(attributes['gen_ai.usage.input_tokens'] ?? 0),
                                output_tokens: Number(attributes['gen_ai.usage.output_tokens'] ?? 0),
                                nano_aiu: nanoAiuNumber,
                            };

                            const usageKey = JSON.stringify([usage.conversion_id, usage.response_id]);
                            if (!acceptedUsage.has(usageKey) && !pendingUsage.has(usageKey)) {
                                const posting = postUsageWithRetry(backendUrl, usage, output);
                                pendingUsage.set(usageKey, posting);
                                void posting.then((accepted) => {
                                    if (accepted) {
                                        acceptedUsage.add(usageKey);
                                    }
                                }).finally(() => pendingUsage.delete(usageKey));
                            }
                        }
                    }
                }

            } catch (error) {
                output.appendLine(
                    `[TRACES] Failed to parse: ${error}`
                );
                res.writeHead(400);
                res.end('Invalid OTLP trace payload');
                return;
            }

            res.writeHead(200);
            res.end();
        });
    });

    const onListening = () => {
        if (listenerRetryTimer) {
            clearInterval(listenerRetryTimer);
            listenerRetryTimer = undefined;
        }
        output.appendLine(`[OTel] Listening on http://127.0.0.1:${port}`);
    };

    server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
            if (!listenerRetryTimer) {
                output.appendLine(`[OTel] Shared listener already active on http://127.0.0.1:${port} in another VS Code window.`);
                listenerRetryTimer = setInterval(() => {
                    server?.listen(port, '127.0.0.1', onListening);
                }, 5000);
            }
            return;
        }
        output.appendLine(`[OTel] Listener error: ${String(error)}`);
        vscode.window.showErrorMessage(`Copilot Credit Tracker could not listen on port ${port}.`);
    });

    server.listen(port, '127.0.0.1', onListening);

    void configureCopilotTelemetry(output);

    context.subscriptions.push(output);

    context.subscriptions.push({
        dispose: () => {
            if (listenerRetryTimer) {
                clearInterval(listenerRetryTimer);
                listenerRetryTimer = undefined;
            }
            if (server?.listening) {
                server.close();
            }
        }
    });

    vscode.window.showInformationMessage(
        'Copilot Credit Tracker activated!'
    );
}

export function deactivate() {
    if (listenerRetryTimer) {
        clearInterval(listenerRetryTimer);
        listenerRetryTimer = undefined;
    }
    if (server?.listening) {
        server.close();
    }
}