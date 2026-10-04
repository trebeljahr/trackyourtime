#!/usr/bin/env python3
"""Guarded Track Mongo maintenance. Execute on the approved host over Tailscale.
Default audit is read-only. Mutations require --execute and stopped app writers.
Provider PATCH/deploy and app stop/start remain separate operator steps.
"""
import argparse
import base64
import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid

SERVICE = 'x3rnoe4qdk846u4q3wjw2fw0'
IMAGE = 'mongo@sha256:b6421fd6d1c5ded6377b397d8983e2f82e2100dc5123332dcfda2065a472be5b'
IMAGE_ID = 'sha256:a887b589a601923f6ae405f3f76c17984218971ced2ca59f05840b1f5a7c44c2'
SET = 'tracktime-rs'
KEY = '/data/configdb/hatchkit-replica.key'
WORK = Path('/var/lib/hatchkit-backups')
EVIDENCE = WORK / 'track-mongo-conversion-proof.json'
BASE_CONFIG = 'storage:\n  dbPath: /data/db\nnet:\n  bindIpAll: true\n  port: 27017\n'
STANDALONE_CONFIG = BASE_CONFIG + 'security:\n  authorization: enabled\n'
CONFIG = BASE_CONFIG + f'security:\n  authorization: enabled\n  keyFile: {KEY}\nreplication:\n  replSetName: {SET}\n'


class Refusal(RuntimeError):
    pass


def run(args, data=None, output=None, timeout=90):
    result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # Never expose command stderr or a raw provider/database response.
        raise Refusal('Command failed: ' + Path(args[0]).name)
    return result.stdout


def docker(*args, **kwargs):
    return run(['docker', *args], **kwargs)


def inspect(name):
    return json.loads(docker('inspect', name))[0]


def credentials(container):
    env = dict(value.split('=', 1) for value in container['Config']['Env'] if '=' in value)
    result = [env.get('MONGO_INITDB_ROOT_USERNAME'), env.get('MONGO_INITDB_ROOT_PASSWORD')]
    if not all(result):
        raise Refusal('Existing root credential source is unavailable')
    return result


def mongo(name, code, auth=None):
    prefix = '' if auth is None else 'const creds=' + json.dumps(auth) + '; const admin=db.getSiblingDB("admin"); if(!admin.auth(...creds)) quit(1);\n'
    return docker('exec', '-i', name, 'mongosh', 'mongodb://127.0.0.1:27017/?directConnection=true&serverSelectionTimeoutMS=1000', '--quiet', '--norc', '--file', '/dev/stdin', data=(prefix + code).encode())


TOPOLOGY_JS = '''const a=db.getSiblingDB("admin"),h=a.runCommand({hello:1}),p=a.runCommand({getCmdLineOpts:1}).parsed;
print(JSON.stringify({primary:Boolean(h.isWritablePrimary),setName:h.setName??null,version:db.version(),authorization:p.security?.authorization??null,keyFile:p.security?.keyFile??null,replSetName:p.replication?.replSetName??null}));'''
# mongorestore may rebuild indexes in another order; compare them by name with
# option keys sorted. The key pattern itself keeps its order, which is meaningful.
FINGERPRINT_JS = '''const hash=require("node:crypto").createHash("sha256"); let namespaces=0;
const canonical=i=>Object.fromEntries(Object.keys(i).sort().map(k=>[k,i[k]]));
for(const name of db.getSiblingDB("admin").runCommand({listDatabases:1,nameOnly:true}).databases.map(x=>x.name).filter(x=>!["admin","local","config"].includes(x)).sort()) {
 const d=db.getSiblingDB(name), content=d.runCommand({dbHash:1}); if(!content.ok) quit(1);
 const collections=d.getCollectionInfos({type:"collection"}).map(x=>x.name).sort().map(n=>({name:n,count:d.getCollection(n).countDocuments({}),indexes:d.getCollection(n).getIndexes().map(canonical).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)}));
 namespaces+=collections.length; hash.update(JSON.stringify({name,collections,hash:content.md5}));
}
const a=db.getSiblingDB("admin"), users=a.runCommand({dbHash:1,collections:["system.users","system.roles"]}); if(!users.ok) quit(1);
hash.update(JSON.stringify(users.collections)); print(JSON.stringify({sha256:hash.digest("hex"),namespaces,users:a.system.users.countDocuments({})}));'''


def fingerprint(name, auth=None):
    return json.loads(mongo(name, FINGERPRINT_JS, auth))


def writers():
    ids = docker('ps', '-q').decode().split()
    result = []
    for container in json.loads(docker('inspect', *ids)) if ids else []:
        for item in container['Config'].get('Env', []):
            if not item.startswith(('MONGODB_URI=', 'MONGO_URL=', 'DATABASE_URL=')):
                continue
            try:
                parsed = urllib.parse.urlsplit(item.split('=', 1)[1])
                if parsed.scheme in ('mongodb', 'mongodb+srv') and parsed.hostname == SERVICE:
                    result.append(container['Name'].lstrip('/'))
            except ValueError:
                raise Refusal('A client URI cannot be safely checked')
    return sorted(set(result))


def guard(stopped=False):
    container = inspect(SERVICE)
    if container['Image'] != IMAGE_ID or container['Name'] != '/' + SERVICE:
        raise Refusal('Mongo identity/image changed; repeat review')
    for path, volume in (('/data/db', 'mongodb-db-' + SERVICE), ('/data/configdb', 'mongodb-configdb-' + SERVICE)):
        mounts = [mount for mount in container['Mounts'] if mount['Destination'] == path]
        if len(mounts) != 1 or mounts[0].get('Name') != volume or not mounts[0]['RW']:
            raise Refusal('Mongo persistent volume changed')
    if container['HostConfig']['PortBindings']:
        raise Refusal('Mongo unexpectedly publishes a host port')
    active = writers()
    if stopped and active:
        raise Refusal('Stop both Track app resources before maintenance; active writers remain')
    return container, credentials(container), active


def wait_primary(name, auth, replica=False):
    for _ in range(100):
        try:
            topology = json.loads(mongo(name, TOPOLOGY_JS, auth))
            if topology['primary'] and (not replica or topology['setName'] == SET):
                return topology
        except Refusal:
            pass
        time.sleep(0.2)
    raise Refusal('Mongo readiness/election deadline reached')


def keyfile(name, auth=None):
    script = '''const fs=require("node:fs"),p=__PATH__;
if(fs.existsSync(p)) { const s=fs.lstatSync(p); if(!s.isFile()||s.isSymbolicLink()||s.uid!==999||s.gid!==999||(s.mode&511)!==384||!/^[A-Za-z0-9+/=]{1008}$/.test(fs.readFileSync(p,"utf8"))) quit(1); }
else { const fd=fs.openSync(p,"wx",384); try {fs.fchmodSync(fd,384);fs.fchownSync(fd,999,999);fs.writeFileSync(fd,require("node:crypto").randomBytes(756).toString("base64"));fs.fsyncSync(fd);} finally {fs.closeSync(fd);} }
print(JSON.stringify({keyFileReady:true,mode:"0600",uid:999,gid:999}));'''.replace('__PATH__', json.dumps(KEY))
    return json.loads(mongo(name, script, auth))


def initiate(name, auth, host):
    for attempt in range(100):
        try:
            mongo(name, TOPOLOGY_JS, auth)
            break
        except Refusal:
            if attempt == 99:
                raise Refusal('Replica process startup deadline reached')
            time.sleep(0.2)
    payload = {'_id': SET, 'members': [{'_id': 0, 'host': host}]}
    mongo(name, 'const h=admin.runCommand({hello:1}); if(h.setName && h.setName!==__SET__) quit(1); if(!h.setName) {const r=admin.runCommand({replSetInitiate:__CONFIG__}); if(!r.ok) quit(1);}'.replace('__SET__', json.dumps(SET)).replace('__CONFIG__', json.dumps(payload)), auth)
    mongo(name, 'const r=admin.runCommand({replSetGetConfig:1}); const c=r.config; if(!r.ok||c._id!==__SET__||c.members.length!==1||c.members[0].host!==__HOST__||c.members[0].arbiterOnly) quit(1);'.replace('__SET__', json.dumps(SET)).replace('__HOST__', json.dumps(host)), auth)
    return wait_primary(name, auth, True)


def transaction_probe(name, auth):
    # Exactly the existing URI shape: no replicaSet/authSource, directConnection=true.
    # The default database remains test; only isolated restore containers run this.
    code = '''const uri="mongodb://"+creds.map(encodeURIComponent).join(":")+"@127.0.0.1:27017/?directConnection=true";
const c=new Mongo(uri),s=c.startSession(),d=s.getDatabase("test");
s.startTransaction(); d.getCollection("__hatchkit_proof_a").insertOne({_id:"commit"});d.getCollection("__hatchkit_proof_b").insertOne({_id:"receipt"});s.commitTransaction();
if(c.getDB("test").getCollection("__hatchkit_proof_a").countDocuments({})!==1||c.getDB("test").getCollection("__hatchkit_proof_b").countDocuments({})!==1) quit(1);
s.startTransaction();d.getCollection("__hatchkit_proof_a").insertOne({_id:"abort"});s.abortTransaction();
if(c.getDB("test").getCollection("__hatchkit_proof_a").countDocuments({})!==1) quit(1);
s.endSession();c.getDB("test").getCollection("__hatchkit_proof_a").drop();c.getDB("test").getCollection("__hatchkit_proof_b").drop();
print(JSON.stringify({unchangedDirectUriTransaction:true}));'''
    return json.loads(mongo(name, code, auth))


def rehearse(image, archive, auth, before):
    name = 'track-mongo-restore-proof-' + uuid.uuid4().hex[:12]
    started = time.monotonic()
    try:
        docker('image', 'inspect', image)  # Never pull during a recovery rehearsal.
        docker('create', '--name', name, '--network', 'none', '--memory', '768m', '--cpus', '0.5', '--pids-limit', '512',
               image, 'mongod', '--config', '/data/configdb/rehearsal.conf')
        with tempfile.TemporaryDirectory(prefix='track-mongo-config-') as temp:
            config = Path(temp) / 'mongod.conf'
            config.write_text(BASE_CONFIG.replace('  dbPath: /data/db\n', '  dbPath: /data/db\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 0.25\n'))
            docker('cp', str(config), name + ':/data/configdb/rehearsal.conf')
            docker('start', name)
            wait_primary(name, None)
            with Path(archive).open('rb') as stream:
                result = subprocess.run(['docker', 'exec', '-i', name, 'mongorestore', '--archive', '--gzip'], stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if result.returncode:
                    raise Refusal('Native restore failed')
            if fingerprint(name) != before:
                raise Refusal('Restored data/users/indexes differ from the stopped source')
            keyfile(name)
            docker('stop', '--time', '30', name)
            config.write_text(CONFIG.replace('  dbPath: /data/db\n', '  dbPath: /data/db\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 0.25\n'))
            docker('cp', str(config), name + ':/data/configdb/rehearsal.conf')
            docker('start', name)
            initiate(name, auth, 'localhost:27017')
            transaction_probe(name, auth)
            if fingerprint(name, auth) != before:
                raise Refusal('Replica conversion changed restored data/users/indexes')
            # Prove rollback on the same volumes with replica metadata retained.
            docker('stop', '--time', '30', name)
            config.write_text(STANDALONE_CONFIG.replace('  dbPath: /data/db\n', '  dbPath: /data/db\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 0.25\n'))
            docker('cp', str(config), name + ':/data/configdb/rehearsal.conf')
            docker('start', name)
            topology = wait_primary(name, auth)
            if topology['setName'] is not None or topology['authorization'] != 'enabled' or fingerprint(name, auth) != before:
                raise Refusal('Standalone rollback failed data/authentication verification')
        return {'nativeRestore': True, 'replicaConversion': True, 'unchangedUriTransaction': True, 'standaloneRollback': True, 'elapsedSeconds': round(time.monotonic() - started, 2)}
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def backup_proof():
    container, auth, _ = guard(True)
    sys.path.insert(0, '/opt/hatchkit-backups')
    import runner
    spec = importlib.util.spec_from_file_location('restore_check', '/opt/hatchkit-backups/restore-check.py')
    restore = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(restore)
    if not hasattr(runner, 'MONGO_DUMP_JS') or '--password' in runner.MONGO_DUMP_JS:
        raise Refusal('Install the reviewed stdin-auth backup runner first')
    config = json.loads(Path('/etc/hatchkit-backups/config.json').read_text())
    project = next(p for p in config['projects'] if p['name'] == 'tracktime')
    if project['sources'] != [{'name': 'mongo', 'kind': 'mongo', 'selector': {'project': SERVICE, 'service': SERVICE}}]:
        raise Refusal('Track backup coverage changed; review the policy')
    with (WORK / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # An interrupted new attempt must not leave an earlier proof actionable.
        EVIDENCE.write_text(json.dumps({'valid': False}) + '\n')
        EVIDENCE.chmod(0o600)
        before = fingerprint(SERVICE, auth)
        env = runner.credential_env(config, WORK)
        result = runner.backup_project(project, config, env, runner.containers(), WORK)
        runner.save_status([result], WORK)
        if fingerprint(SERVICE, auth) != before:
            raise Refusal('Source changed during capture; keep writers stopped and repeat')
        with tempfile.TemporaryDirectory(prefix='track-conversion-restore-', dir=WORK) as temp:
            temp = Path(temp)
            with (temp / 'project.tar').open('wb') as output:
                runner.run(['restic', 'dump', result['snapshot'], '/project.tar'], env={**env, 'RESTIC_REPOSITORY': config['repositoryBase'].rstrip('/') + '/tracktime'}, output=output)
            manifest = restore.unpack(temp / 'project.tar', temp / 'data')
            if len(manifest['sources']) != 1 or manifest['sources'][0].get('imageId') != IMAGE_ID:
                raise Refusal('Restored backup image/source mismatch')
            proof = rehearse(IMAGE_ID, temp / 'data/mongo/mongo.archive.gz', auth, before)
        evidence = {'valid': True, 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'snapshot': result['snapshot'], 'sourceImage': IMAGE_ID, 'sourceContainer': container['Id'], 'fingerprint': before, **proof}
        EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n')
        EVIDENCE.chmod(0o600)
        report_path = WORK / 'restore-check-all.json'
        report = json.loads(report_path.read_text()) if report_path.exists() else {'results': []}
        report['results'] = [row for row in report['results'] if row['project'] != 'tracktime'] + [{
            'project': 'tracktime', 'ok': True, 'snapshot': result['snapshot'], 'checkedAt': evidence['checkedAt'],
            'sources': [{'name': 'mongo', 'kind': 'mongo', 'image': IMAGE, 'nativeRestore': 'passed'}],
        }]
        report['checkedAt'] = evidence['checkedAt']
        temporary = report_path.with_suffix('.conversion.tmp')
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(report_path)
        return evidence


def evidence():
    value = json.loads(EVIDENCE.read_text())
    if not value.get('valid'):
        raise Refusal('Latest maintenance proof did not complete')
    age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(value['checkedAt'])).total_seconds()
    if not (0 <= age < 3600) or value['sourceImage'] != IMAGE_ID or not all(value.get(k) for k in ('nativeRestore', 'replicaConversion', 'unchangedUriTransaction', 'standaloneRollback')):
        raise Refusal('A fresh successful same-image backup/conversion rehearsal is required')
    return value


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['audit', 'patch-payload', 'rollback-payload', 'backup-proof', 'keyfile', 'initiate', 'verify'], nargs='?', default='audit')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if args.action in ('patch-payload', 'rollback-payload'):
        print(json.dumps({'image': IMAGE, 'mongo_conf': base64.b64encode((CONFIG if args.action == 'patch-payload' else STANDALONE_CONFIG).encode()).decode(), 'instant_deploy': False}))
        return
    mutating = args.action in ('backup-proof', 'keyfile', 'initiate')
    if mutating and not args.execute:
        raise Refusal('Maintenance requires --execute; default audit never changes state')
    container, auth, active = guard(mutating or args.action == 'verify')
    if args.action == 'audit':
        print(json.dumps({'service': SERVICE, 'image': container['Image'], 'activeClientContainers': active, 'topology': json.loads(mongo(SERVICE, TOPOLOGY_JS, auth)), 'fingerprint': fingerprint(SERVICE, auth)}))
    elif args.action == 'backup-proof':
        print(json.dumps(backup_proof()))
    else:
        saved = evidence()
        if args.action == 'keyfile':
            if container['Id'] != saved['sourceContainer'] or fingerprint(SERVICE, auth) != saved['fingerprint']:
                raise Refusal('Source changed since backup proof')
            print(json.dumps(keyfile(SERVICE, auth)))
        elif args.action == 'initiate':
            topology = json.loads(mongo(SERVICE, TOPOLOGY_JS, auth))
            if topology['keyFile'] != KEY or topology['replSetName'] != SET or topology['authorization'] != 'enabled':
                raise Refusal('Expected reviewed config is not running')
            print(json.dumps(initiate(SERVICE, auth, SERVICE + ':27017')))
        else:
            topology = wait_primary(SERVICE, auth, True)
            if fingerprint(SERVICE, auth) != saved['fingerprint']:
                raise Refusal('Post-conversion data/users/indexes differ')
            print(json.dumps({'verified': True, 'snapshot': saved['snapshot'], 'topology': topology}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, Refusal) else type(error).__name__}))
        sys.exit(1)
