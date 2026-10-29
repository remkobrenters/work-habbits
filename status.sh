#!/usr/bin/env bash
set -u
printf 'work-habbits: user=%s session=%s\n' "$(id -un)" "${XDG_SESSION_TYPE:-unknown}"
gnome-extensions info work-habbits@local
systemctl --user status work-habbits-desk.service --no-pager
python3 - <<'PY'
import json
import os
import time
from datetime import date
from pathlib import Path
runtime = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}'))
try:
    desk = json.loads((runtime / 'work-habbits/desk.json').read_text())
    age = time.time() - desk['heartbeat']
    print(f"Bluetooth: connected={desk['connected']} height={desk['height_cm']} cm heartbeat age={age:.0f}s")
    if age > 20:
        print('Bluetooth status is stale (expected outside Bluetooth mode).')
except (OSError, ValueError, KeyError) as error:
    print(f'Bluetooth status unavailable (expected outside Bluetooth mode): {error}')
state = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'work-habbits/days'
print(f'History: {state}')
today = state / f'{date.today().isoformat()}.json'
if today.exists():
    print(today.read_text())
else:
    print('No daily summary yet. Allow 30 seconds in an unlocked local session.')
PY
printf '\nRecent logs:\n'
journalctl --user -b --no-pager -g 'work-habbits' -n 15
