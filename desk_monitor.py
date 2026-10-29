#!/usr/bin/env python3
"""TiMOTION TWD1 / Nordic UART desk control, on explicit local requests only.

A neutral stop/query frame is sent on connect to obtain the initial height.
Protocol reference: https://github.com/2easy/go-Stand-Up-Pls
"""

import argparse
import asyncio
import fcntl
import functools
import json
import logging
import os
import re
import signal
import tempfile
import time
from pathlib import Path

from bleak import BleakClient, BleakScanner
from dbus_fast import BusType, Message, MessageType
from dbus_fast.aio import MessageBus

NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'
UP = bytes.fromhex('d9ff01633c')
DOWN = bytes.fromhex('d9ff02603a')
STOP = bytes(5)
MOVE_RANGE_CM = range(65, 131)
MOVE_INTERVAL = 0.2
# Conservative braking margins. Hardware can coast after STOP; targets are approximate.
STOP_EARLY_UP_CM = 6
STOP_EARLY_DOWN_CM = 5
STALL_SECONDS = 2.0
SETTLE_SECONDS = 2.5
MAX_MOVE_SECONDS = 60
RETRY_SECONDS = 15


def runtime_path() -> Path:
    base = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}'))
    target = base / 'work-habbits'
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.is_symlink() or target.stat().st_uid != os.getuid():
        raise RuntimeError('Unsafe runtime directory')
    target.chmod(0o700)
    return target / 'desk.json'


def connected_desk_paths(objects: dict, address: str) -> list[str]:
    paths = []
    for path, interfaces in objects.items():
        device = interfaces.get('org.bluez.Device1', {})
        connected, found = device.get('Connected'), device.get('Address')
        if connected and connected.value and found and found.value.upper() == address.upper():
            paths.append(path)
    return paths


async def desk_is_connected(address: str) -> bool:
    """Observe BlueZ without releasing connections owned by another application."""
    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    try:
        reply = await bus.call(
            Message(
                destination='org.bluez',
                path='/',
                interface='org.freedesktop.DBus.ObjectManager',
                member='GetManagedObjects',
            )
        )
        if reply.message_type == MessageType.ERROR:
            raise RuntimeError(f'BlueZ unavailable: {reply.error_name}')
        return bool(connected_desk_paths(reply.body[0], address))
    finally:
        bus.disconnect()


def write_status(
    path: Path,
    *,
    connected: bool,
    device: str = '',
    height: int | None = None,
    moving_to: int | None = None,
    error: str = '',
) -> None:
    status = dict(
        connected=connected,
        device=device,
        heartbeat=time.time(),
        height_cm=height,
        moving_to=moving_to,
        error=error[:160],
    )
    fd, temporary = tempfile.mkstemp(prefix='.desk-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(status, stream)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def report_desk(path: Path, desk: dict) -> None:
    write_status(
        path,
        connected=desk['client'] is not None,
        device=desk['device'],
        height=desk['height'],
        moving_to=desk['target'],
    )


def parse_request(line: bytes) -> int | None:
    request = json.loads(line)
    if isinstance(request, dict) and set(request) == {'stop'} and request['stop'] is True:
        return None
    if isinstance(request, dict) and set(request) == {'move_to'}:
        target = request['move_to']
        if type(target) is int and target in MOVE_RANGE_CM:
            return target
    raise ValueError('unsupported desk request')


async def settle(desk: dict) -> None:
    height, changed_at = desk['height'], time.monotonic()
    deadline = changed_at + 10
    while time.monotonic() - changed_at < SETTLE_SECONDS and time.monotonic() < deadline:
        await asyncio.sleep(MOVE_INTERVAL)
        if desk['height'] != height:
            height, changed_at = desk['height'], time.monotonic()


async def move(desk: dict, target: int, path: Path) -> None:
    client = desk['client']
    direction = 1 if target > desk['height'] else -1
    frame = UP if direction > 0 else DOWN
    coast = STOP_EARLY_UP_CM if direction > 0 else STOP_EARLY_DOWN_CM
    desk['target'] = target
    report_desk(path, desk)
    best, progress_at = desk['height'], time.monotonic()
    deadline = progress_at + MAX_MOVE_SECONDS
    try:
        while (target - desk['height']) * direction > coast:
            if time.monotonic() >= deadline:
                raise TimeoutError('Desk movement exceeded time limit')
            if (desk['height'] - best) * direction > 0:
                best, progress_at = desk['height'], time.monotonic()
            elif time.monotonic() - progress_at > STALL_SECONDS:
                logging.warning('Desk stalled; stopping')
                return
            await asyncio.wait_for(client.write_gatt_char(NUS_RX, frame, response=False), timeout=2)
            await asyncio.sleep(MOVE_INTERVAL)
        await asyncio.wait_for(client.write_gatt_char(NUS_RX, STOP, response=False), timeout=2)
        await settle(desk)
    except Exception as error:
        logging.warning('Desk move interrupted: %s', error)
    finally:
        desk['target'] = None
        try:
            await asyncio.wait_for(client.write_gatt_char(NUS_RX, STOP, response=False), timeout=2)
        except Exception as error:
            logging.warning('Could not send stop: %s', error)
        report_desk(path, desk)


async def handle_request(
    desk: dict, path: Path, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    try:
        request = parse_request(await asyncio.wait_for(reader.readline(), timeout=2))
        async with desk['lock']:
            if desk['move']:
                desk['move'].cancel()
                await asyncio.gather(desk['move'], return_exceptions=True)
                desk['move'] = None
            if request is not None and desk['client'] is not None and desk['height'] is not None:
                desk['move'] = asyncio.create_task(move(desk, request, path))
    except (ValueError, TimeoutError) as error:
        logging.warning('Ignoring desk request: %s', error)
    finally:
        writer.close()
        await writer.wait_closed()


async def connect_and_watch(device, path: Path, desk: dict) -> None:
    desk['height'] = None

    def height_notification(_sender, payload: bytearray) -> None:
        if len(payload) > 3 and 50 <= payload[3] <= 140:
            desk['height'] = payload[3]

    async with BleakClient(device, timeout=20) as client:
        await client.start_notify(NUS_TX, height_notification)
        # Reconnecting may stop a desk that is already moving.
        await asyncio.wait_for(client.write_gatt_char(NUS_RX, STOP, response=False), timeout=2)
        desk['client'] = client
        try:
            while client.is_connected:
                report_desk(path, desk)
                await asyncio.sleep(3)
        finally:
            desk['client'] = None
            if desk['move']:
                desk['move'].cancel()
                await asyncio.gather(desk['move'], return_exceptions=True)
                desk['move'] = None


async def monitor(address: str, path: Path) -> None:
    desk = dict(client=None, height=None, target=None, move=None, lock=asyncio.Lock(), device=address)
    socket_path = path.with_name('desk.sock')
    socket_path.unlink(missing_ok=True)
    server = await asyncio.start_unix_server(
        functools.partial(handle_request, desk, path), path=str(socket_path), limit=256
    )
    socket_path.chmod(0o600)
    try:
        async with server:
            while True:
                write_status(path, connected=False, device=address, error='Searching for configured desk')
                try:
                    if await desk_is_connected(address):
                        write_status(
                            path,
                            connected=False,
                            device=address,
                            error='Desk already connected; leaving the other application alone',
                        )
                        await asyncio.sleep(RETRY_SECONDS)
                        continue
                    device = await BleakScanner.find_device_by_address(address, timeout=12)
                    if device and not await desk_is_connected(address):
                        await connect_and_watch(device, path, desk)
                except Exception as error:
                    logging.warning('Bluetooth unavailable: %s', error)
                write_status(path, connected=False, device=address, error='Disconnected / desk unavailable')
                await asyncio.sleep(RETRY_SECONDS)
    finally:
        socket_path.unlink(missing_ok=True)
        write_status(path, connected=False, device=address, error='Bluetooth helper stopped')


async def run(address: str, path: Path) -> None:
    task = asyncio.create_task(monitor(address, path))
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, task.cancel)
    try:
        await task
    except asyncio.CancelledError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description='work-habbits: TWD1 Bluetooth desk helper')
    parser.add_argument('--device', help='Bluetooth address of your TWD1-compatible desk')
    parser.add_argument(
        '--scan', action='store_true', help='List nearby devices; never connect or send commands'
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    if args.scan:
        for device in asyncio.run(BleakScanner.discover()):
            print(f'{device.address}  {device.name or "(unnamed)"}')
        return
    if not args.device or not re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', args.device):
        parser.error('--device must be a Bluetooth address (AA:BB:CC:DD:EE:FF)')
    path = runtime_path()
    with path.with_name('desk.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        asyncio.run(run(args.device.upper(), path))


if __name__ == '__main__':
    main()
