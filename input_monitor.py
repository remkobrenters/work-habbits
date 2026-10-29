#!/usr/bin/env python3
"""Count local X11 input, emitting only anonymous one-second summaries to GNOME.

GNOME owns this process and discards summaries outside the active local desktop session.
Keycodes are only compared with the media keys and Super+L, which are not hand work.
No keycode, text, window title or pointer coordinate is written.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import threading
import time

# A hand break: this long without input. The extension passes its own setting
# (inputResetIdle) with --break-seconds.
BREAK_SECONDS = 120

# Keys that are not hand work, so pausing the music and locking the screen on the way out
# keep a hand break running. X11 keysyms: XF86AudioLowerVolume, Mute, RaiseVolume, Play,
# Stop, Prev, Next, Pause; Super_L, Super_R; and l, as in Super+L.
MEDIA_KEYSYMS = (
    0x1008FF11,
    0x1008FF12,
    0x1008FF13,
    0x1008FF14,
    0x1008FF15,
    0x1008FF16,
    0x1008FF17,
    0x1008FF31,
)
SUPER_KEYSYMS = (0xFFEB, 0xFFEC)
SCREEN_LOCK_KEYSYM = 0x6C


def shortcut_keycodes(connection) -> dict:
    def keycodes(*keysyms: int) -> frozenset:
        return frozenset(code for keysym in keysyms for code, _ in connection.keysym_to_keycodes(keysym))

    return dict(
        media=keycodes(*MEDIA_KEYSYMS),
        supers=keycodes(*SUPER_KEYSYMS),
        screen_lock=keycodes(SCREEN_LOCK_KEYSYM),
    )


class InputCounter:
    def __init__(self, break_seconds: float = BREAK_SECONDS) -> None:
        self._break_seconds = break_seconds
        self._lock = threading.Lock()
        self._counts = dict(keys=0, clicks=0, moves=0)
        self._last_input = 0.0
        self._last_wall = 0.0
        self._last_motion = float('-inf')
        self._had_break = False
        self._media = self._supers = self._screen_lock = frozenset()
        self._supers_down: set[int] = set()

    def ignore_shortcuts(self, *, media: frozenset, supers: frozenset, screen_lock: frozenset) -> None:
        with self._lock:
            self._media, self._supers, self._screen_lock = media, supers, screen_lock

    def consume(self, data: bytes, monotonic: float, wall: float) -> None:
        # X11 core device events occupy 32 bytes. Inspect event type and detail: the mouse button
        # number, or a keycode compared only with the shortcut keys. Leave coordinates opaque.
        # Ignore incomplete frames.
        with self._lock:
            for offset in range(0, len(data) - 31, 32):
                event_type, detail = data[offset], data[offset + 1]
                if event_type in (2, 3) and detail in self._supers:
                    # Super is a shortcut modifier, not typing; while it is held, L locks the screen.
                    if event_type == 2:
                        self._supers_down.add(detail)
                    else:
                        self._supers_down.discard(detail)
                    continue
                if event_type == 2 and (
                    detail in self._media or (self._supers_down and detail in self._screen_lock)
                ):
                    continue
                if event_type == 6:
                    # Pointer motion alone is not hand work: sampled for the daily count only.
                    if monotonic - self._last_motion >= 0.2:
                        self._counts['moves'] += 1
                        self._last_motion = monotonic
                    continue
                if event_type not in (2, 4):  # KeyPress, ButtonPress
                    continue
                if self._last_input and monotonic - self._last_input >= self._break_seconds:
                    self._had_break = True
                self._last_input = monotonic
                self._last_wall = wall
                if event_type == 2:
                    self._counts['keys'] += 1
                # Wheel steps are activity but are not mouse clicks.
                elif detail not in (4, 5, 6, 7):
                    self._counts['clicks'] += 1

    def snapshot(self, *, ready: bool) -> dict:
        with self._lock:
            snapshot = {
                **self._counts,
                'lastInputWallMs': self._last_wall * 1000,
                'hadBreak': self._had_break,
                'ready': ready,
                'heartbeat': time.time(),
            }
            self._counts = dict(keys=0, clicks=0, moves=0)
            self._had_break = False
            return snapshot


def local_display(value: str) -> bool:
    # Never use an SSH-forwarded DISPLAY (e.g. localhost:10.0) or a TCP host.
    return re.fullmatch(r':\d+(?:\.\d+)?', value) is not None


def main() -> int:
    parser = argparse.ArgumentParser(description='Anonymous X11 input summaries for work-habbits')
    parser.add_argument(
        '--break-seconds', type=int, default=BREAK_SECONDS, help='this long without input ends a hand break'
    )
    args = parser.parse_args()
    if not 60 <= args.break_seconds <= 1800:
        parser.error('--break-seconds must be between 60 and 1800')
    if os.environ.get('SSH_CONNECTION') or not local_display(os.getenv('DISPLAY', '')):
        print(json.dumps({'ready': False, 'error': 'A local X11 desktop is required'}), flush=True)
        return 1

    # Lazy imports keep counter tests independent of a running X server/Xlib.
    try:
        from Xlib import display
        from Xlib.ext import record
    except ImportError:
        print(
            json.dumps({'ready': False, 'error': 'Missing python-xlib; run ./install.sh again'}), flush=True
        )
        return 1

    counter = InputCounter(args.break_seconds)
    ready = threading.Event()
    failed = threading.Event()

    def record_input() -> None:
        connection = None
        context = None
        try:
            connection = display.Display()
            if not connection.has_extension('RECORD'):
                raise RuntimeError('X11 RECORD unavailable')
            counter.ignore_shortcuts(**shortcut_keycodes(connection))
            context = connection.record_create_context(
                0,
                [record.AllClients],
                [
                    {
                        'core_requests': (0, 0),
                        'core_replies': (0, 0),
                        'ext_requests': (0, 0, 0, 0),
                        'ext_replies': (0, 0, 0, 0),
                        'delivered_events': (0, 0),
                        'device_events': (2, 6),
                        'errors': (0, 0),
                        'client_started': False,
                        'client_died': False,
                    }
                ],
            )

            def receive(reply) -> None:
                if reply.category == record.StartOfData:
                    ready.set()
                elif reply.category == record.FromServer and not reply.client_swapped:
                    counter.consume(reply.data, time.monotonic(), time.time())

            connection.record_enable_context(context, receive)
        except Exception:
            # A fixed message cannot disclose input event buffers or keycodes.
            logging.error('X11 input recorder failed')
        finally:
            failed.set()
            if connection is not None:
                if context is not None:
                    connection.record_free_context(context)
                connection.close()

    threading.Thread(target=record_input, daemon=True).start()
    while not failed.is_set():
        print(json.dumps(counter.snapshot(ready=ready.is_set())), flush=True)
        failed.wait(1)
    print(
        json.dumps({'ready': False, 'error': 'X11 input reader stopped; check DISPLAY and X11 RECORD'}),
        flush=True,
    )
    return 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        # GNOME exited or disabled the extension; don't leave a background reader.
        os._exit(0)
