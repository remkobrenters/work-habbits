# Security

Report vulnerabilities using **Security → Report a vulnerability** on this GitHub repository once private vulnerability reporting is enabled. Do not include credentials, raw input events, personal daily history, or nearby Bluetooth addresses in public issues. If private reporting is unavailable, open an issue asking for a private contact without disclosing exploit details.

Only the current version is maintained. Runtime dependencies are pinned. CI audits runtime and development packages, including transitive dependencies, on pull requests and weekly; updates still need review and testing.

The trusted boundary is your local desktop user account. This application can observe X11 device events and, when explicitly configured, control a compatible desk. Aggregates stay local. There are no remote control endpoints, HTTP clients, account credentials, or telemetry. The Bluetooth socket and status files are private to the owning user. Programs already running as that user are trusted.

Check a proposed Bluetooth change for unintended motion, broad device discovery/connection, timeout/cancellation paths, and preserving STOP behavior. Validate hardware compatibility and keep a physical stop control available. See README.md for protocol limits and disconnect behavior.
