/**
 * 🌱 Seed Script
 * Run this BEFORE starting the server to set initial stock
 * Usage: node server/seed.js
 */

require('dotenv').config({ path: '.env.local' });
const Redis = require("ioredis");

const redisOptions = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};
if (process.env.REDIS_TLS === 'true' || (process.env.REDIS_URL && process.env.REDIS_URL.startsWith('rediss://'))) {
  redisOptions.tls = {};
}

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : new Redis(redisOptions);

async function seed() {
  const STOCK = 100; // Change this to test different stock levels

  await redis.set("flash_sale:stock", STOCK);
  await redis.del("flash_sale:orders");

  console.log(`✅ Seeded! Stock = ${STOCK} items`);
  console.log(`👉 Now start the server: npm start`);
  console.log(`👉 Then run load test:  npm run load-test`);

  redis.disconnect();
}

seed().catch(console.error);
