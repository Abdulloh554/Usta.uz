/* Only this application's keys; dry-run unless --execute is passed. */
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const Redis = require('ioredis');
const patterns = ['auth:*', 'sms:*', 'match:*', 'presence:*', 'cache:stats:*',
  'cache:top:*', 'cache:categories', 'ratelimit:global:*', 'ratelimit:auth:*',
  'ratelimit:sms:*', 'ratelimit:order:*', 'ratelimit:webhook:*',
  'bull:matching:*', 'bull:notification:*'];

async function main() {
  const env = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
  if (!env.REDIS_URL) throw new Error('Redis configuration missing');
  const client = new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: 5000,
    retryStrategy: () => null, maxRetriesPerRequest: 0, enableOfflineQueue: false });
  client.on('error', () => undefined);
  try {
    await client.connect();
    const keys = new Set();
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = result[0];
        for (const key of result[1]) keys.add(key);
      } while (cursor !== '0');
    }
    console.log(JSON.stringify({ matchingKeys: keys.size, execute: process.argv.includes('--execute') }));
    if (!process.argv.includes('--execute')) return;
    const list = Array.from(keys);
    for (let offset = 0; offset < list.length; offset += 100) await client.del(...list.slice(offset, offset + 100));
    let remaining = 0;
    for (const key of list) remaining += await client.exists(key);
    console.log(JSON.stringify({ removed: keys.size - remaining, remaining }));
    if (remaining !== 0) throw new Error('Some keys remain');
  } finally { client.disconnect(); }
}
main().catch((error) => {
  console.error(JSON.stringify({ failed: true, errorName: error.name, code: error.code ?? null }));
  process.exitCode = 1;
});
