import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { MongoClient } from "mongodb";

/** An operator-local throwaway process, never a caller-supplied database
 * connection. Authentication is initialized through MongoDB's localhost
 * exception before any original records are restored. Neither credentials nor
 * source records enter command arguments, logs or persistent backup metadata.
 * Its temporary plaintext database is removed after process exit; this is not
 * proof of physical erasure from the trusted operator machine's storage. */
export async function withOperatorRestoreSandbox<T>(mongodPath: string, work: (client: MongoClient) => Promise<T>): Promise<T> {
  if (!isAbsolute(mongodPath)) throw new Error("Choose an absolute path to the operator machine's mongod binary");
  await access(mongodPath, constants.X_OK);
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") { probe.close(); reject(new Error("Could not allocate an isolated restore port")); return; }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  // A short private path also fits macOS's Unix-domain socket path limit.
  const directory = await mkdtemp("/tmp/trackyourtime-operator-restore-");
  let client: MongoClient | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let ended: Promise<void> | undefined, exited = false;
  try {
    const data = join(directory, "data"); await mkdir(data, { mode: 0o700 });
    child = spawn(mongodPath, ["--bind_ip", "127.0.0.1", "--port", String(port), "--dbpath", data, "--wiredTigerCacheSizeGB", "0.25", "--unixSocketPrefix", directory, "--auth", "--quiet", "--setParameter", "diagnosticDataCollectionEnabled=false"], { stdio: "ignore" });
    ended = new Promise<void>((resolve) => { child!.once("exit", () => { exited = true; resolve(); }); child!.once("error", () => { exited = true; resolve(); }); });
    // Use the socket inside our 0700 directory. A loopback-port race must not
    // redirect bootstrap commands into an unrelated local database.
    const uri = `mongodb://${encodeURIComponent(join(directory, `mongodb-${port}.sock`))}/?directConnection=true`;
    const deadline = Date.now() + 15_000;
    while (true) {
      if (exited || Date.now() >= deadline) throw new Error("The isolated operator restore database did not start");
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 500, connectTimeoutMS: 500 });
      try { await client.connect(); break; }
      catch { await client.close(); await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const username = `operator-${randomUUID()}`, password = randomBytes(32).toString("base64url");
    await client.db("admin").command({ createUser: username, pwd: password, roles: ["root"] });
    await client.close();
    client = new MongoClient(uri, { auth: { username, password }, authSource: "admin", serverSelectionTimeoutMS: 1000 });
    await client.connect();
    const options = await client.db("admin").command({ getCmdLineOpts: 1 });
    if (options.parsed?.storage?.dbPath !== data) throw new Error("Operator restore process identity does not match its private directory");
    return await work(client);
  } finally {
    try { await client?.close(); } finally {
      if (child && ended && !exited) {
        const stop = async (signal: NodeJS.Signals, timeout: number) => {
          child!.kill(signal); let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([ended, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeout); })]); }
          finally { if (timer) clearTimeout(timer); }
        };
        await stop("SIGTERM", 5000);
        if (!exited) await stop("SIGKILL", 2000);
        if (!exited) throw new Error(`Operator restore process ${child.pid} did not stop. Temporary data was retained at ${directory}`);
      }
      try { await rm(directory, { recursive: true, force: true }); }
      catch (cause) { throw new Error(`Operator restore cleanup failed for ${directory}`, { cause }); }
    }
  }
}
