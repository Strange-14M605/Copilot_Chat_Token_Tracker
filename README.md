# Copilot Credit Tracker

A VS Code extension for collecting local Copilot Chat telemetry and attributing usage to a registered user and feature in a backend service.

## Overview

This extension listens for Copilot Chat OTLP trace payloads on a local port, filters for usage spans that include AIU data, and sends the resulting usage records to a backend API. It also provides a simple webview panel for registering a username and selecting the feature that should receive the attributed usage.

The extension is designed for local tracking workflows where Copilot usage should be assigned to a specific project, team, or business unit rather than just raw usage totals.

## Features

- Enables Copilot Chat OTLP export in VS Code settings
- Listens locally on `127.0.0.1:4318` by default for incoming OTLP trace payloads
- Ignores zero-credit and non-AIU events
- Identifies valid Copilot usage spans and sends them to a backend
- Stores a registered user and selected feature in VS Code global state
- Displays a simple usage attribution UI in the Activity Bar
- Retries backend submissions when the backend is temporarily unavailable

## How it works

1. The extension activates on startup and configures Copilot Chat telemetry export to use OTLP over HTTP.
2. It starts a local HTTP listener on the configured port and waits for `POST /v1/traces` requests.
3. When Copilot emits telemetry spans, the extension extracts relevant attributes such as:
   - `copilot_chat.copilot_usage_nano_aiu`
   - `gen_ai.response.id`
   - `gen_ai.conversation.id`
   - `gen_ai.response.model`
   - token usage values
4. If the span has positive AIU and the user/feature are set, the extension posts the usage record to the configured backend.
5. The Activity Bar panel lets the user register a username and choose a tracking feature.

## Prerequisites

- VS Code 1.138.0 or newer
- GitHub Copilot Chat enabled in VS Code
- A backend service that exposes the required usage endpoints

## Configuration

The extension exposes these settings:

- `copilot-credit-tracker.backendUrl`
  - Default: `http://127.0.0.1:8000`
  - Base URL for the usage backend service
- `copilot-credit-tracker.otelPort`
  - Default: `4318`
  - Local port that receives OTLP trace data

The extension also updates the following Copilot settings automatically:

- `github.copilot.chat.otel.enabled = true`
- `github.copilot.chat.otel.exporterType = "otlp-http"`
- `github.copilot.chat.otel.otlpEndpoint = "http://127.0.0.1:4318"`

## Backend API expectations

This extension expects the backend service to provide endpoints similar to the following:

- `GET /features`
- `GET /pis`
- `POST /user`
- `GET /users`
- `POST /usage`

The payload sent to `/usage` includes fields such as:

- `user_id`
- `feature_id`
- `response_id`
- `conversation_id`
- `conversion_id`
- `model`
- `input_tokens`
- `output_tokens`
- `nano_aiu`

## Usage

1. Install the extension in VS Code.
2. Ensure the backend service is running and reachable.
3. Activate the extension.
4. Open the "Copilot Credit Tracker" view in the Activity Bar.
5. Register a username.
6. Select the feature to attribute usage to.
7. Use Copilot Chat normally; usage events will be captured and sent to the backend.

## Development

### Install dependencies

```bash
npm install
```

### Compile

```bash
npm run compile
```

### Watch mode

```bash
npm run watch
```

### Lint

```bash
npm run lint
```

### Run tests

```bash
npm test
```

## Project structure

```text
.
├── src/
│   ├── extension.ts
│   └── test/
│       └── extension.test.ts
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── CHANGELOG.md
├── README.md
└── vsc-extension-quickstart.md
```

## Notes

- The extension is intentionally focused on local telemetry capture and attribution.
- It retries failed backend writes, but it does not currently provide a full UI for editing users or features beyond registration and selection.
- If the configured OTLP port is already in use by another process, the extension will keep retrying and report the condition in the output log.

## License

This project does not currently declare a license in the package metadata. Check the repository root for any project-specific licensing information before redistribution or publication.
