import copy
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from backup import make_backup
from server import Invalid, RateLimiter, Store, ThreadingHTTPServer, local_date, make_handler, safe_url

KEY = 'test-only-listing-key-not-used-in-production-123'
ORIGIN = 'https://listing.example.test'
LEGACY = 'https://summergjlong.github.io'


def item(number=1, **changes):
    result = {'group': 'Aira', 'name': 'Test Creator',
              'link': 'https://www.tiktok.com/@test/video/' + str(number), 'date': '2026-11-05'}
    result.update(changes)
    return result


def submit(value=None, op=None):
    return {'operationId': op or str(uuid.uuid4()), 'video': value or item()}


def importing(videos=None, types=None, examples=None, op=None):
    return {'operationId': op or str(uuid.uuid4()), 'videos': videos or [],
            'types': types or [], 'examples': examples or []}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / 'listing.sqlite'
        self.store = Store(self.db)

    def tearDown(self):
        self.temp.cleanup()

    def test_committed_video_is_visible_to_other_client_and_survives_restart(self):
        code, response = self.store.apply('videos', submit())
        self.assertEqual(code, 200)
        self.assertTrue(response['added'])
        other = Store(self.db)
        self.assertEqual(other.state(), self.store.state())
        self.assertEqual(other.state()['videos'][0]['link'], item()['link'])

    def test_database_is_initialized_once_in_delete_full_mode(self):
        self.store.apply('videos', submit())
        restarted = Store(self.db)
        self.assertEqual(restarted.state()['counts']['total'], 1)
        connection = restarted.connect()
        self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
        self.assertEqual(connection.execute('PRAGMA synchronous').fetchone()[0], 2)
        connection.close()

    def test_unknown_or_incomplete_database_refuses_silent_reset(self):
        other = self.root / 'foreign.sqlite'
        connection = sqlite3.connect(other)
        connection.execute('CREATE TABLE important(value TEXT)')
        connection.execute("INSERT INTO important VALUES('preserve')")
        connection.commit()
        connection.close()
        with self.assertRaises(RuntimeError):
            Store(other)
        connection = sqlite3.connect(other)
        self.assertEqual(connection.execute('SELECT value FROM important').fetchone()[0], 'preserve')
        connection.close()
        connection = self.store.connect()
        connection.execute('DROP TABLE imports')
        connection.close()
        with self.assertRaises(RuntimeError):
            Store(self.db)

    def test_operation_replay_does_not_duplicate_or_change_revision(self):
        payload = submit()
        first = self.store.apply('videos', payload)[1]
        replay = Store(self.db).apply('videos', payload)[1]
        self.assertTrue(replay['replayed'])
        self.assertTrue(replay['duplicate'])
        self.assertFalse(replay['added'])
        self.assertEqual(first['revision'], replay['revision'])
        self.assertEqual(first['video']['id'], replay['video']['id'])

    def test_operation_id_cannot_be_reused_for_different_body_or_endpoint(self):
        payload = submit()
        self.store.apply('videos', payload)
        changed = copy.deepcopy(payload)
        changed['video']['link'] = item(2)['link']
        with self.assertRaises(Invalid):
            self.store.apply('videos', changed)
        with self.assertRaises(Invalid):
            self.store.apply('types', {'operationId': payload['operationId'], 'type': {'name': 'Type'}})
        self.assertEqual(self.store.state()['counts']['total'], 1)

    def test_same_url_same_owner_deduplicates_across_operations_and_tracking_links(self):
        first = item(link='https://www.instagram.com/reel/ABC/?utm_source=x&igsh=one', name='  José   Cruz ')
        second = item(link='http://instagram.com/reel/ABC', name='JOSE\u0301 CRUZ')
        self.store.apply('videos', submit(first))
        code, result = self.store.apply('videos', submit(second))
        self.assertEqual(code, 200)
        self.assertTrue(result['duplicate'])
        self.assertEqual(result['counts']['total'], 1)
        self.assertEqual(result['videos'][0]['name'], 'José Cruz')

    def test_duplicate_link_never_reassigns_name_or_group(self):
        self.store.apply('videos', submit())
        code, result = self.store.apply('videos', submit(item(name='Different Person', group='Kyla')))
        self.assertEqual(code, 409)
        self.assertEqual(result['error'], 'submission_conflict')
        self.assertEqual(result['conflicts'][0]['existing']['name'], 'Test Creator')
        self.assertEqual(self.store.state()['counts']['groups']['Kyla'], 0)

    def test_concurrent_unique_submissions_are_all_saved_once(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda number: self.store.apply('videos', submit(item(number))), range(12)))
        self.assertTrue(all(status == 200 for status, _ in results))
        state = self.store.state()
        self.assertEqual(state['counts']['total'], 12)
        self.assertEqual(len({value['id'] for value in state['videos']}), 12)
        self.assertEqual(state['revision'], 12)

    def test_concurrent_duplicate_submissions_have_single_owner_record(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.store.apply('videos', submit()), range(10)))
        self.assertEqual(sum(result['added'] for _, result in results), 1)
        self.assertEqual(self.store.state()['counts']['total'], 1)

    def test_import_is_atomic_when_a_link_has_conflicting_credit(self):
        self.store.apply('videos', submit())
        before = self.store.state()
        payload = importing(videos=[item(2), item(name='Other Creator')], types=[{'name': 'Must not save'}])
        code, result = self.store.apply('import', payload)
        self.assertEqual(code, 409)
        self.assertEqual(result['videos'], before['videos'])
        self.assertEqual(result['types'], [])
        self.assertEqual(self.store.state(), before)

    def test_import_is_fully_validated_before_any_write(self):
        payload = importing(videos=[item(), item(2, group='Invalid')])
        with self.assertRaisesRegex(Invalid, r'videos\[1\]'):
            self.store.apply('import', payload)
        self.assertEqual(self.store.state()['counts']['total'], 0)

    def test_legacy_import_preserves_dates_types_examples_and_deduplicates(self):
        payload = importing(videos=[item(1, date='2026-11-04'), item(2, group='Eya')],
                            types=[{'key': 'custom123', 'name': 'A new format', 'video': item(20)['link']}],
                            examples=[{'link': item(30)['link'], 'date': '2026-11-03'}])
        code, result = self.store.apply('import', payload)
        self.assertEqual(code, 200)
        self.assertEqual(result['imported'], {'videos': 2, 'types': 1, 'examples': 1})
        self.assertEqual(result['duplicates'], {'videos': 0, 'types': 0, 'examples': 0})
        self.assertEqual(result['videos'][0]['date'], '2026-11-04')
        self.assertNotEqual(result['types'][0]['key'], 'custom123')
        self.assertNotIn('examples', result)
        payload['operationId'] = str(uuid.uuid4())
        duplicate = self.store.apply('import', payload)[1]
        self.assertEqual(duplicate['imported'], {'videos': 0, 'types': 0, 'examples': 0})
        self.assertEqual(duplicate['duplicates'], {'videos': 2, 'types': 1, 'examples': 1})
        self.assertEqual(duplicate['revision'], result['revision'])

    def test_import_replay_returns_committed_counts_and_revision(self):
        payload = importing(videos=[item()])
        first = self.store.apply('import', payload)[1]
        replay = self.store.apply('import', payload)[1]
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['imported'], first['imported'])
        self.assertEqual(replay['duplicates'], first['duplicates'])
        self.assertEqual(replay['revision'], first['revision'])

    def test_legacy_type_key_collision_does_not_replace_different_type(self):
        one = self.store.apply('types', {'operationId': str(uuid.uuid4()), 'type': {'key': 'custom123', 'name': 'First'}})[1]
        two = self.store.apply('types', {'operationId': str(uuid.uuid4()), 'type': {'key': 'custom123', 'name': 'Second'}})[1]
        self.assertEqual(len(two['types']), 2)
        self.assertNotEqual(one['type']['key'], two['type']['key'])

    def test_counts_and_lightweight_polling_are_authoritative(self):
        self.store.apply('videos', submit())
        self.store.apply('videos', submit(item(2, group='Kyla')))
        state = self.store.state()
        self.assertEqual(state['counts']['groups']['Aira'], 1)
        self.assertEqual(state['counts']['groups']['Kyla'], 1)
        self.assertEqual(state['counts']['people']['Test Creator'], 2)
        unchanged = self.store.state(state['revision'])
        self.assertTrue(unchanged['unchanged'])
        self.assertNotIn('videos', unchanged)
        self.assertEqual(self.store.state(0)['videos'], state['videos'])

    def test_safe_urls_preserve_unknown_meaningful_queries_and_reject_injection(self):
        for bad in ['javascript:alert(1)', 'data:text/html,x', "https://example.com/' onclick='bad", 'https://user:password@example.com/a', 'http://127.0.0.1/a', 'http://localhost/a', 'https://example.local/a', 'https://example.com/a\nnext', 'https://example.com:wrong/a']:
            with self.subTest(url=bad), self.assertRaises(Invalid):
                safe_url(bad)
        a = safe_url('video.example/watch?a=1&b=2#one')
        b = safe_url('https://video.example/watch?b=2&a=1#one')
        self.assertNotEqual(a[1], b[1])
        self.assertIn('#one', a[1])
        self.assertEqual(a[0], 'https://video.example/watch?a=1&b=2#one')

    def test_validation_rejects_unknown_fields_bad_dates_and_surrogates(self):
        for value in [item(date='2026-99-99'), item(name=''), item(name='x'*201), item(name='bad\ud800'), dict(item(), admin=True)]:
            with self.subTest(value=repr(value)), self.assertRaises(Invalid):
                self.store.apply('videos', submit(value))
        self.assertEqual(self.store.state()['counts']['total'], 0)
        without_date = item()
        del without_date['date']
        result = self.store.apply('videos', submit(without_date))[1]
        self.assertEqual(result['video']['date'], local_date())

    def test_schema_guards_prevent_record_and_audit_erasure(self):
        self.store.apply('videos', submit())
        connection = self.store.connect()
        for sql in ['DELETE FROM videos', "UPDATE videos SET owner_key='changed'", 'DELETE FROM audit', 'DELETE FROM operations']:
            with self.subTest(sql=sql), self.assertRaises(sqlite3.DatabaseError):
                connection.execute(sql)
        connection.close()
        self.assertEqual(self.store.state()['counts']['total'], 1)

    def test_failed_commit_transaction_leaves_no_partial_submission(self):
        connection = self.store.connect()
        connection.execute("CREATE TRIGGER fail_revision BEFORE UPDATE ON meta WHEN NEW.key='revision' BEGIN SELECT RAISE(ABORT,'test rollback'); END")
        connection.close()
        with self.assertRaises(sqlite3.DatabaseError):
            self.store.apply('videos', submit())
        self.assertEqual(self.store.state()['counts']['total'], 0)
        connection = self.store.connect()
        self.assertEqual(connection.execute('SELECT count(*) FROM operations').fetchone()[0], 0)
        connection.close()

    def test_backup_restores_all_shared_and_private_recovery_records(self):
        payload = importing(videos=[item()], types=[{'key': 'custom1', 'name': 'Format'}], examples=[{'link': item(5)['link'], 'date': '2026-11-01'}])
        self.store.apply('import', payload)
        target = self.root/'restore.sqlite'
        report = make_backup(self.db, target)
        restored = Store(target)
        self.assertEqual(restored.state(), self.store.state())
        exported = json.loads(target.with_suffix('.json').read_text())
        self.assertEqual(len(exported['examples']), 1)
        self.assertEqual(len(exported['operations']), 1)
        self.assertEqual(len(exported['audit']), 1)
        self.assertEqual(exported['imports'][0]['added']['types'][0]['sourceKey'], 'custom1')
        self.assertEqual(report['integrity'], 'ok')
        self.assertTrue(restored.apply('import', payload)[1]['replayed'])

    def test_backup_refuses_overwriting_live_or_existing_files(self):
        with self.assertRaises(ValueError):
            make_backup(self.db, self.db)
        target = self.root/'restore.sqlite'
        make_backup(self.db, target)
        with self.assertRaises(ValueError):
            make_backup(self.db, target)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name)/'listing.sqlite'
        self.store = Store(self.db)
        self.start()

    def start(self, limiter=None):
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.store, KEY, {ORIGIN, LEGACY}, limiter))
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=0.02), daemon=True)
        self.thread.start()

    def stop(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def request(self, method='GET', path='/api/state', payload=None, headers=None, authorized=True, raw=None):
        common = {'X-Listing-Key': KEY} if authorized else {}
        if payload is not None or raw is not None:
            common.update({'Origin': ORIGIN, 'X-Listing-Request': '1', 'Content-Type': 'application/json'})
        common.update(headers or {})
        body = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_address[1], timeout=5)
        connection.request(method, path, body=body, headers=common)
        response = connection.getresponse()
        content = response.read()
        result = json.loads(content) if content and 'application/json' in response.getheader('Content-Type', '') else content
        answer = response.status, dict(response.getheaders()), result
        connection.close()
        return answer

    def test_gateway_key_is_required_but_health_is_minimal(self):
        self.assertEqual(self.request(authorized=False)[0], 403)
        status, _, body = self.request(path='/healthz', authorized=False)
        self.assertEqual((status, body), (200, {'status': 'ok'}))
        self.assertEqual(self.request(headers={'X-Listing-Key': 'wrong'})[0], 403)

    def test_http_save_visible_to_independent_client_and_http_restart(self):
        payload = submit()
        self.assertEqual(self.request('POST', '/api/videos', payload)[0], 200)
        before = self.request()[2]
        self.stop()
        self.store = Store(self.db)
        self.start()
        self.assertEqual(self.request()[2], before)
        self.assertTrue(self.request('POST', '/api/videos', payload)[2]['replayed'])

    def test_legacy_cors_preflight_is_exact_and_does_not_allow_credentials(self):
        headers = {'Origin': LEGACY, 'Access-Control-Request-Method': 'POST',
                   'Access-Control-Request-Headers': 'content-type,x-listing-request'}
        status, response, body = self.request('OPTIONS', '/api/import', headers=headers)
        self.assertEqual((status, body), (204, b''))
        self.assertEqual(response['Access-Control-Allow-Origin'], LEGACY)
        self.assertNotIn('Access-Control-Allow-Credentials', response)
        self.assertEqual(response['Access-Control-Allow-Headers'], 'Content-Type, X-Listing-Request')
        self.assertEqual(self.request('OPTIONS','/api/import', headers=dict(headers, Origin='https://untrusted.example'))[0],403)
        self.assertEqual(self.request('OPTIONS','/api/import', headers=dict(headers, **{'Access-Control-Request-Headers':'authorization'}))[0],403)

    def test_legacy_origin_can_import_and_receive_committed_ack(self):
        status, headers, result = self.request('POST','/api/import',importing(videos=[item()]),headers={'Origin':LEGACY})
        self.assertEqual(status,200)
        self.assertEqual(headers['Access-Control-Allow-Origin'],LEGACY)
        self.assertEqual(result['imported']['videos'],1)
        self.assertEqual(result['counts']['total'],1)

    def test_origin_custom_header_and_content_type_reject_cross_site_writes(self):
        for headers, expected in [({'Origin':'https://untrusted.example'},403),({'Origin':''},403),({'X-Listing-Request':''},403),({'Content-Type':'text/plain'},415)]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request('POST','/api/videos',submit(),headers=headers)[0],expected)
        self.assertEqual(self.request()[2]['counts']['total'],0)

    def test_json_invalid_or_oversized_body_returns_error_and_never_saves(self):
        self.assertEqual(self.request('POST','/api/videos',raw=b'{')[0],400)
        self.assertEqual(self.request('POST','/api/videos',raw=b'{}',headers={'Content-Length':str(2*1024*1024+1)})[0],413)
        self.assertEqual(self.request('POST','/api/videos',raw=b'{"n":NaN}')[0],400)
        self.assertEqual(self.request()[2]['counts']['total'],0)

    def test_rate_limit_is_retryable_and_preserves_data(self):
        self.stop()
        self.start(RateLimiter(limit=1))
        self.assertEqual(self.request('POST','/api/videos',submit())[0],200)
        status, headers, _ = self.request('POST','/api/videos',submit(item(2)))
        self.assertEqual(status,429)
        self.assertTrue(int(headers['Retry-After'])>0)
        self.assertEqual(self.request()[2]['counts']['total'],1)

    def test_lightweight_since_route_and_invalid_revision(self):
        self.assertTrue(self.request(path='/api/state?since=0')[2]['unchanged'])
        self.request('POST','/api/videos',submit())
        self.assertEqual(len(self.request(path='/api/state?since=0')[2]['videos']),1)
        self.assertTrue(self.request(path='/api/state?since=1')[2]['unchanged'])
        self.assertEqual(self.request(path='/api/state?since=bad')[0],400)


if __name__ == '__main__':
    unittest.main()
