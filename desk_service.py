#!/usr/bin/env python3
"""Run the optional Bluetooth helper only while its GNOME setting is enabled."""

import logging
import re
import signal
import subprocess
from pathlib import Path


def bluetooth_device(settings) -> str | None:
    address = settings.get_string('desk-device').upper()
    if (
        settings.get_boolean('tracking-enabled')
        and settings.get_string('desk-mode') == 'bluetooth'
        and re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', address)
    ):
        return address
    return None


class DeskService:
    def __init__(self, settings, app_dir: Path):
        self.settings = settings
        self.app_dir = app_dir
        self.process = None
        self.device = None

    def stop(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
        self.device = None

    def sync(self, *_args):
        device = bluetooth_device(self.settings)
        if device != self.device or (self.process and self.process.poll() is not None):
            self.stop()
        if device and not self.process:
            python = self.app_dir / '.venv/bin/python'
            try:
                self.process = subprocess.Popen(  # noqa: S603 -- fixed argv, validated address, no shell
                    [str(python), str(self.app_dir / 'desk_monitor.py'), '--device', device]
                )
                self.device = device
            except OSError as error:
                logging.error('Bluetooth helper unavailable: %s', error)
        return True


def main():
    # System Python provides GNOME bindings; Bluetooth dependencies stay in the app venv.
    from gi.repository import Gio, GLib

    app_dir = Path(__file__).resolve().parent
    source = Gio.SettingsSchemaSource.new_from_directory(
        str(app_dir / 'schemas'), Gio.SettingsSchemaSource.get_default(), False
    )
    schema = source.lookup('org.gnome.shell.extensions.work-habbits', False)
    settings = Gio.Settings.new_full(schema, None, None)
    service = DeskService(settings, app_dir)
    settings.connect('changed', service.sync)
    loop = GLib.MainLoop()

    def stop_loop():
        loop.quit()
        return GLib.SOURCE_REMOVE

    for sig in (signal.SIGINT, signal.SIGTERM):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, stop_loop)
    GLib.timeout_add_seconds(15, service.sync)
    service.sync()
    try:
        loop.run()
    finally:
        service.stop()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    main()
