import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class ConnectionResolutionTests(unittest.TestCase):
    def test_resolves_only_configured_desk_preferring_connected_adapter(self):
        from dbus_fast import Variant

        from desk_monitor import known_desk_device

        def device(connected, address):
            return {
                'org.bluez.Device1': {
                    'Connected': Variant('b', connected),
                    'Address': Variant('s', address),
                    'Name': Variant('s', 'Desk'),
                }
            }

        objects = {
            '/offline': device(False, 'AA:BB:CC:DD:EE:FF'),
            '/other': device(True, 'AA:BB:CC:DD:EE:00'),
            '/desk': device(True, 'AA:BB:CC:DD:EE:FF'),
        }
        found = known_desk_device(objects, 'aa:bb:cc:dd:ee:ff')
        self.assertEqual(found.details['path'], '/desk')
        self.assertIs(found.details['props']['Connected'], True)
        self.assertIsNone(known_desk_device(objects, '00:00:00:00:00:00'))

    def test_lookup_only_reads_bluez_objects(self):
        from types import SimpleNamespace

        from dbus_fast import MessageType, Variant

        import desk_monitor

        bus = mock.Mock()
        bus.call = mock.AsyncMock(
            return_value=SimpleNamespace(
                message_type=MessageType.METHOD_RETURN,
                body=[
                    {
                        '/desk': {
                            'org.bluez.Device1': {
                                'Address': Variant('s', 'AA:BB:CC:DD:EE:FF'),
                                'Connected': Variant('b', True),
                            }
                        }
                    }
                ],
            )
        )
        with mock.patch.object(desk_monitor, 'MessageBus') as connect:
            connect.return_value.connect = mock.AsyncMock(return_value=bus)
            found = asyncio.run(desk_monitor.find_known_desk('AA:BB:CC:DD:EE:FF'))
        self.assertEqual(found.details['path'], '/desk')
        bus.call.assert_awaited_once()
        self.assertEqual(bus.call.call_args.args[0].member, 'GetManagedObjects')
        bus.disconnect.assert_called_once()

    def test_known_connected_and_disconnected_desks_do_not_require_advertising(self):
        from bleak.backends.device import BLEDevice

        for connected in (True, False):
            with self.subTest(connected=connected):
                device = BLEDevice(
                    'AA:BB:CC:DD:EE:FF', 'Desk', {'path': '/desk', 'props': {'Connected': connected}}
                )
                self.run_monitor(device, None, None, 0)

    def test_unknown_desk_falls_back_to_scanning(self):
        self.run_monitor(None, mock.Mock(), None, 1)

    def test_connection_failure_remains_visible_during_retry(self):
        self.run_monitor(mock.Mock(), None, RuntimeError('Notifications unavailable'), 0)

    def run_monitor(self, known, scanned, error, scans):
        import desk_monitor

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'desk.json'

            async def start_server(*_args, **_kwargs):
                path.with_name('desk.sock').touch()
                return mock.AsyncMock()

            async def retry(_seconds):
                if error:
                    self.assertIn(str(error), json.loads(path.read_text())['error'])
                raise asyncio.CancelledError

            with (
                mock.patch.object(desk_monitor.asyncio, 'start_unix_server', side_effect=start_server),
                mock.patch.object(desk_monitor, 'find_known_desk', mock.AsyncMock(return_value=known)),
                mock.patch.object(
                    desk_monitor.BleakScanner, 'find_device_by_address', mock.AsyncMock(return_value=scanned)
                ) as scan,
                mock.patch.object(
                    desk_monitor, 'connect_and_watch', mock.AsyncMock(side_effect=error)
                ) as connect,
                mock.patch.object(desk_monitor.asyncio, 'sleep', side_effect=retry),
            ):
                with self.assertRaises(asyncio.CancelledError):
                    asyncio.run(desk_monitor.monitor('AA:BB:CC:DD:EE:FF', path))
                self.assertEqual(scan.await_count, scans)
                connect.assert_awaited_once()
                self.assertIs(connect.call_args.args[0], known if known is not None else scanned)


class FakeClient:
    """A desk that moves 1 cm per up/down frame and coast cm on after the first stop, unless it is blocked."""

    def __init__(self, desk, blocked=False, coast=0):
        self.desk = desk
        self.blocked = blocked
        self.coast = coast
        self.frames = []

    async def write_gatt_char(self, _char, frame, response):
        from desk_monitor import DOWN, STOP, UP

        self.frames.append(frame)
        if self.blocked:
            return
        if frame == STOP:
            last = next((f for f in reversed(self.frames) if f != STOP), STOP)
            self.desk['height'] += {UP: self.coast, DOWN: -self.coast}.get(last, 0)
            self.coast = 0
        else:
            self.desk['height'] += {UP: 1, DOWN: -1}[frame]

    def after_stop(self):
        from desk_monitor import STOP

        return self.frames[self.frames.index(STOP) + 1 :]


class MoveTests(unittest.TestCase):
    def setUp(self):
        import desk_monitor

        self.module = desk_monitor
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'desk.json'
        for name, value in {'MOVE_INTERVAL': 0, 'STALL_SECONDS': 0.05, 'SETTLE_SECONDS': 0.02}.items():
            patcher = mock.patch.object(desk_monitor, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def desk(self, height, **client):
        desk = {
            'height': height,
            'target': None,
            'move': None,
            'device': 'AA:BB:CC:DD:EE:FF',
            'lock': asyncio.Lock(),
        }
        desk['client'] = FakeClient(desk, **client)
        return desk

    def test_raises_until_the_stop_early_distance_and_lets_the_desk_coast_to_the_target(self):
        desk = self.desk(80, coast=6)
        asyncio.run(self.module.move(desk, 112, self.path))
        frames = desk['client'].frames
        self.assertEqual(frames.index(self.module.STOP), 26)
        self.assertEqual(set(frames[:26]), {self.module.UP})
        self.assertEqual(desk['client'].after_stop(), [self.module.STOP])
        self.assertEqual(desk['height'], 112)
        self.assertIsNone(desk['target'])
        self.assertIsNone(json.loads(self.path.read_text())['moving_to'])

    def test_lowers_to_the_target_after_coasting(self):
        desk = self.desk(112, coast=5)
        asyncio.run(self.module.move(desk, 80, self.path))
        self.assertEqual(desk['client'].frames.index(self.module.STOP), 27)
        self.assertEqual(desk['client'].after_stop(), [self.module.STOP])
        self.assertEqual(desk['height'], 80)

    def test_does_not_reverse_when_raising_coasts_past_the_target(self):
        desk = self.desk(80, coast=7)
        asyncio.run(self.module.move(desk, 112, self.path))
        self.assertEqual(desk['client'].after_stop(), [self.module.STOP])
        self.assertEqual(desk['height'], 113)

    def test_does_not_reverse_when_raising_finishes_short(self):
        desk = self.desk(80, coast=5)
        asyncio.run(self.module.move(desk, 112, self.path))
        self.assertEqual(desk['client'].after_stop(), [self.module.STOP])
        self.assertEqual(desk['height'], 111)

    def test_does_not_reverse_when_lowering_finishes_short(self):
        desk = self.desk(112, coast=4)
        asyncio.run(self.module.move(desk, 80, self.path))
        self.assertEqual(desk['client'].after_stop(), [self.module.STOP])
        self.assertEqual(desk['height'], 81)

    def test_does_not_reverse_when_lowering_coasts_past_the_target(self):
        desk = self.desk(112, coast=6)
        asyncio.run(self.module.move(desk, 80, self.path))
        self.assertEqual(desk['client'].after_stop(), [self.module.STOP])
        self.assertEqual(desk['height'], 79)

    def test_stops_when_the_desk_does_not_move(self):
        desk = self.desk(80, blocked=True)
        asyncio.run(asyncio.wait_for(self.module.move(desk, 112, self.path), 2))
        self.assertEqual(desk['client'].after_stop(), [])
        self.assertEqual(desk['height'], 80)

    def test_reports_the_target_while_moving_and_stops_when_cancelled(self):
        desk = self.desk(80, blocked=True)

        async def run():
            task = asyncio.create_task(self.module.move(desk, 112, self.path))
            await asyncio.sleep(0.01)
            self.assertEqual(json.loads(self.path.read_text())['moving_to'], 112)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        with mock.patch.object(self.module, 'STALL_SECONDS', 10):
            asyncio.run(run())
        self.assertEqual(desk['client'].frames[-1], self.module.STOP)
        self.assertIsNone(json.loads(self.path.read_text())['moving_to'])

    def test_accepts_only_a_stop_or_a_height_within_the_desk_range(self):
        parse = self.module.parse_request
        self.assertEqual(parse(b'{"move_to": 112}\n'), 112)
        self.assertIsNone(parse(b'{"stop": true}\n'))
        for line in [
            b'',
            b'nonsense',
            b'[112]',
            b'{"move_to": 140}',
            b'{"move_to": 64}',
            b'{"move_to": "112"}',
            b'{"move_to": true}',
            b'{"move_to": 112.5}',
            b'{"move_to": 112, "coast_cm": 6}',
            b'{"stop": 1}',
            b'{"move_to": 112, "coast_cm": -1}',
            b'{"move_to": 112, "coast_cm": "3"}',
        ]:
            with self.assertRaises(ValueError, msg=line):
                parse(line)

    def test_in_memory_commands_move_stop_and_reject_invalid_or_disconnected_requests(self):
        desk = self.desk(80)

        class Writer:
            closed = False

            def close(self):
                self.closed = True

            async def wait_closed(self):
                pass

        async def send(line):
            reader = asyncio.StreamReader(limit=256)
            reader.feed_data(line)
            reader.feed_eof()
            writer = Writer()
            await self.module.handle_request(desk, self.path, reader, writer)
            self.assertTrue(writer.closed)

        async def run():
            with self.assertLogs(level='WARNING'):
                await send(b'{"move_to": 999}\n')
            self.assertIsNone(desk['move'])
            await send(b'{"move_to": 112}\n')
            await desk['move']
            self.assertEqual(desk['height'], 106)
            desk['client'].blocked = True
            with mock.patch.object(self.module, 'STALL_SECONDS', 10):
                await send(b'{"move_to": 80}\n')
                await asyncio.sleep(0)
                await send(b'{"stop": true}\n')
            self.assertIsNone(desk['target'])
            self.assertEqual(desk['client'].frames[-1], self.module.STOP)
            desk['client'] = None
            await send(b'{"move_to": 112}\n')
            self.assertIsNone(desk['move'])

        asyncio.run(run())

    def test_movement_has_a_total_deadline_and_stops_after_write_failures(self):
        desk = self.desk(80)
        with mock.patch.object(self.module, 'MAX_MOVE_SECONDS', 0), self.assertLogs(level='WARNING'):
            asyncio.run(self.module.move(desk, 112, self.path))
        self.assertEqual(desk['client'].frames, [self.module.STOP])
        desk['client'].write_gatt_char = mock.AsyncMock(side_effect=[OSError('disconnected'), None])
        with self.assertLogs(level='WARNING'):
            asyncio.run(self.module.move(desk, 112, self.path))
        self.assertEqual(desk['client'].write_gatt_char.call_args_list[-1].args[1], self.module.STOP)
        self.assertIsNone(desk['target'])

    def test_unresponsive_bluetooth_write_is_bounded_and_still_attempts_stop(self):
        desk = self.desk(80)
        frames = []

        async def write(_uuid, frame, response):
            frames.append(frame)
            if frame == self.module.UP:
                await asyncio.Event().wait()

        original_wait_for = asyncio.wait_for

        async def short_wait_for(awaitable, timeout):
            return await original_wait_for(awaitable, min(timeout, 0.01))

        desk['client'].write_gatt_char = write
        with (
            mock.patch.object(self.module.asyncio, 'wait_for', short_wait_for),
            self.assertLogs(level='WARNING'),
        ):
            asyncio.run(self.module.move(desk, 112, self.path))
        self.assertEqual(frames, [self.module.UP, self.module.STOP])
        self.assertIsNone(desk['target'])

    def test_connect_only_queries_height_and_ignores_invalid_notifications(self):
        desk = self.desk(80)
        client = mock.AsyncMock()
        client.is_connected = False
        client.__aenter__.return_value = client

        async def notify(_uuid, callback):
            for payload in [b'', bytes([0, 0, 0, 1]), bytes([0, 0, 0, 80])]:
                callback(None, payload)

        client.start_notify.side_effect = notify
        with mock.patch.object(self.module, 'BleakClient', return_value=client):
            asyncio.run(self.module.connect_and_watch(mock.Mock(), self.path, desk))
        client.write_gatt_char.assert_awaited_once_with(self.module.NUS_RX, self.module.STOP, response=False)
        self.assertEqual(desk['height'], 80)
        self.assertIsNone(desk['client'])

    def test_status_is_private_atomic_and_reports_the_configured_device(self):
        self.module.write_status(self.path, connected=True, device='AA:BB:CC:DD:EE:FF', height=80)
        status = json.loads(self.path.read_text())
        self.assertEqual(status['height_cm'], 80)
        self.assertEqual(status['device'], 'AA:BB:CC:DD:EE:FF')
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.path.parent.glob('.desk-*')), [])

    def test_socket_request_moves_the_desk_and_a_stop_request_halts_it(self):
        desk = self.desk(80)
        socket_path = self.path.with_name('desk.sock')

        async def send(request):
            _reader, writer = await asyncio.open_unix_connection(str(socket_path))
            writer.write(json.dumps(request).encode() + b'\n')
            await writer.drain()
            writer.close()

        async def run():
            server = await asyncio.start_unix_server(
                lambda r, w: self.module.handle_request(desk, self.path, r, w), path=str(socket_path)
            )
            async with server:
                await send({'move_to': 112})
                while desk['move'] is None:
                    await asyncio.sleep(0)
                await desk['move']
                self.assertEqual(desk['height'], 106)
                desk['client'].blocked = True
                with mock.patch.object(self.module, 'STALL_SECONDS', 10):
                    await send({'move_to': 80})
                    while desk['target'] != 80:
                        await asyncio.sleep(0)
                    await send({'stop': True})
                    await asyncio.wait_for(asyncio.gather(desk['move'], return_exceptions=True), 1)
            self.assertIsNone(desk['target'])
            self.assertEqual(desk['client'].frames[-1], self.module.STOP)

        try:
            asyncio.run(run())
        except PermissionError:
            self.skipTest('This runtime prohibits Unix socket binding')


if __name__ == '__main__':
    unittest.main()
