#!/usr/bin/env python3
"""Create a consistent, independently restorable SQLite and JSON recovery pair."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile


def export_database(conn):
    meta = dict(conn.execute('SELECT key,value FROM meta'))
    return {
        'format': 'listing-videos-server-v1', 'revision': int(meta['revision']),
        'updatedAt': meta['updatedAt'], 'meta': meta,
        'videos': [json.loads(row[0]) for row in conn.execute('SELECT body FROM videos ORDER BY seq DESC')],
        'types': [json.loads(row[0]) for row in conn.execute('SELECT body FROM types ORDER BY seq')],
        'examples': [json.loads(row[0]) for row in conn.execute('SELECT body FROM legacy_examples ORDER BY seq')],
        'operations': [{'operationId': row[0], 'bodyHash': row[1], 'kind': row[2], 'result': json.loads(row[3]), 'revision': row[4], 'at': row[5]}
                       for row in conn.execute('SELECT id,body_hash,kind,result,revision,at FROM operations ORDER BY at,id')],
        'audit': [{'id': row[0], 'revision': row[1], 'operationId': row[2], 'at': row[3], 'event': json.loads(row[4])}
                  for row in conn.execute('SELECT id,revision,operation_id,at,event_json FROM audit ORDER BY id')],
        'imports': [{'operationId': row[0], 'added': json.loads(row[1]), 'at': row[2]}
                    for row in conn.execute('SELECT operation_id,body,at FROM imports ORDER BY at,operation_id')],
    }


def make_backup(db_path, output_path, json_output=None):
    source = Path(db_path).resolve()
    output = Path(output_path).resolve()
    exported = Path(json_output).resolve() if json_output else output.with_suffix('.json')
    if not source.is_file():
        raise ValueError('Source database does not exist')
    if source in (output, exported) or output == exported:
        raise ValueError('Backup must not replace the active database')
    if output.exists() or exported.exists():
        raise ValueError('Refusing to overwrite an existing backup')
    os.umask(0o077)
    output.parent.mkdir(parents=True, exist_ok=True)
    exported.parent.mkdir(parents=True, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix='.listing-backup-', suffix='.sqlite', dir=output.parent)
    os.close(fd)
    temporary = Path(path)
    json_temp = None
    try:
        src = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=30)
        dest = sqlite3.connect(str(temporary))
        try:
            src.backup(dest, pages=256)
            dest.commit()
            if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Backup failed SQLite integrity check')
            data = export_database(dest)
        finally:
            dest.close()
            src.close()
        with temporary.open('rb') as file:
            os.fsync(file.fileno())
        fd, path = tempfile.mkstemp(prefix='.listing-export-', suffix='.json', dir=exported.parent)
        json_temp = Path(path)
        with os.fdopen(fd, 'w') as file:
            json.dump(data, file, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            file.flush()
            os.fsync(file.fileno())
        os.link(temporary, output)
        try:
            os.link(json_temp, exported)
        except Exception:
            output.unlink()
            raise
        return {'database': str(output), 'json': str(exported), 'revision': data['revision'],
                'videos': len(data['videos']), 'types': len(data['types']), 'examples': len(data['examples']),
                'auditEvents': len(data['audit']), 'operations': len(data['operations']),
                'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'integrity': 'ok'}
    finally:
        temporary.unlink(missing_ok=True)
        if json_temp is not None:
            json_temp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--output', required=True, help='New SQLite output; existing files are never overwritten')
    parser.add_argument('--json-output')
    args = parser.parse_args()
    print(json.dumps(make_backup(args.db, args.output, args.json_output), indent=2))


if __name__ == '__main__':
    main()
