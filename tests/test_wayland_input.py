import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from wayland_input import EVENT, DeviceEvents, DeviceReader, LocalSession, input_devices


def event(kind, code, value):
    return EVENT.pack(123, 456, kind, code, value)


class WaylandCounterTests(unittest.TestCase):
    def setUp(self):
        self.reader = DeviceReader(120)
        self.addCleanup(self.reader.close)
        self.events = DeviceEvents(self.reader.counter)

    def test_presses_repeats_buttons_and_scroll_feed_the_existing_model(self):
        self.events.consume(
            event(1, 30, 1)
            + event(1, 30, 2)
            + event(1, 30, 0)
            + event(1, 272, 1)
            + event(1, 272, 0)
            + event(1, 275, 1)
            + event(2, 8, -1)
            + event(2, 11, 120),
            1,
            1000,
        )
        batch = self.reader.counter.snapshot(ready=True)
        self.assertEqual((batch['keys'], batch['clicks'], batch['moves']), (2, 2, 0))
        self.assertEqual(batch['lastInputWallMs'], 1000000)
        self.assertEqual(self.reader.counter.snapshot(ready=True)['keys'], 0)

    def test_motion_is_sampled_and_does_not_end_hand_rest(self):
        self.events.consume(event(1, 30, 1), 1, 1000)
        self.reader.counter.snapshot(ready=True)
        self.events.consume(event(2, 0, 150) + event(2, 1, -90), 100, 1099)
        self.events.consume(event(2, 0, 1), 100.1, 1099.1)
        self.events.consume(event(2, 0, 1), 100.3, 1099.3)
        batch = self.reader.counter.snapshot(ready=True)
        self.assertEqual((batch['moves'], batch['lastInputWallMs']), (2, 1000000))
        self.events.consume(event(1, 30, 1), 121, 1120)
        self.assertTrue(self.reader.counter.snapshot(ready=True)['hadBreak'])

    def test_media_keys_super_l_and_touchpad_contacts(self):
        self.events.consume(
            event(1, 164, 1)
            + event(1, 115, 1)
            + event(1, 125, 1)
            + event(1, 38, 1)
            + event(1, 38, 0)
            + event(1, 125, 0),
            1,
            1000,
        )
        batch = self.reader.counter.snapshot(ready=True)
        self.assertEqual((batch['keys'], batch['lastInputWallMs']), (0, 0))
        self.events.consume(event(1, 38, 1) + event(1, 330, 1) + event(3, 53, 234), 2, 1001)
        batch = self.reader.counter.snapshot(ready=True)
        self.assertEqual((batch['keys'], batch['clicks'], batch['moves']), (1, 0, 1))
        self.assertEqual(batch['lastInputWallMs'], 1001000)

    def test_device_buffers_never_appear_in_a_summary(self):
        self.events.consume(event(1, 30, 1) + event(2, 0, 12345) + event(4, 4, 67890), 1, 1000)
        batch = self.reader.counter.snapshot(ready=True)
        self.assertEqual(
            set(batch), {'keys', 'clicks', 'moves', 'lastInputWallMs', 'hadBreak', 'ready', 'heartbeat'}
        )
        self.assertNotIn('12345', str(batch))
        self.assertNotIn('67890', str(batch))

    def test_lost_events_and_partial_frames_fail_instead_of_inventing_counts(self):
        self.events.consume(event(0, 3, 0) + event(1, 30, 1), 1, 1000)
        self.assertEqual(self.reader.counter.snapshot(ready=True)['keys'], 0)
        with self.assertRaises(OSError):
            self.events.consume(event(0, 0, 0), 2, 1001)
        with self.assertRaises(ValueError):
            self.events.consume(b'partial', 2, 1001)

    def test_permission_failure_closes_partial_coverage_and_retries(self):
        devices = [Path('/dev/input/event1'), Path('/dev/input/event2')]
        with (
            patch('wayland_input.input_devices', return_value=devices),
            patch('wayland_input.os.open', side_effect=[10, PermissionError(), 11, 12]) as opened,
            patch('wayland_input.os.close') as closed,
            patch.object(self.reader, 'selector') as selector,
        ):
            self.assertFalse(self.reader.sync('seat0'))
            self.assertEqual(self.reader.error_code, 'input-permission')
            closed.assert_called_once_with(10)
            self.assertFalse(self.reader.devices)
            self.assertTrue(self.reader.sync('seat0'))
            self.assertEqual(self.reader.error_code, '')
            self.assertEqual(set(self.reader.devices.values()), {11, 12})
            self.assertEqual(opened.call_count, 4)
            selector.unregister.assert_called_once_with(10)
            self.reader.close_devices()

    def test_hotplug_clears_stale_modifier_state_and_handles_new_devices(self):
        first, second = Path('/dev/input/event1'), Path('/dev/input/event2')
        with (
            patch('wayland_input.input_devices', side_effect=[[first], [first, second], []]),
            patch('wayland_input.os.open', side_effect=[10, 11, 12]),
            patch('wayland_input.os.close') as closed,
            patch.object(self.reader, 'selector'),
        ):
            self.assertTrue(self.reader.sync('seat0'))
            self.reader.counter.consume_event(2, 125, 1, 1000)
            self.assertTrue(self.reader.sync('seat0'))
            self.reader.counter.consume_event(2, 38, 2, 1001)
            self.assertEqual(self.reader.counter.snapshot(ready=True)['keys'], 1)
            self.assertFalse(self.reader.sync('seat0'))
            self.assertEqual(self.reader.error_code, 'input-unavailable')
            self.assertEqual(closed.call_count, 3)

    def test_poll_decodes_a_real_stream_and_detects_device_removal(self):
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, write_fd)
        self.reader.devices[Path('/dev/input/event1')] = read_fd
        self.reader.selector.register(read_fd, 1, self.events)
        os.write(write_fd, event(1, 30, 1) + event(1, 272, 1))
        self.reader.poll(0)
        batch = self.reader.counter.snapshot(ready=True)
        self.assertEqual((batch['keys'], batch['clicks']), (1, 1))
        with patch('wayland_input.os.read', return_value=b''):
            os.write(write_fd, event(1, 30, 1))
            with self.assertRaises(OSError):
                self.reader.poll(0)


class WaylandSessionTests(unittest.TestCase):
    def properties(self, **overrides):
        values = dict(
            User=str(os.getuid()), Active='yes', Remote='no', Type='wayland', LockedHint='no', Seat='seat0'
        )
        values.update(overrides)
        return '\n'.join(f'{key}={value}' for key, value in values.items())

    def test_only_own_active_unlocked_local_wayland_session_can_open_devices(self):
        with patch.dict(os.environ, {'XDG_SESSION_ID': 'test'}):
            session = LocalSession()
        for properties, expected in [
            ({}, True),
            ({'Active': 'no'}, False),
            ({'Remote': 'yes'}, False),
            ({'Type': 'tty'}, False),
            ({'LockedHint': 'yes'}, False),
            ({'LockedHint': ''}, False),
            ({'Seat': ''}, False),
            ({'User': '-1'}, False),
        ]:
            with (
                self.subTest(properties=properties),
                patch('wayland_input.loginctl', return_value=self.properties(**properties)),
            ):
                self.assertEqual(session.active(), expected)
        with patch('wayland_input.loginctl', side_effect=subprocess.TimeoutExpired('loginctl', 2)):
            self.assertFalse(session.active())

    def test_systemd_launched_shell_can_resolve_the_display_session(self):
        with (
            patch.dict(os.environ, {'XDG_SESSION_ID': ''}),
            patch('wayland_input.loginctl', return_value='3') as query,
        ):
            self.assertEqual(LocalSession().session, '3')
            query.assert_called_once_with('show-user', str(os.getuid()), '-p', 'Display', '--value')

    def test_lock_during_collection_discards_the_entire_batch_and_closes_devices(self):
        from wayland_input import run

        with (
            patch.dict(os.environ, {'XDG_SESSION_TYPE': 'wayland'}),
            patch('wayland_input.os.getuid', return_value=1000),
            patch('wayland_input.LocalSession') as session,
            patch('wayland_input.DeviceReader') as reader,
            patch('wayland_input.time.monotonic', side_effect=[0, 2]),
            patch('builtins.print', side_effect=BrokenPipeError),
        ):
            session.return_value.active.side_effect = [True, False]
            reader.return_value.counter.snapshot.return_value = {'ready': False}
            with self.assertRaises(BrokenPipeError):
                run(120)
            reader.return_value.close_devices.assert_called_once()
            reader.return_value.counter.snapshot.assert_called_once_with(ready=False)
            reader.return_value.close.assert_called_once()

    def test_remote_and_xwayland_launches_never_open_input_devices(self):
        from input_monitor import main

        for backend, environment in [
            ('evdev', {'SSH_CONNECTION': 'remote', 'XDG_SESSION_TYPE': 'wayland'}),
            ('evdev', {'SSH_TTY': '/dev/pts/1', 'XDG_SESSION_TYPE': 'wayland'}),
            ('x11', {'SSH_CONNECTION': '', 'SSH_TTY': '', 'XDG_SESSION_TYPE': 'wayland', 'DISPLAY': ':0'}),
            ('evdev', {'SSH_CONNECTION': '', 'SSH_TTY': '', 'XDG_SESSION_TYPE': 'x11'}),
        ]:
            with (
                self.subTest(environment=environment),
                patch.dict(os.environ, environment),
                patch('sys.argv', ['input_monitor.py', f'--backend={backend}']),
                patch('wayland_input.DeviceReader') as reader,
                patch('builtins.print'),
            ):
                self.assertEqual(main(), 1)
                reader.assert_not_called()


class DeviceDiscoveryTests(unittest.TestCase):
    def test_discovery_filters_other_seats_power_buttons_and_gamepads(self):
        entries = [Path('/sys/class/input') / f'event{index}' for index in range(7)]
        metadata = [
            'E:ID_INPUT_KEYBOARD=1',
            'E:ID_INPUT_MOUSE=1',
            'E:ID_INPUT_KEY=1',
            'E:ID_INPUT_JOYSTICK=1',
            'E:ID_INPUT_KEYBOARD=1\nE:ID_SEAT=seat1',
            'E:ID_INPUT_TOUCHPAD=1',
            'E:ID_INPUT_TOUCHSCREEN=1',
        ]

        def read_text(file):
            if file.name == 'dev':
                return f'13:{file.parent.name[5:]}'
            return metadata[int(file.name.split(':')[-1])]

        with (
            patch('wayland_input.Path.glob', return_value=entries),
            patch('wayland_input.Path.read_text', read_text),
        ):
            self.assertEqual(
                input_devices('seat0'), [Path('/dev/input') / f'event{index}' for index in (0, 1, 5)]
            )
            self.assertEqual(input_devices('seat1'), [Path('/dev/input/event4')])


if __name__ == '__main__':
    unittest.main()
