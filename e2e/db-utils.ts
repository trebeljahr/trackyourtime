import { MongoClient } from "mongodb";

// Must match the database the E2E server writes to (see playwright.config.ts).
// It previously defaulted to "starter-e2e" while the server used
// "trackyourtime-e2e", so cleanDatabase() was emptying a database nothing used and
// state leaked between tests.
const MONGODB_URI =
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/trackyourtime-e2e";

let client: MongoClient | null = null;

export async function getDb() {
  if (!client) {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
  }
  return client.db();
}

export async function cleanDatabase() {
  const db = await getDb();
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    await db.collection(col.name).deleteMany({});
  }
}

export async function closeDbConnection() {
  if (client) {
    await client.close();
    client = null;
  }
}
