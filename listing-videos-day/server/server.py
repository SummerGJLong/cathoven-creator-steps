#!/usr/bin/env python3
"""Append-only Viral Video Pool storage. Run behind the configured Caddy gateway."""
import datetime as dt
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import unicodedata
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit
import uuid

GROUPS = ('Aira', 'Asher', 'Eya', 'Jackie', 'Kyla')
MAX_BODY = 2 * 1024 * 1024
ADMIN_REQUIRED_MESSAGE = (
    'Only an administrator can add shared video types. Video links can still be submitted. '
    'For a saved copy containing custom types, download the recovery JSON and ask Summer '
    'to import it from the admin page.'
)
TRACKING = {'fbclid', 'igsh', 'igshid', 'si', 'share', 'share_id', 'is_from_webapp',
            'sender_device', 'web_id', 'is_copy_url', 'timestamp', 'feature', 'vrfl'}
SOCIAL = ('tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be', 'facebook.com', 'fb.watch')


class Invalid(ValueError):
    pass


class Conflict(Exception):
    def __init__(self, conflicts):
        self.conflicts = conflicts


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')


def local_date():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def text(value, limit, field, empty=False):
    if not isinstance(value, str):
        raise Invalid('Invalid ' + field)
    value = unicodedata.normalize('NFC', value).strip()
    if len(value) > limit or (not empty and not value) or re.search(r'[\x00-\x1f\x7f\ud800-\udfff]', value):
        raise Invalid('Invalid ' + field)
    return value


def name(value):
    return ' '.join(text(value, 200, 'name').split())


def date(value):
    if value is None:
        return local_date()
    value = text(value, 10, 'date')
    try:
        if dt.date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except ValueError:
        raise Invalid('Invalid date') from None
    return value


def safe_url(value, optional=False):
    value = text(value, 2048, 'video link', empty=optional)
    if not value and optional:
        return '', ''
    if re.search(r'[\s\x00-\x1f\x7f\"\'<>`\\]', value):
        raise Invalid('Video link contains unsafe characters')
    if '://' not in value:
        if value.startswith('//'):
            value = 'https:' + value
        else:
            value = 'https://' + value
    try:
        parts = urlsplit(value)
        hostname = (parts.hostname or '').encode('idna').decode('ascii').lower()
        port = parts.port
    except (ValueError, UnicodeError):
        raise Invalid('Invalid video link') from None
    if parts.scheme.lower() not in ('http', 'https') or not hostname or parts.username is not None or parts.password is not None:
        raise Invalid('Use an HTTP or HTTPS video link without login details')
    if '.' not in hostname or hostname.endswith(('.local', '.localhost', '.internal')):
        raise Invalid('Use a public website video link')
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise Invalid('Use a website name rather than an IP address')
    if len(hostname) > 253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in hostname.split('.')):
        raise Invalid('Invalid website name')
    if port is not None and not 1 <= port <= 65535:
        raise Invalid('Invalid video link port')
    scheme = parts.scheme.lower()
    authority = hostname + (':' + str(port) if port is not None and port != (443 if scheme == 'https' else 80) else '')
    cleaned = urlunsplit((scheme, authority, parts.path or '/', parts.query, parts.fragment))
    social = any(hostname == domain or hostname.endswith('.' + domain) for domain in SOCIAL)
    if social:
        canonical_host = hostname[4:] if hostname.startswith('www.') else hostname
        canonical_authority = canonical_host + (':' + str(port) if port is not None and port not in (80, 443) else '')
        query = [(key, val) for key, val in parse_qsl(parts.query, keep_blank_values=True)
                 if not key.lower().startswith('utm_') and key.lower() not in TRACKING]
        canonical = urlunsplit(('https', canonical_authority, parts.path.rstrip('/') or '/', urlencode(sorted(query)), ''))
    else:
        # Unknown services may use query order or fragments as meaningful IDs.
        canonical = cleaned
    return cleaned, canonical


def operation_id(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value.lower():
            raise ValueError()
    except (ValueError, AttributeError):
        raise Invalid('operationId must be a UUID') from None
    return value.lower()


def video(value):
    allowed = {'group', 'name', 'link', 'date', 'typeKey', 'typeName'}
    if not isinstance(value, dict) or set(value) - allowed or not {'group', 'name', 'link'} <= set(value):
        raise Invalid('Expected video group, name and link')
    group = text(value['group'], 30, 'group')
    if group not in GROUPS:
        raise Invalid('Pick one of the five groups')
    link, canonical = safe_url(value['link'])
    result = {'group': group, 'name': name(value['name']), 'link': link, 'date': date(value.get('date'))}
    for field in ('typeKey', 'typeName'):
        if field in value:
            result[field] = text(value[field], 200, field, empty=True)
    return result, canonical


def custom_type(value):
    if not isinstance(value, dict) or set(value) - {'key', 'name', 'video'} or 'name' not in value:
        raise Invalid('Expected type name and optional video')
    result = {'name': name(value['name'])}
    result['video'], canonical = safe_url(value.get('video', ''), optional=True)
    if 'key' in value:
        result['key'] = text(value['key'], 200, 'type key', empty=True)
    identity = hashlib.sha256(encode([result['name'].casefold(), canonical]).encode()).hexdigest()
    return result, identity


def legacy_example(value):
    if not isinstance(value, dict) or set(value) - {'link', 'date'} or 'link' not in value:
        raise Invalid('Expected example link and optional date')
    link, canonical = safe_url(value['link'])
    result = {'link': link, 'date': date(value.get('date'))}
    identity = hashlib.sha256(encode([canonical, result['date']]).encode()).hexdigest()
    return result, identity


def validate(kind, payload):
    if not isinstance(payload, dict):
        raise Invalid('Expected a JSON object')
    op = operation_id(payload.get('operationId'))
    if kind == 'videos':
        if set(payload) != {'operationId', 'video'}:
            raise Invalid('Expected operationId and video')
        return op, {'videos': [video(payload['video'])], 'types': [], 'examples': []}
    if kind == 'types':
        if set(payload) != {'operationId', 'type'}:
            raise Invalid('Expected operationId and type')
        return op, {'videos': [], 'types': [custom_type(payload['type'])], 'examples': []}
    if kind != 'import' or set(payload) - {'operationId', 'videos', 'types', 'examples'}:
        raise Invalid('Invalid import fields')
    checked = {}
    for field, validator, limit in (('videos', video, 2000), ('types', custom_type, 1000), ('examples', legacy_example, 1000)):
        values = payload.get(field, [])
        if not isinstance(values, list) or len(values) > limit:
            raise Invalid('Invalid ' + field + ' list')
        checked[field] = []
        for index, value in enumerate(values):
            try:
                checked[field].append(validator(value))
            except Invalid as error:
                raise Invalid(field + '[' + str(index) + ']: ' + str(error)) from None
    return op, checked


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        conn = self.connect()
        try:
            version = conn.execute('PRAGMA user_version').fetchone()[0]
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            required = {'meta', 'videos', 'types', 'legacy_examples', 'operations', 'audit', 'imports'}
            if version not in (0, 1) or tables - required or (version == 1 and not required <= tables):
                raise RuntimeError('Unknown or incomplete database schema; refusing to reset data')
            if conn.execute('PRAGMA journal_mode=DELETE').fetchone()[0].lower() != 'delete':
                raise RuntimeError('Could not enable safe rollback journaling')
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS videos(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,canonical TEXT UNIQUE NOT NULL,owner_key TEXT NOT NULL,body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS types(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,identity TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS legacy_examples(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,identity TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,kind TEXT NOT NULL,result TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,revision INTEGER NOT NULL,operation_id TEXT NOT NULL,at TEXT NOT NULL,event_json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS imports(operation_id TEXT PRIMARY KEY,body TEXT NOT NULL,at TEXT NOT NULL);
                PRAGMA user_version=1;
            ''')
            for table in ('videos', 'types', 'legacy_examples', 'operations', 'audit', 'imports'):
                for action in ('UPDATE', 'DELETE'):
                    conn.execute("CREATE TRIGGER IF NOT EXISTS " + table + '_no_' + action.lower() + ' BEFORE ' + action + ' ON ' + table + " BEGIN SELECT RAISE(ABORT,'Stored listing records are append only'); END")
            conn.execute('BEGIN IMMEDIATE')
            meta = dict(conn.execute('SELECT key,value FROM meta'))
            if not meta:
                if any(conn.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in required - {'meta'}):
                    raise RuntimeError('Existing records lack initialization metadata; refusing to reset data')
                conn.executemany('INSERT INTO meta(key,value) VALUES(?,?)', [('revision', '0'), ('updatedAt', now()), ('initialized', '1')])
            elif meta.get('initialized') != '1' or not {'revision', 'updatedAt'} <= set(meta):
                raise RuntimeError('Initialization metadata is incomplete; refusing to reset data')
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        conn.execute('PRAGMA busy_timeout=15000')
        conn.execute('PRAGMA synchronous=FULL')
        return conn

    @staticmethod
    def _state(conn, since=None):
        meta = dict(conn.execute("SELECT key,value FROM meta WHERE key IN ('revision','updatedAt')"))
        state = {'revision': int(meta['revision']), 'updatedAt': meta['updatedAt']}
        if since == state['revision']:
            return dict(state, unchanged=True)
        videos = [json.loads(row[0]) for row in conn.execute('SELECT body FROM videos ORDER BY seq DESC')]
        types = [json.loads(row[0]) for row in conn.execute('SELECT body FROM types ORDER BY seq')]
        groups = {group: 0 for group in GROUPS}
        people = {}
        for item in videos:
            groups[item['group']] += 1
            people[item['name']] = people.get(item['name'], 0) + 1
        return dict(state, videos=videos, types=types, counts={'total': len(videos), 'groups': groups, 'people': people})

    def state(self, since=None):
        conn = self.connect()
        try:
            conn.execute('BEGIN')
            return self._state(conn, since)
        finally:
            conn.close()

    def apply(self, kind, payload):
        op, checked = validate(kind, payload)
        digest = hashlib.sha256(encode(payload).encode()).hexdigest()
        conn = self.connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            prior = conn.execute('SELECT body_hash,kind,result FROM operations WHERE id=?', (op,)).fetchone()
            if prior:
                if prior[0] != digest or prior[1] != kind:
                    raise Invalid('operationId was already used for a different request')
                result = json.loads(prior[2])
                if kind in ('videos', 'types'):
                    result.update({'added': False, 'duplicate': True})
                state = self._state(conn)
                conn.commit()
                return 200, dict(state, **result, replayed=True)
            timestamp = now()
            added = {key: [] for key in ('videos', 'types', 'examples')}
            duplicates = {key: 0 for key in added}
            chosen_video = chosen_type = None
            conflicts = []
            # Legacy arrays are newest-first. Reverse insertion preserves that order.
            for index in range(len(checked['videos']) - 1, -1, -1):
                item, canonical = checked['videos'][index]
                owner = encode([item['group'], item['name'].casefold()])
                existing = conn.execute('SELECT owner_key,body FROM videos WHERE canonical=?', (canonical,)).fetchone()
                if existing:
                    record = json.loads(existing[1])
                    if existing[0] != owner:
                        conflicts.append({'index': index, 'link': item['link'], 'existing': record})
                    else:
                        duplicates['videos'] += 1
                        chosen_video = record
                    continue
                record = dict(item, id=str(uuid.uuid4()), createdAt=timestamp)
                conn.execute('INSERT INTO videos(id,canonical,owner_key,body) VALUES(?,?,?,?)', (record['id'], canonical, owner, encode(record)))
                added['videos'].append(record)
                chosen_video = record
            if conflicts:
                raise Conflict(conflicts)
            for item, identity in checked['types']:
                existing = conn.execute('SELECT body FROM types WHERE identity=?', (identity,)).fetchone()
                if existing:
                    duplicates['types'] += 1
                    chosen_type = json.loads(existing[0])
                    continue
                tid = str(uuid.uuid4())
                record = {'id': tid, 'key': 'custom-' + tid, 'name': item['name'], 'video': item['video'], 'createdAt': timestamp}
                conn.execute('INSERT INTO types(id,identity,body) VALUES(?,?,?)', (tid, identity, encode(record)))
                # Keep the old key privately for recovery without trusting it as identity.
                added['types'].append(dict(record, sourceKey=item.get('key', '')))
                chosen_type = record
            for item, identity in checked['examples']:
                existing = conn.execute('SELECT id FROM legacy_examples WHERE identity=?', (identity,)).fetchone()
                if existing:
                    duplicates['examples'] += 1
                    continue
                record = dict(item, id=str(uuid.uuid4()), createdAt=timestamp)
                conn.execute('INSERT INTO legacy_examples(id,identity,body) VALUES(?,?,?)', (record['id'], identity, encode(record)))
                added['examples'].append(record)
            imported = {key: len(value) for key, value in added.items()}
            revision = int(conn.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0])
            if any(imported.values()):
                revision += 1
                conn.execute("UPDATE meta SET value=? WHERE key='revision'", (str(revision),))
                conn.execute("UPDATE meta SET value=? WHERE key='updatedAt'", (timestamp,))
                conn.execute('INSERT INTO audit(revision,operation_id,at,event_json) VALUES(?,?,?,?)', (revision, op, timestamp, encode({'kind': kind, 'added': added})))
                if kind == 'import':
                    conn.execute('INSERT INTO imports(operation_id,body,at) VALUES(?,?,?)', (op, encode(added), timestamp))
            if kind == 'videos':
                result = {'added': bool(imported['videos']), 'duplicate': bool(duplicates['videos']), 'video': chosen_video}
            elif kind == 'types':
                result = {'added': bool(imported['types']), 'duplicate': bool(duplicates['types']), 'type': chosen_type}
            else:
                result = {'imported': imported, 'duplicates': duplicates}
            conn.execute('INSERT INTO operations(id,body_hash,kind,result,revision,at) VALUES(?,?,?,?,?,?)', (op, digest, kind, encode(result), revision, timestamp))
            state = self._state(conn)
            conn.commit()
            return 200, dict(state, **result)
        except Conflict as error:
            conn.rollback()
            conn.execute('BEGIN')
            state = self._state(conn)
            return 409, dict(state, error='submission_conflict', message='This video link is already attributed to a different name or group. No records in this request were saved.', conflicts=error.conflicts)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


class RateLimiter:
    def __init__(self, limit=300, seconds=60, clock=time.monotonic):
        self.limit, self.seconds, self.clock = limit, seconds, clock
        self.items = {}
        self.lock = threading.Lock()

    def allow(self, key):
        at = self.clock()
        with self.lock:
            if len(self.items) > 10000:
                self.items = {key: item for key, item in self.items.items() if at - item[0] < self.seconds}
            start, count = self.items.get(key, (at, 0))
            if at - start >= self.seconds:
                start, count = at, 0
            if count >= self.limit:
                return False, max(1, int(self.seconds - (at - start)) + 1)
            self.items[key] = (start, count + 1)
            return True, 0


def make_handler(store, api_key, allowed_origins, limiter=None):
    if not isinstance(api_key, str) or len(api_key) < 24:
        raise ValueError('LISTING_API_KEY must contain a random secret of at least24 characters')
    allowed_origins = set(allowed_origins)
    if not allowed_origins or any(not isinstance(origin, str) or not origin.startswith(('http://', 'https://')) or origin.endswith('/') or '*' in origin for origin in allowed_origins):
        raise ValueError('Configure exact allowed origins without trailing slashes or wildcards')
    limiter = limiter or RateLimiter()

    class Handler(BaseHTTPRequestHandler):
        server_version = 'ViralVideoPool'
        sys_version = ''

        def setup(self):
            super().setup()
            self.connection.settimeout(20)

        def log_message(self, fmt, *args):
            pass  # Do not log names, URLs, body, query strings or credentials.

        def reply(self, status, value=None, extra=None, head=False):
            body = encode(value).encode() if value is not None else b''
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Vary', 'Origin')
            self.send_header('Connection', 'close')
            origin = self.headers.get('Origin')
            if origin in allowed_origins:
                self.send_header('Access-Control-Allow-Origin', origin)
            for key, val in (extra or {}).items():
                self.send_header(key, val)
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def authorized(self):
            if not hmac.compare_digest(self.headers.get('X-Listing-Key', '').encode(), api_key.encode()):
                self.reply(403, {'error': 'forbidden'})
                return False
            return True

        def administrator(self):
            # Only the authenticated gateway may supply this role marker. The
            # public gateway route must strip any visitor-provided value.
            if self.headers.get('X-Listing-Admin') != '1':
                self.reply(403, {'error': 'admin_required', 'message': ADMIN_REQUIRED_MESSAGE})
                return False
            return True

        def do_GET(self):
            parts = urlsplit(self.path)
            if parts.path == '/healthz':
                try:
                    conn = store.connect()
                    row = conn.execute("SELECT value FROM meta WHERE key='initialized'").fetchone()
                    conn.close()
                    if not row or row[0] != '1':
                        raise sqlite3.DatabaseError()
                    self.reply(200, {'status': 'ok'})
                except sqlite3.Error:
                    self.reply(503, {'error': 'database_unavailable'})
                return
            if not self.authorized():
                return
            if parts.path == '/api/admin-session':
                if self.administrator():
                    self.reply(200, {'authenticated': True, 'role': 'admin'})
                return
            if parts.path != '/api/state':
                self.reply(404, {'error': 'not_found'})
                return
            try:
                query = parse_qs(parts.query, keep_blank_values=True)
                since = None
                if query:
                    if set(query) != {'since'} or len(query['since']) != 1 or not re.fullmatch(r'\d{1,16}', query['since'][0]):
                        raise Invalid('Invalid state revision')
                    since = int(query['since'][0])
                self.reply(200, store.state(since))
            except Invalid as error:
                self.reply(400, {'error': 'invalid_request', 'message': str(error)})
            except sqlite3.Error:
                self.reply(503, {'error': 'database_unavailable'})

        def do_OPTIONS(self):
            if not self.authorized():
                return
            if urlsplit(self.path).path not in ('/api/state', '/api/videos', '/api/types', '/api/import'):
                self.reply(404, {'error': 'not_found'})
                return
            headers = {item.strip().lower() for item in self.headers.get('Access-Control-Request-Headers', '').split(',') if item.strip()}
            if self.headers.get('Origin') not in allowed_origins or self.headers.get('Access-Control-Request-Method') not in ('GET', 'POST') or headers - {'content-type', 'x-listing-request'}:
                self.reply(403, {'error': 'invalid_preflight'})
                return
            self.reply(204, extra={'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                                   'Access-Control-Allow-Headers': 'Content-Type, X-Listing-Request',
                                   'Access-Control-Max-Age': '600'})

        def do_POST(self):
            if not self.authorized():
                return
            kind = {'/api/videos': 'videos', '/api/types': 'types', '/api/import': 'import'}.get(self.path)
            if not kind:
                self.reply(404, {'error': 'not_found'})
                return
            if self.headers.get('Origin') not in allowed_origins or self.headers.get('X-Listing-Request') != '1':
                self.reply(403, {'error': 'invalid_origin'})
                return
            if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
                self.reply(415, {'error': 'json_required'})
                return
            try:
                length = self.headers.get('Content-Length')
                if length is None or self.headers.get('Transfer-Encoding') is not None or not re.fullmatch(r'\d{1,10}', length):
                    raise ValueError()
                size = int(length)
            except ValueError:
                self.reply(411, {'error': 'content_length_required'})
                return
            if size > MAX_BODY:
                self.reply(413, {'error': 'request_too_large'})
                return
            allowed, retry = limiter.allow(self.headers.get('X-Listing-Client-IP', 'gateway')[:200])
            if not allowed:
                self.reply(429, {'error': 'rate_limited', 'message': 'Please wait, then retry this same submission.'}, extra={'Retry-After': str(retry)})
                return
            try:
                body = self.rfile.read(size)
                if len(body) != size:
                    raise Invalid('Incomplete request')
                payload = json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(Invalid('Non-finite JSON value')))
                requires_admin = kind == 'types' or (
                    kind == 'import' and isinstance(payload, dict) and bool(payload.get('types'))
                )
                if requires_admin and not self.administrator():
                    return
                status, result = store.apply(kind, payload)
                self.reply(status, result)
            except (Invalid, ValueError, UnicodeDecodeError, RecursionError) as error:
                message = str(error) if not isinstance(error, RecursionError) else 'JSON is nested too deeply'
                self.reply(400, {'error': 'invalid_request', 'message': message})
            except sqlite3.Error:
                self.reply(503, {'error': 'database_unavailable'})

    return Handler


def main():
    key = os.environ.get('LISTING_API_KEY', '')
    origins = [origin.strip() for origin in os.environ.get('LISTING_ALLOWED_ORIGINS', 'https://srv2054680.hstgr.cloud,https://summergjlong.github.io').split(',') if origin.strip()]
    handler = make_handler(Store(os.environ.get('LISTING_DB_PATH', '/data/listing.sqlite')), key, origins)
    server = ThreadingHTTPServer((os.environ.get('HOST', '0.0.0.0'), int(os.environ.get('PORT', '8080'))), handler)
    print('Viral Video Pool storage service ready', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
