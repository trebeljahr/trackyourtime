import base64
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
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


if __name__ == '__main__': unittest.main()
