PYTHON ?= .venv/bin/python
RUFF ?= .venv/bin/ruff

.PHONY: check lint test audit security-lint dist
check: lint security-lint test

lint:
	$(RUFF) check .
	$(RUFF) format --check .
	bash -n install.sh status.sh uninstall.sh
	shellcheck install.sh status.sh uninstall.sh
	@for file in extension/*.js tests/*.js tests/*.mjs; do node --check "$$file"; done
	glib-compile-schemas --strict --dry-run extension/schemas
	$(PYTHON) -m compileall -q desk_monitor.py desk_service.py input_monitor.py tests scripts

test:
	$(PYTHON) -m unittest discover -s tests -v
	/usr/bin/python3 -m unittest discover -s tests -p test_installer.py -v
	node tests/logic.test.mjs
	node tests/sound.test.mjs
	node --experimental-vm-modules tests/dashboard.test.mjs
	WORK_HABBITS_TEST_ORIENTATION=1 node --experimental-vm-modules tests/dashboard.test.mjs
	TZ=Europe/Berlin node tests/history.test.mjs
	TZ=America/New_York node tests/history.test.mjs
	gjs -m tests/settings.test.js
	gjs -m tests/storage.test.js

audit:
	$(PYTHON) -m pip_audit --strict -r requirements-dev.txt

security-lint:
	$(RUFF) check --select S desk_monitor.py desk_service.py input_monitor.py scripts

dist:
	$(PYTHON) scripts/package.py
