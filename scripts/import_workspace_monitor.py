#!/usr/bin/env python3
"""Explicit, one-time import of Workspace Monitor daily metrics. Dry-run by default."""

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from datetime import UTC, date, datetime
from pathlib import Path

METRICS = ('sittingSeconds', 'standingSeconds', 'keyStrokes', 'mouseClicks', 'mouseMovementSamples')
SCORES = ('remindersHeeded', 'remindersMissed')
ALL_METRICS = (*METRICS, 'awaySeconds', *SCORES)
REMINDERS = {'seatedSeconds': 'seated', 'standingRunSeconds': 'standingRun', 'inputSeconds': 'input'}


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def validate(record, name, target=False):
    try:
        day = record['date']
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day) or date.fromisoformat(day).year < 2000:
            raise ValueError('Invalid date')
        if name != f'{day}.json' or record['schemaVersion'] != 1:
            raise ValueError('Unsupported record')
        metrics = record['metrics']
        required = (*METRICS, 'awaySeconds') if target else METRICS
        if not all(number(metrics.get(key)) for key in required):
            raise ValueError('Missing or invalid metric')
        for key in (*SCORES, 'workSeconds', 'awaySeconds'):
            if key in metrics and not number(metrics[key]):
                raise ValueError(f'Invalid {key}')
        reminders = record.get('reminders', {})
        for key in (*REMINDERS, *REMINDERS.values(), 'lastInputWallMs'):
            if key in reminders and not number(reminders[key]):
                raise ValueError(f'Invalid {key}')
        if 'standComplete' in reminders and type(reminders['standComplete']) is not bool:
            raise ValueError('Invalid standComplete')
    except (KeyError, TypeError, AttributeError, ValueError, OverflowError) as error:
        raise ValueError(f'{name}: invalid daily record ({error})') from error


def convert(record):
    validate(record, f'{record.get("date")}.json')
    old = record.get('reminders', {})
    return {
        'schemaVersion': 1,
        'date': record['date'],
        'metrics': {key: record['metrics'].get(key, 0) for key in ALL_METRICS},
        'reminders': {
            **{new: old.get(previous, 0) for previous, new in REMINDERS.items()},
            'standComplete': old.get('standComplete', False),
            'lastInputWallMs': old.get('lastInputWallMs', 0),
        },
    }


def read_days(directory, target=False):
    records = {}
    snapshots = {}
    for path in sorted(directory.glob('*.json')):
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.json', path.name):
            continue
        if path.is_symlink():
            raise ValueError(f'Refusing symlink: {path}')
        raw = path.read_bytes()
        record = json.loads(raw)
        validate(record, path.name, target)
        records[path.name] = record
        snapshots[path.name] = raw
    return records, snapshots


def encoded(value):
    return (json.dumps(value, indent=2, allow_nan=False) + '\n').encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def atomic_write(path, raw):
    descriptor, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def import_history(source, target, *, apply=False, overlap='abort'):
    source, target = source.resolve(), target.resolve()
    if overlap not in ('abort', 'max'):
        raise ValueError('Unknown overlap policy')
    if source == target or source in target.parents or target in source.parents:
        raise ValueError('Source and destination must be separate directories')
    marker = target / 'imports/workspace-monitor/manifest.json'
    if marker.exists():
        raise ValueError(f'Import already started or completed; see {marker}. No records changed.')
    if not (source / 'days').is_dir():
        raise ValueError(f'No source history: {source / "days"}')
    records, originals = read_days(source / 'days')
    existing, target_originals = read_days(target / 'days', target=True)
    if not records:
        raise ValueError('No daily records to import')
    collisions = sorted(records.keys() & existing.keys())
    if collisions and overlap == 'abort':
        raise ValueError(f'Existing dates: {", ".join(collisions)}. Review before using --overlap max.')

    planned = {}
    for name, record in records.items():
        imported = convert(record)
        if name in existing:
            current = existing[name]
            imported['metrics'] = {
                key: max(imported['metrics'][key], current['metrics'].get(key, 0)) for key in ALL_METRICS
            }
        planned[name] = encoded(imported)

    report = {
        'source': str(source),
        'target': str(target),
        'dates': sorted(record['date'] for record in records.values()),
        'overlap': overlap,
        'overlappingDates': [name[:-5] for name in collisions],
        'totals': {
            key: sum(json.loads(raw)['metrics'][key] for raw in planned.values()) for key in ALL_METRICS
        },
        'note': 'Overlapping metrics use their maximum, not their sum. All originals are archived, including '
        'work time and original snooze snapshots not mapped by the importer. Source reminder progress is used. '
        'Disable Work Habbits before applying.',
    }
    if not apply:
        return {**report, 'status': 'dry-run'}

    # Reserve a single journal before changing history. An interrupted import is
    # deliberately blocked from rerunning; its originals and plan allow recovery.
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.chmod(0o700)
    marker.parent.parent.mkdir(mode=0o700, exist_ok=True)
    marker.parent.mkdir(mode=0o700)
    manifest = {**report, 'status': 'preparing', 'createdAt': datetime.now(UTC).isoformat()}
    atomic_write(marker, encoded(manifest))
    for label, snapshots in (('source', originals), ('destination', target_originals), ('planned', planned)):
        archive = marker.parent / label
        archive.mkdir(mode=0o700)
        for name, raw in snapshots.items():
            atomic_write(archive / name, raw)
        manifest[f'{label}Sha256'] = {name: digest(raw) for name, raw in snapshots.items()}
    manifest['status'] = 'applying'
    atomic_write(marker, encoded(manifest))

    days = target / 'days'
    days.mkdir(mode=0o700, exist_ok=True)
    days.chmod(0o700)
    # Recheck all destination records before any replacement, including new days.
    if read_days(days, target=True)[1] != target_originals:
        raise ValueError(f'Destination changed during import; no history written. See {marker}')
    for name, raw in planned.items():
        atomic_write(days / name, raw)
    manifest['status'] = 'complete'
    atomic_write(marker, encoded(manifest))
    return {**report, 'status': 'complete', 'backup': str(marker.parent)}


def main():
    state = Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=state / 'workspace-monitor')
    parser.add_argument('--target', type=Path, default=state / 'work-habbits')
    parser.add_argument(
        '--apply', action='store_true', help='Write records and a private backup (default: preview)'
    )
    parser.add_argument('--overlap', choices=('abort', 'max'), default='abort')
    args = parser.parse_args()
    try:
        result = import_history(args.source, args.target, apply=args.apply, overlap=args.overlap)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Import stopped: {error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
