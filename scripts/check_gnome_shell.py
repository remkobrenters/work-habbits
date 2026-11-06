#!/usr/bin/env python3
"""Exercise the real GNOME 50+ Shell with private state and generated input.

The separate headless compositor and D-Bus session never replace the user's Shell.
The fixture helper cannot read input devices or control a Bluetooth desk.
"""

import json
import os
import shutil
import signal
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = """import json, os, time
from pathlib import Path
while True:
    ready = Path(os.environ['WORK_HABBITS_TEST_INPUT_STATE']).exists()
    batch = dict(ready=ready, heartbeat=time.time(), keys=int(ready), clicks=0,
                 moves=0, lastInputWallMs=time.time() * 1000 if ready else 0)
    if not ready:
        batch.update(errorCode='input-permission', error='Generated permission failure')
    print(json.dumps(batch), flush=True)
    time.sleep(0.2)
"""


def main() -> int:
    tool = shutil.which('gnome-shell-test-tool')
    if not tool:
        raise SystemExit('GNOME 50+ gnome-shell-test-tool is required')
    with tempfile.TemporaryDirectory(prefix='work-habbits-shell-') as directory:
        private = Path(directory)
        home = private / 'home'
        runtime = private / 'runtime'
        runtime.mkdir(mode=0o700)
        app = home / '.local/share/work-habbits'
        app.mkdir(parents=True)
        (app / 'input_monitor.py').write_text(HELPER)
        extension = private / 'extension'
        shutil.copytree(ROOT / 'extension', extension)
        subprocess.run(  # noqa: S603 -- fixed developer-tool argv, no shell
            ['/usr/bin/glib-compile-schemas', '--strict', str(extension / 'schemas')], check=True
        )
        package = private / 'extension.zip'
        with zipfile.ZipFile(package, 'w') as archive:
            for file in extension.rglob('*'):
                if file.is_file():
                    archive.write(file, file.relative_to(extension))
        result = private / 'result.json'
        environment = {
            **os.environ,
            'HOME': str(home),
            'XDG_STATE_HOME': str(private / 'state'),
            'XDG_RUNTIME_DIR': str(runtime),
            'XDG_DATA_DIRS': '/usr/local/share:/usr/share',
            'XDG_CONFIG_DIRS': '/etc/xdg',
            'GNOME_SHELL_SESSION_MODE': 'user',
            'XDG_CURRENT_DESKTOP': 'GNOME',
            'XDG_SESSION_TYPE': 'wayland',
            'LIBGL_ALWAYS_SOFTWARE': '1',
            'WORK_HABBITS_TEST_RESULT': str(result),
            'WORK_HABBITS_TEST_INPUT_STATE': str(private / 'input-ready'),
        }
        for name in (
            'DISPLAY',
            'WAYLAND_DISPLAY',
            'GNOME_SETUP_DISPLAY',
            'DBUS_SESSION_BUS_ADDRESS',
            'DBUS_STARTER_ADDRESS',
            'DBUS_STARTER_BUS_TYPE',
            'XDG_SESSION_ID',
        ):
            environment.pop(name, None)
        process = subprocess.Popen(  # noqa: S603 -- fixed developer-tool argv, private test environment
            [
                '/usr/bin/dbus-run-session',
                '--',
                tool,
                '--headless',
                '--disable-animations',
                '--extension',
                str(package),
                str(ROOT / 'tests/gnome-shell.test.js'),
            ],
            env=environment,
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            output, _ = process.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
        with tempfile.NamedTemporaryFile(
            prefix='work-habbits-gnome-', suffix='.log', mode='w', delete=False
        ) as log:
            log.write(output)
        if process.returncode or not result.exists():
            print('\n'.join(output.splitlines()[-45:]))
            print(f'GNOME Shell check failed; full log: {log.name}')
            return 1
        report = json.loads(result.read_text())
        if report.get('passed') is not True:
            return 1
        print(
            f'GNOME Shell check passed: native UI, permission explanation, generated input, posture and pause ({report["generatedKeys"]} generated keys)'
        )
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
