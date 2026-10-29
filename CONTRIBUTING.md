# Contributing

Keep the scope small: posture, movement breaks, input counts, and their configuration. Prefer standard libraries and a few direct dependencies. Keep raw input content out of storage and logs. Bluetooth remains opt-in and every move requires an explicit action. Submit a pull request with fixes, improvements, or compatibility results, including the GNOME version and session type.

## Checks

The baseline test environment is Ubuntu 24.04, GNOME 46, Python 3.12. Runtime requires Python 3.11+. Node.js 18+ is only a development tool.

```bash
sudo apt install python3-venv python3-gi gir1.2-adw-1 gjs gnome-shell-common libglib2.0-bin nodejs shellcheck
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
make check
make audit
```

`make check` runs Ruff style/format/security rules, ShellCheck, JavaScript/Python syntax checks, strict schemas, behavioral tests, actual install/uninstall in an isolated temporary home, and GJS settings/persistence checks. Dashboard tests exercise the real rendering methods with mock GNOME actors, for both orientation/color API variants. `make audit` scans runtime and development requirements, including resolved transitive dependencies, using current advisories. Failed dependency collection also fails the audit; internet access is required.

Tests must not read personal history/input, alter desktop settings, contact real Bluetooth hardware, or move a real desk. Use real model instances and mock external I/O. Cover idle/rest boundaries, lock/remote gating, pause/resume, invalid commands, cancellation/STOP, stalled writes, corruption, and failed-save retries. Use a focused test during edits, then run the full checks before submitting. Socket integration skips only when the runtime prohibits Unix sockets; the command handler also has in-memory tests. System Python separately runs installer tests for GI bindings.

The dashboard test uses Node's built-in VM modules (`--experimental-vm-modules`) to load the real UI against mock GNOME I/O. It does not replace a live visual check. State which desktop/hardware checks ran and which remain unverified. Expected compatibility from API documentation must not be called tested compatibility.

`extension.js` owns UI/session lifecycle; `logic.js` and `history.js` hold portable logic; `storage.js` persists records. `input_monitor.py` produces X11 summaries. `desk_service.py` observes settings and owns the optional `desk_monitor.py` child. GI comes from system Python; Python package dependencies stay in the app environment.

## Screenshots

Keep screenshots in `docs/screenshots/`: `metrics-light.png` and `metrics-dark.png` show the dashboard, and `posture-*.png` show panel reminder states. Capture only the menu or panel indicators, without unrelated windows, notifications, or private information. Review images before committing them, use descriptive filenames for additional views, and update the README's relative image links.

Do not add broken image links or present rendered mockups as actual screenshots.

## Publishing on GitHub

Run `make check`, `make audit`, and a live desktop check. Use `make dist` for a clean `dist/work-habbits-source.zip`: an allowlist includes only project source/docs/tests, excludes caches and environment files, and omits owner/path metadata. The archive is generated output and is not committed.

Create a repository named `work-habbits` from the public sources. Inspect staged files and diffs before pushing. `.gitignore` excludes local dotfiles, environments, caches, runtime data, private keys, and distributions. Keep the MIT license and security policy. Keep the README screenshots current with the UI.

The workflow has **Quality** and **Dependency security** checks. It uses read-only repository permissions, a commit-pinned checkout action, no stored Git credentials, no secrets, and `pull_request` rather than privileged PR events. It runs on pushes, PRs, weekly, and manually. The security job scans direct/transitive runtime and development dependencies. Dependabot checks Python packages and Actions weekly. No job publishes or deploys automatically.

After the first green workflow run, create a branch ruleset requiring **Quality** and **Dependency security**, require pull requests, and block force pushes. Enable Dependabot alerts, secret scanning/push protection where available, and private vulnerability reporting. These repository settings must be applied on GitHub; workflow files cannot enforce them.

Before calling a release ready, confirm both jobs are green, screenshots contain only sample data, and manual posture/input/pause checks work on the tested desktop. Bluetooth changes additionally need a supervised hardware check. An unavailable audit is not a passing audit, and an expected setup is not a tested setup.
