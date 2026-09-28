import * as vscode from 'vscode';
import * as http from 'http';

let server: http.Server | undefined;

export function activate(context: vscode.ExtensionContext) {

    const output = vscode.window.createOutputChannel(
        'Copilot Credit Tracker'
    );

    output.appendLine('========================================');
    output.appendLine('COPILOT CREDIT TRACKER ACTIVATED');
    output.appendLine('========================================');

    const port = 4318;

    server = http.createServer((req, res) => {

        const chunks: Buffer[] = [];

        req.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
        });

        req.on('end', () => {

            const body = Buffer.concat(chunks);

            // Ignore everything except traces
            if (req.url !== '/v1/traces') {
                res.writeHead(200);
                res.end();
                return;
            }

            try {

                const payload = JSON.parse(body.toString('utf8'));

                const resourceSpans =
                    payload.resourceSpans ?? [];

                for (const resourceSpan of resourceSpans) {

                    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {

                        for (const span of scopeSpan.spans ?? []) {

                            const attributes: Record<string, any> = {};

                            for (const attr of span.attributes ?? []) {

                                const value = attr.value;

                                attributes[attr.key] =
                                    value.stringValue ??
                                    value.intValue ??
                                    value.doubleValue ??
                                    value.boolValue ??
                                    value.arrayValue ??
                                    null;
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

                            const aiCredits =
                                nanoAiuNumber / 1_000_000_000;

                            const usage = {

                                model:
                                    attributes['gen_ai.response.model'] ??
                                    attributes['gen_ai.request.model'] ??
                                    'unknown',

                                input_tokens:
                                    Number(
                                        attributes[
                                        'gen_ai.usage.input_tokens'
                                        ] ?? 0
                                    ),

                                output_tokens:
                                    Number(
                                        attributes[
                                        'gen_ai.usage.output_tokens'
                                        ] ?? 0
                                    ),

                                nano_aiu: nanoAiuNumber,

                                ai_credits: aiCredits,

                                response_id:
                                    attributes[
                                    'gen_ai.response.id'
                                    ] ?? null,

                                server_request_id:
                                    attributes[
                                    'copilot_chat.server_request_id'
                                    ] ?? null,

                                conversation_id:
                                    attributes[
                                    'gen_ai.conversation.id'
                                    ] ?? null
                            };

                            output.appendLine(
                                `[USAGE] ${JSON.stringify(usage)}`
                            );
                        }
                    }
                }

            } catch (error) {

                output.appendLine(
                    `[TRACES] Failed to parse: ${error}`
                );
            }

            res.writeHead(200);
            res.end();
        });
    });

    server.listen(port, '127.0.0.1', () => {

        output.appendLine(
            `[OTel] Listening on http://127.0.0.1:${port}`
        );

    });

    context.subscriptions.push(output);

    context.subscriptions.push({
        dispose: () => {
            server?.close();
        }
    });

    vscode.window.showInformationMessage(
        'Copilot Credit Tracker activated!'
    );
}

export function deactivate() {
    server?.close();
}
