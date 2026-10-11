// Run against an isolated staging/local API, never the live marketplace.
// BASE_URL=http://127.0.0.1:4000 CONCURRENCY=10 REQUESTS=200 node scripts/load-read.cjs
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:4000');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && process.env.ALLOW_STAGING !== 'yes') {
  throw new Error('For a verified isolated staging host, explicitly set ALLOW_STAGING=yes');
}
if (['usta-uz.onrender.com', 'ustamiz.uz', 'www.ustamiz.uz'].includes(base.hostname)) {
  throw new Error('This script must not target the production marketplace');
}
const requests = Number(process.env.REQUESTS || 200);
const concurrency = Number(process.env.CONCURRENCY || 10);
if (!Number.isInteger(requests) || requests < 1 || requests > 100000 ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 500) throw new Error('Invalid load bounds');
const paths = ['/api/v1/users/top-masters?limit=3', '/api/v1/users/top-masters?limit=20&craft=electrician'];
const times = [];
const statuses = {};
let cursor = 0;
let transportErrors = 0;
const started = performance.now();
async function run() {
  while (cursor < requests) {
    const index = cursor++;
    const start = performance.now();
    try {
      const res = await fetch(new URL(paths[index % paths.length], base), {
        signal: AbortSignal.timeout(15000),
      });
      await res.arrayBuffer();
      statuses[res.status] = (statuses[res.status] || 0) + 1;
    } catch { transportErrors++; }
    times.push(performance.now() - start);
  }
}
Promise.all(Array.from({ length: concurrency }, run)).then(() => {
  times.sort((a, b) => a - b);
  const percentile = (p) => Math.round(times[Math.ceil(times.length * p) - 1]);
  const seconds = (performance.now() - started) / 1000;
  const result = { requests, concurrency, seconds: Number(seconds.toFixed(2)),
    requestsPerSecond: Number((requests / seconds).toFixed(2)),
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), statuses, transportErrors,
    scope: 'Read endpoints only. Does not measure login, writes, real Redis/BullMQ, WebSocket or production capacity.' };
  console.log(JSON.stringify(result, null, 2));
  if (transportErrors || Object.entries(statuses).some(([status]) => Number(status) >= 400)) process.exitCode = 1;
});
