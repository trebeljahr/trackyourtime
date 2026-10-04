import base64
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('mongo-replica-maintenance.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Guards(unittest.TestCase):
    def test_mutation_refuses_active_clients(self):
        container = {'Image': m.IMAGE_ID, 'Name': '/' + m.SERVICE, 'HostConfig': {'PortBindings': {}}, 'Mounts': [
            {'Destination': path, 'Name': name + m.SERVICE, 'RW': True}
            for path, name in [('/data/db', 'mongodb-db-'), ('/data/configdb', 'mongodb-configdb-')]]}
        with patch.object(m, 'inspect', return_value=container), patch.object(m, 'writers', return_value=['active-app']):
            with self.assertRaisesRegex(m.Refusal, 'active writers'):
                m.guard(True)

    def test_image_drift_refused_before_credentials_are_read(self):
        with patch.object(m, 'inspect', return_value={'Image': 'changed'}), patch.object(m, 'credentials') as read:
            with self.assertRaisesRegex(m.Refusal, 'identity/image'):
                m.guard()
            read.assert_not_called()

    def test_expired_or_unverified_proof_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence = Path(temp) / 'proof.json'
            with patch.object(m, 'EVIDENCE', evidence):
                evidence.write_text(json.dumps({'checkedAt': '2000-01-01T00:00:00+00:00', 'sourceImage': m.IMAGE_ID}))
                with self.assertRaises(m.Refusal): m.evidence()
                evidence.write_text(json.dumps({'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'sourceImage': m.IMAGE_ID}))
                with self.assertRaises(m.Refusal): m.evidence()

    def test_payload_pins_the_inspected_image_without_auto_deployment(self):
        p = subprocess.run(['python3', str(Path(m.__file__)), 'patch-payload'], capture_output=True, check=True)
        body = json.loads(p.stdout)
        self.assertEqual(body['image'], m.IMAGE)
        self.assertFalse(body['instant_deploy'])
        self.assertEqual(base64.b64decode(body['mongo_conf']).decode(), m.CONFIG)
        self.assertIn('authorization: enabled', m.CONFIG)

    def test_rollback_payload_keeps_auth_and_image_without_replication(self):
        p = subprocess.run(['python3', str(Path(m.__file__)), 'rollback-payload'], capture_output=True, check=True)
        body = json.loads(p.stdout)
        self.assertEqual(body['image'], m.IMAGE)
        self.assertFalse(body['instant_deploy'])
        config = base64.b64decode(body['mongo_conf']).decode()
        self.assertEqual(config, m.STANDALONE_CONFIG)
        self.assertIn('authorization: enabled', config)
        self.assertNotIn('replication', config)
        self.assertNotIn('keyFile', config)


def mounted_container():
    container = {'Id': 'c1', 'Image': m.IMAGE_ID, 'Name': '/' + m.SERVICE, 'HostConfig': {'PortBindings': {}}, 'Mounts': [
        {'Destination': path, 'Name': name + m.SERVICE, 'RW': True}
        for path, name in [('/data/db', 'mongodb-db-'), ('/data/configdb', 'mongodb-configdb-')]]}
    container['Mounts'].append({'Destination': m.CONTAINER_CONFIG, 'Source': str(m.HOST_CONFIG), 'RW': False})
    return container


def stat(mode, uid=0, gid=0):
    return os.stat_result((mode, 0, 0, 1, uid, gid, 0, 0, 0, 0))


class ConfigFileMode(unittest.TestCase):
    def run_main(self, *argv):
        with patch.object(sys, 'argv', ['helper', *argv]), patch('builtins.print') as out:
            m.main()
        return json.loads(out.call_args[0][0])

    def test_coolify_640_root_file_is_reported_not_world_readable(self):
        with patch.object(m.os, 'lstat', return_value=stat(0o100640)):
            status = m.config_file(mounted_container())
        self.assertEqual(status['mode'], '0640')
        self.assertEqual(status['owner'], 'root:' + m.grp.getgrgid(0).gr_name)
        self.assertFalse(status['worldReadable'])
        with self.assertRaisesRegex(m.Refusal, '0640.*EACCES'):
            m.require_readable_config(status)

    def test_world_readable_file_passes(self):
        with patch.object(m.os, 'lstat', return_value=stat(0o100644)):
            m.require_readable_config(m.config_file(mounted_container()))

    def test_symlink_or_moved_mount_is_refused(self):
        with patch.object(m.os, 'lstat', return_value=stat(0o120777)):
            self.assertFalse(m.config_file(mounted_container())['worldReadable'])
        moved = mounted_container()
        moved['Mounts'][-1]['Source'] = '/tmp/other.conf'
        with self.assertRaisesRegex(m.Refusal, 'mount changed'):
            m.config_file(moved)

    def test_initiate_refuses_before_any_database_call(self):
        container = mounted_container()
        with patch.object(m, 'guard', return_value=(container, ['u', 'p'], [])), \
                patch.object(m.os, 'lstat', return_value=stat(0o100640)), \
                patch.object(m, 'evidence') as proof, patch.object(m, 'mongo') as db, \
                patch.object(sys, 'argv', ['helper', 'initiate', '--execute']):
            with self.assertRaisesRegex(m.Refusal, 'cannot read'):
                m.main()
            db.assert_not_called()
            proof.assert_not_called()

    def test_audit_reports_mode_without_reading_contents(self):
        topology = {'primary': True, 'setName': None}
        with patch.object(m, 'guard', return_value=(mounted_container(), ['u', 'p'], [])), \
                patch.object(m.os, 'lstat', return_value=stat(0o100640)), \
                patch.object(m, 'mongo', return_value=json.dumps(topology).encode()), \
                patch.object(m, 'fingerprint', return_value={}), \
                patch.object(Path, 'read_text', side_effect=AssertionError('config read')), \
                patch.object(m.os, 'chmod') as chmod:
            body = self.run_main('audit')
        self.assertEqual(body['configFile']['mode'], '0640')
        self.assertFalse(body['configFile']['worldReadable'])
        chmod.assert_not_called()

    def test_config_mode_changes_nothing_without_execute(self):
        with patch.object(m, 'guard', return_value=(mounted_container(), ['u', 'p'], [])), \
                patch.object(m.os, 'lstat', return_value=stat(0o100640)), patch.object(m.os, 'chmod') as chmod:
            self.assertFalse(self.run_main('config-mode')['worldReadable'])
        chmod.assert_not_called()

    def test_config_mode_execute_only_adds_read_bits(self):
        modes = [stat(0o100640), stat(0o100644)]
        with patch.object(m, 'guard', return_value=(mounted_container(), ['u', 'p'], [])) as guard, \
                patch.object(m.os, 'lstat', side_effect=modes), patch.object(m.os, 'chmod') as chmod:
            self.assertTrue(self.run_main('config-mode', '--execute')['worldReadable'])
        chmod.assert_called_once_with(m.HOST_CONFIG, 0o644)
        guard.assert_called_once_with(False)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds + 1.0  # each mongosh exec also costs time


class Readiness(unittest.TestCase):
    def ready_after(self, seconds, clock):
        def probe(*_):
            if clock.now < seconds:
                raise m.Refusal('not yet')
            return json.dumps({'primary': True, 'setName': None}).encode()
        return probe

    def test_happy_path_returns_without_sleeping(self):
        clock = FakeClock()
        with patch.object(m.time, 'monotonic', clock.monotonic), patch.object(m.time, 'sleep') as sleep, \
                patch.object(m, 'mongo', self.ready_after(0, clock)):
            m.wait_primary('x', None)
        sleep.assert_not_called()

    def test_deadline_is_time_based(self):
        clock = FakeClock()
        with patch.object(m.time, 'monotonic', clock.monotonic), patch.object(m.time, 'sleep', clock.sleep), \
                patch.object(m, 'exited', return_value=False), \
                patch.object(m, 'mongo', self.ready_after(1e9, clock)):
            with self.assertRaisesRegex(m.Refusal, 'deadline'):
                m.wait_primary('x', None)
        self.assertGreaterEqual(clock.now, m.READY_DEADLINE)
        self.assertLess(clock.now, m.READY_DEADLINE + 2)

    def test_slow_rehearsal_clone_start_fits_rehearsal_deadline(self):
        clock = FakeClock()
        with patch.object(m.time, 'monotonic', clock.monotonic), patch.object(m.time, 'sleep', clock.sleep), \
                patch.object(m, 'exited', return_value=False), \
                patch.object(m, 'mongo', self.ready_after(45, clock)):
            m.wait_primary('x', None, deadline=m.REHEARSAL_READY_DEADLINE)
        self.assertGreaterEqual(m.REHEARSAL_READY_DEADLINE, 90)

    def test_exited_clone_fails_fast_instead_of_waiting_out_the_deadline(self):
        clock = FakeClock()
        state = {'State': {'Status': 'exited'}, 'HostConfig': {'RestartPolicy': {'Name': 'no'}}}
        with patch.object(m.time, 'monotonic', clock.monotonic), patch.object(m.time, 'sleep', clock.sleep), \
                patch.object(m, 'mongo', self.ready_after(1e9, clock)), patch.object(m, 'inspect', return_value=state):
            with self.assertRaisesRegex(m.Refusal, 'exited during startup'):
                m.wait_primary('x', None, deadline=m.REHEARSAL_READY_DEADLINE)
        self.assertEqual(clock.now, 0)

    def test_restarting_coolify_container_keeps_waiting(self):
        clock = FakeClock()
        state = {'State': {'Status': 'exited'}, 'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}}}
        with patch.object(m.time, 'monotonic', clock.monotonic), patch.object(m.time, 'sleep', clock.sleep), \
                patch.object(m, 'mongo', self.ready_after(10, clock)), patch.object(m, 'inspect', return_value=state):
            m.wait_primary('x', None)

    def test_mongosh_probe_does_not_write_into_the_data_volume(self):
        with patch.object(m, 'docker', return_value=b'') as docker:
            m.mongo('x', 'print(1)')
        args = docker.call_args.args
        self.assertEqual(args[args.index('-e') + 1], 'HOME=/tmp')
        self.assertLess(args.index('-e'), args.index('x'))

    def test_rehearse_uses_rehearsal_deadline_everywhere(self):
        ready = {'setName': None, 'authorization': 'enabled', 'primary': True}
        with tempfile.NamedTemporaryFile() as archive, \
                patch.object(m, 'docker', return_value=b''), \
                patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')), \
                patch.object(m, 'wait_primary', return_value=ready) as wait, \
                patch.object(m, 'initiate') as init, patch.object(m, 'keyfile'), \
                patch.object(m, 'transaction_probe'), patch.object(m, 'fingerprint', return_value={'sha256': 'x'}):
            m.rehearse('image', archive.name, ['u', 'p'], {'sha256': 'x'})
        self.assertEqual([c.kwargs['deadline'] for c in wait.call_args_list], [m.REHEARSAL_READY_DEADLINE] * 2)
        self.assertEqual(init.call_args.args[3], m.REHEARSAL_READY_DEADLINE)


@unittest.skipUnless(os.environ.get('HATCHKIT_TEST_MONGO_IMAGE') and os.environ.get('HATCHKIT_TEST_BACKUP_RUNNER'), 'explicit synthetic image and reviewed backup runner required')
class NativeConversion(unittest.TestCase):
    def test_authenticated_restore_conversion_and_existing_direct_uri(self):
        source = 'track-mongo-synthetic-' + uuid.uuid4().hex[:12]
        image = os.environ['HATCHKIT_TEST_MONGO_IMAGE']
        r_spec = importlib.util.spec_from_file_location('backup_runner', os.environ['HATCHKIT_TEST_BACKUP_RUNNER'])
        runner = importlib.util.module_from_spec(r_spec)
        r_spec.loader.exec_module(runner)
        auth = ['synthetic', 'synthetic-proof-password']
        try:
            m.docker('run', '--detach', '--pull=never', '--name', source, '--network', 'none', '--memory', '768m', '--cpus', '0.5',
                     '-e', 'MONGO_INITDB_ROOT_USERNAME=' + auth[0], '-e', 'MONGO_INITDB_ROOT_PASSWORD=' + auth[1], image, 'mongod', '--wiredTigerCacheSizeGB', '0.25')
            m.wait_primary(source, auth)
            m.mongo(source, 'db.getSiblingDB("test").records.insertOne({_id:"kept",value:1});db.getSiblingDB("test").records.createIndex({value:1},{unique:true});db.getSiblingDB("other").records.insertOne({_id:"also-kept",value:2});', auth)
            before = m.fingerprint(source, auth)
            with tempfile.TemporaryDirectory(prefix='track-mongo-native-proof-') as temp:
                directory = Path(temp)
                runner.dump_database({'kind': 'mongo', 'selector': {'container': source}}, m.inspect(source), directory)
                m.docker('stop', '--time', '30', source)
                result = m.rehearse(image, directory / 'mongo.archive.gz', auth, before)
                self.assertTrue(result['unchangedUriTransaction'])
                self.assertTrue(result['standaloneRollback'])
                print(json.dumps(result), flush=True)
        finally:
            subprocess.run(['docker', 'rm', '-f', '-v', source], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_fingerprint_ignores_index_order_but_not_index_definition(self):
        # Production restore rebuilt identical indexes in another order.
        name = 'track-mongo-index-order-' + uuid.uuid4().hex[:12]
        try:
            m.docker('run', '--detach', '--pull=never', '--name', name, '--network', 'none', '--memory', '512m',
                     os.environ['HATCHKIT_TEST_MONGO_IMAGE'], 'mongod', '--wiredTigerCacheSizeGB', '0.25')
            m.wait_primary(name, None)
            m.mongo(name, 'const c=db.getSiblingDB("test").entries; c.insertOne({_id:1,a:1,b:2});'
                          'c.createIndex({a:1}); c.createIndex({b:1,a:-1}); c.createIndex({b:1},{unique:true});')
            before = m.fingerprint(name)
            m.mongo(name, 'const c=db.getSiblingDB("test").entries; c.dropIndexes();'
                          'c.createIndex({b:1},{unique:true}); c.createIndex({b:1,a:-1}); c.createIndex({a:1});')
            self.assertEqual(m.fingerprint(name), before)
            m.mongo(name, 'const c=db.getSiblingDB("test").entries; c.dropIndex("b_1"); c.createIndex({b:1});')
            self.assertNotEqual(m.fingerprint(name), before)
        finally:
            subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__': unittest.main()
