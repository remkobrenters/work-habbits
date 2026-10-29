import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from desk_service import DeskService


class Settings(dict):
    def get_string(self, key):
        return self[key]

    def get_boolean(self, key):
        return self.get(key, False)


class DeskServiceTests(unittest.TestCase):
    def test_only_explicit_bluetooth_mode_starts_a_helper_and_changes_stop_it(self):
        settings = Settings(
            {'desk-mode': 'disabled', 'tracking-enabled': True, 'desk-device': 'aa:bb:cc:dd:ee:ff'}
        )
        service = DeskService(settings, Path('/tmp/test app'))
        with patch('desk_service.subprocess.Popen') as launch:
            process = launch.return_value
            process.poll.return_value = None
            service.sync()
            settings['desk-mode'] = 'manual'
            service.sync()
            launch.assert_not_called()
            settings['desk-mode'] = 'bluetooth'
            service.sync()
            launch.assert_called_once_with(
                [
                    '/tmp/test app/.venv/bin/python',
                    '/tmp/test app/desk_monitor.py',
                    '--device',
                    'AA:BB:CC:DD:EE:FF',
                ]
            )
            service.sync()
            self.assertEqual(launch.call_count, 1)
            settings['tracking-enabled'] = False
            service.sync()
            process.terminate.assert_called_once()
            self.assertIsNone(service.process)

    def test_invalid_addresses_never_start_a_process_and_changed_devices_restart_it(self):
        settings = Settings({'desk-mode': 'bluetooth', 'tracking-enabled': True, 'desk-device': 'invalid'})
        service = DeskService(settings, Path('/tmp/app'))
        with patch('desk_service.subprocess.Popen') as launch:
            launch.return_value.poll.return_value = None
            service.sync()
            launch.assert_not_called()
            settings['desk-device'] = 'AA:BB:CC:DD:EE:01'
            service.sync()
            settings['desk-device'] = 'AA:BB:CC:DD:EE:02'
            service.sync()
            self.assertEqual(launch.call_count, 2)
            self.assertEqual(service.device, settings['desk-device'])
            service.stop()

    def test_unresponsive_helpers_are_killed_and_missing_installations_are_retried(self):
        settings = Settings(
            {'desk-mode': 'bluetooth', 'tracking-enabled': True, 'desk-device': 'AA:BB:CC:DD:EE:FF'}
        )
        service = DeskService(settings, Path('/tmp/app'))
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired('helper', 5), 0]
        with patch('desk_service.subprocess.Popen', return_value=process):
            service.sync()
            service.stop()
            process.kill.assert_called_once()
        with patch('desk_service.subprocess.Popen', side_effect=FileNotFoundError('missing')):
            with self.assertLogs(level='ERROR'):
                service.sync()
            self.assertIsNone(service.process)
