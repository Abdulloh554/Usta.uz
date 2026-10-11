// Isolated read smoke test. Creates and destroys its own temporary Mongo replica set.
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const http = require('node:http');

async function main() {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  let server;
  try {
    // Set every sensitive dependency explicitly before importing application config.
    Object.assign(process.env, {
      NODE_ENV: 'test', MONGO_URI: repl.getUri(), REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_ACCESS_SECRET: 'isolated-local-load-access-secret-32',
      JWT_REFRESH_SECRET: 'isolated-local-load-refresh-secret-32', SMS_PROVIDER: 'console',
      LOG_LEVEL: 'error', WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '',
    });
    const { createApp } = require('../dist/app');
    const { User } = require('../dist/modules/user/user.model');
    const { MasterProfile } = require('../dist/modules/user/masterProfile.model');
    await mongoose.connect(repl.getUri(), { directConnection: true });
    await Promise.all([User.init(), MasterProfile.init()]);
    for (let batch = 0; batch < 20; batch++) {
      const users = await User.insertMany(Array.from({ length: 500 }, (_, index) => ({
        phone: `+99890${String(batch * 500 + index).padStart(7, '0')}`, passwordHash: 'fixture-only-not-for-login',
        firstName: 'Synthetic', lastName: 'User', role: 'master',
      })));
      await MasterProfile.insertMany(users.map((user) => ({
        user: user._id, crafts: ['electrician'], regions: ['Chilonzor'],
        rating: 4.5, completedJobs: 10, isOnline: true, isAvailable: true,
      })));
    }
    server = http.createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.REQUESTS = '200'; process.env.CONCURRENCY = '10';
    console.log('10,000 synthetic masters; temporary local MongoDB; test-mode read endpoints. Not a production capacity certification.');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [require.resolve('./load-read.cjs')], { env: process.env, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    if (code) process.exitCode = code;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await repl.stop();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
