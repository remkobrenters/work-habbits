"""Wayland device input summaries using Linux evdev; no grabs or root process.

Only aggregate counts leave this module. Device timestamps, scan codes, text and
coordinates are never exported. Access is opt-in through the documented udev rule.
"""

import json
import os
import selectors
import struct
import subprocess
import time
from pathlib import Path

from input_monitor import InputCounter

# Linux input_event (native timeval, type, code, value), linux/input-event-codes.h.
EVENT = struct.Struct('@llHHi')
MEDIA_KEYS = frozenset({113, 114, 115, 152, 163, 164, 165, 166, 200, 201, 207})
SUPER_KEYS = frozenset({125, 126})
PERMISSION_ERROR = 'Input permission needed; choose Enable Wayland input below'


def input_devices(seat: str) -> list[Path]:
    devices = []
    for entry in Path('/sys/class/input').glob('event[0-9]*'):
        try:
            identity = (entry / 'dev').read_text().strip()
            properties = dict(
                line[2:].split('=', 1)
                for line in (Path('/run/udev/data') / f'c{identity}').read_text().splitlines()
                if line.startswith('E:') and '=' in line
            )
            # Match exactly the device classes granted access by our optional rule.
            # Exclude other seats, power switches, joysticks, tablets and touchscreens.
            if properties.get('ID_SEAT', 'seat0') == seat and any(
                properties.get(kind) == '1'
                for kind in ('ID_INPUT_KEYBOARD', 'ID_INPUT_MOUSE', 'ID_INPUT_TOUCHPAD')
            ):
                devices.append(Path('/dev/input') / entry.name)
        except (OSError, ValueError):
            continue
    return sorted(devices)


def loginctl(*args: str) -> str:
    result = subprocess.run(  # noqa: S603 -- fixed binary/arguments, no shell
        ['/usr/bin/loginctl', *args], capture_output=True, text=True, timeout=2, check=True
    )
    return result.stdout.strip()


class LocalSession:
    def __init__(self):
        self.session = os.getenv('XDG_SESSION_ID') or loginctl(
            'show-user', str(os.getuid()), '-p', 'Display', '--value'
        )
        self.seat = ''

    def active(self) -> bool:
        if not self.session:
            return False
        try:
            properties = dict(
                line.split('=', 1)
                for line in loginctl('show-session', self.session).splitlines()
                if '=' in line
            )
            self.seat = properties.get('Seat', '')
            return (
                properties.get('User') == str(os.getuid())
                and properties.get('Active') == 'yes'
                and properties.get('Remote') == 'no'
                and properties.get('Type') == 'wayland'
                and properties.get('LockedHint') == 'no'
                and bool(properties.get('Seat'))
            )
        except (OSError, subprocess.SubprocessError):
            return False


class DeviceEvents:
    def __init__(self, counter: InputCounter):
        self.counter = counter
        self.dropped = False

    def consume(self, data: bytes, monotonic: float, wall: float) -> None:
        if len(data) % EVENT.size:
            raise ValueError('Incomplete input event')
        for offset in range(0, len(data), EVENT.size):
            # Inspect only type/code/value. Do not retain timestamps or coordinates.
            event_type, code, value = EVENT.unpack_from(data, offset)[2:]
            if event_type == 0 and code == 3:  # SYN_DROPPED: lost events; never invent counts.
                self.dropped = True
                continue
            if self.dropped:
                # Reopen all devices to reset modifier state and discard queued events.
                if event_type == 0 and code == 0:
                    raise OSError('Input event queue overflow')
                continue
            if event_type == 1:  # EV_KEY: 0 release, 1 press, 2 auto-repeat.
                if 0 < code < 256 and value in (0, 1, 2):
                    self.counter.consume_event(3 if value == 0 else 2, code, monotonic, wall)
                elif 272 <= code <= 279 and value == 1:  # BTN_LEFT..BTN_TASK.
                    # Use a non-wheel detail: evdev wheels are EV_REL, not buttons 4–7.
                    self.counter.consume_event(4, 1, monotonic, wall)
                elif code == 330 and value == 1:  # BTN_TOUCH: touchpad contact is activity, not a click.
                    self.counter.consume_event(4, 4, monotonic, wall)
            elif event_type == 2 and value:  # EV_REL
                if code in (0, 1):  # REL_X/Y
                    self.counter.consume_event(6, 0, monotonic, wall)
                elif code in (6, 8, 11, 12):  # Wheel, horizontal wheel, and high-resolution variants.
                    self.counter.consume_event(4, 4, monotonic, wall)
            elif event_type == 3 and code in (0, 1, 53, 54):  # ABS_X/Y, ABS_MT_POSITION_X/Y.
                self.counter.consume_event(6, 0, monotonic, wall)
                # Touchpad gestures are interpreted by libinput after evdev. Treat contact
                # motion as activity without pretending it is a compositor click or scroll.
                self.counter.consume_event(4, 4, monotonic, wall)


class DeviceReader:
    def __init__(self, break_seconds: float):
        self.selector = selectors.DefaultSelector()
        self.break_seconds = break_seconds
        self.counter = self._new_counter()
        self.devices: dict[Path, int] = {}
        self.error_code = ''

    def _new_counter(self) -> InputCounter:
        counter = InputCounter(self.break_seconds)
        counter.ignore_shortcuts(media=MEDIA_KEYS, supers=SUPER_KEYS, screen_lock=frozenset({38}))
        return counter

    def close_devices(self) -> None:
        for fd in self.devices.values():
            self.selector.unregister(fd)
            os.close(fd)
        self.devices.clear()
        self.counter = self._new_counter()

    def sync(self, seat: str) -> bool:
        paths = input_devices(seat)
        self.error_code = '' if paths else 'input-unavailable'
        # Reopen on topology changes; no stale modifier state from an unplugged keyboard.
        if set(paths) != set(self.devices):
            self.close_devices()
        try:
            for path in paths:
                if path not in self.devices:
                    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW)
                    self.devices[path] = fd
                    self.selector.register(fd, selectors.EVENT_READ, DeviceEvents(self.counter))
            # Never report partial device coverage as full input availability.
            return bool(paths)
        except OSError as error:
            self.close_devices()
            self.error_code = (
                'input-permission' if isinstance(error, PermissionError) else 'input-unavailable'
            )
            return False

    def poll(self, timeout: float) -> None:
        for key, _mask in self.selector.select(timeout):
            data = os.read(key.fd, EVENT.size * 64)
            if not data:
                raise OSError('Input device disconnected')
            key.data.consume(data, time.monotonic(), time.time())

    def close(self) -> None:
        self.close_devices()
        self.selector.close()


def run(break_seconds: float) -> int:
    if os.getenv('XDG_SESSION_TYPE') != 'wayland' or os.getuid() == 0:
        print(
            json.dumps({'ready': False, 'error': 'Run from your local Wayland desktop, without sudo'}),
            flush=True,
        )
        return 1
    try:
        session = LocalSession()
    except (OSError, subprocess.SubprocessError):
        print(json.dumps({'ready': False, 'error': 'Cannot verify the local Wayland session'}), flush=True)
        return 1
    reader = DeviceReader(break_seconds)
    try:
        while True:
            active = session.active()
            ready = active and reader.sync(session.seat)
            if not ready:
                reader.close_devices()
            deadline = time.monotonic() + 1
            try:
                while time.monotonic() < deadline:
                    reader.poll(max(0, deadline - time.monotonic()))
            except (OSError, ValueError):
                reader.close_devices()
                reader.error_code = 'input-unavailable'
                ready = False
            # Check again before publishing: never leak queued lock/TTY input to GNOME.
            active = session.active()
            if not active:
                reader.close_devices()
                ready = False
            batch = reader.counter.snapshot(ready=ready)
            if not ready:
                batch['errorCode'] = reader.error_code if active else 'session-inactive'
                batch['error'] = (
                    'Waiting for the unlocked local Wayland session'
                    if not active
                    else (
                        PERMISSION_ERROR
                        if reader.error_code == 'input-permission'
                        else 'Wayland input devices unavailable; retrying'
                    )
                )
            print(json.dumps(batch), flush=True)
    finally:
        reader.close()
