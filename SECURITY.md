# Security Policy

## Threat Model

Flashback is a local-only plugin. Its security model is based on the following assumptions and protections:

### Local-only Binding

The web server binds exclusively to `127.0.0.1`. It is not accessible from other machines on the network.

### CSRF Protection

All mutation requests (POST, PUT, DELETE) to the local API require a valid CSRF token. This token is generated per-process and must be included in the `X-CSRF-Token` header. This prevents malicious websites from interacting with your local Flashback instance via your browser.

### DNS Rebinding Protection

The server validates the `Host` header to ensure requests are intended for `localhost` or `127.0.0.1`, mitigating DNS rebinding attacks.

## Data Handling

### Local Storage

All memories, embeddings, and user profiles are stored locally in a SQLite database (`flashback.db`) within the configured storage directory (default: `~/.local/share/opencode-flashback`).

### No Telemetry

Flashback does not include any telemetry, tracking, or "phone home" functionality. Your data never leaves your machine unless you explicitly configure an external LLM provider.

### LLM API Keys

API keys are used only to communicate with your chosen LLM provider for auto-capture and profile learning. We recommend using `env://` or `file://` prefixes in your configuration to avoid storing plain-text keys in your config file.

## Reporting a Vulnerability

If you discover a security vulnerability, please open a GitHub issue or contact the maintainers directly. As this is a local-only tool, the primary risks involve local privilege escalation or cross-site attacks from a browser, which we take seriously.
