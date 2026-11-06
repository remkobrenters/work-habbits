#!/usr/bin/env python3
"""Apply the fixed, opt-in input access rule after pkexec authorization.

This standalone helper accepts no paths or rule contents. It uses only the Python
standard library and is launched with Python isolated mode. It never reads input.
"""

import argparse
import os
import subprocess
import tempfile
from pathlib import Path

RULE_PATH = Path('/etc/udev/rules.d/70-work-habbits-input.rules')
RULE = b"""# Optional Wayland counts: grant the active local seat user access to keyboards,
# mice and touchpads. This also lets other programs of that user read these devices.
# Install before 73-seat-late.rules, which applies the uaccess ACLs.
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_KEYBOARD}=="1", TAG+="uaccess"
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_MOUSE}=="1", TAG+="uaccess"
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TOUCHPAD}=="1", TAG+="uaccess"
"""


def enable_input() -> None:
    if RULE_PATH.is_symlink():
        raise ValueError('Refusing to replace a symlink')
    try:
        existing = RULE_PATH.read_bytes()
    except FileNotFoundError:
        existing = None
    if existing is not None and existing != RULE:
        raise ValueError('Refusing to replace a different rule')
    if existing is None:
        fd, name = tempfile.mkstemp(prefix='.work-habbits-', dir=RULE_PATH.parent)
        temporary = Path(name)
        try:
            with os.fdopen(fd, 'wb') as output:
                os.fchmod(output.fileno(), 0o644)
                output.write(RULE)
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(RULE_PATH)
        finally:
            temporary.unlink(missing_ok=True)
    # Apply ACLs to current devices too, so no logout or reboot is needed.
    for arguments in (
        ['control', '--reload-rules'],
        ['trigger', '--action=change', '--subsystem-match=input'],
        ['settle', '--timeout=10'],
    ):
        subprocess.run(  # noqa: S603 -- fixed binary and arguments; no shell
            ['/usr/bin/udevadm', *arguments],
            check=True,
            timeout=15,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description='Enable work-habbits Wayland input access')
    parser.add_argument('--enable', action='store_true', required=True)
    parser.parse_args()
    if os.geteuid() != 0:
        print('Administrator approval is required; use Enable Wayland input in the panel menu.')
        return 1
    try:
        enable_input()
    except (OSError, ValueError, subprocess.SubprocessError):
        print('Could not enable Wayland input access; check the existing rule and udev service.')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
