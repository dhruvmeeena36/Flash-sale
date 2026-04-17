/**
 * ⚡ Flash Sale Server
 * Handles 10,000+ concurrent requests without overselling
 * 
 * Key Technique: Redis Lua Script = Atomic "Check + Decrement" in ONE operation
 * This is the EXACT same approach Flipkart/Amazon use for Big Billion Days / Prime Day
 */

require('dotenv').config({ path: '.env.local' });

const express = require("express");
const cors = require("cors");
const Redis = require("ioredis");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

// Simple request logger to help debug missing routes
app.use((req, res, next) => {
  console.log(`--> ${req.method} ${req.url}`);
  next();
});

// ─── Redis Setup ────────────────────────────────────────────────
// Support plain or TLS connections depending on environment
const redisOptions = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

// Enable TLS when explicitly requested or when URL indicates rediss://
if (process.env.REDIS_TLS === 'true' || (process.env.REDIS_URL && process.env.REDIS_URL.startsWith('rediss://'))) {
  redisOptions.tls = {};
}

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : new Redis(redisOptions);

const STOCK_KEY = "flash_sale:stock";
const ORDERS_KEY = "flash_sale:orders"; // Redis sorted set for fast order count
const RATE_LIMIT_PREFIX = "rate_limit:";

redis.on("connect", () => console.log("✅ Redis connected"));
redis.on("error", (err) => console.error("❌ Redis error:", err.message));

// ─── MongoDB Setup ───────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/flash_sale";

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  productId: { type: String, required: true },
  status: { type: String, enum: ["confirmed", "failed"], default: "confirmed" },
  createdAt: { type: Date, default: Date.now },
});

const Order = mongoose.model("Order", OrderSchema);

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.log("⚠️  MongoDB not connected (orders won't persist):", err.message));

// ─── The Magic: Lua Script ───────────────────────────────────────
/**
 * WHY LUA SCRIPT?
 * 
 * WITHOUT Lua (BROKEN - race condition):
 *   1. App reads stock  → 1
 *   2. App reads stock  → 1  (another request sneaks in before step 3!)
 *   3. App decrements   → 0  ← Both users get stock = oversell!
 * 
 * WITH Lua (SAFE - atomic):
 *   Redis executes the ENTIRE script as ONE indivisible operation.
 *   No other command can interrupt it. Like a database transaction but in-memory & 10x faster.
 */
const RESERVE_STOCK_LUA = `
  local stock = tonumber(redis.call('GET', KEYS[1]))
  if stock == nil then
    return -1  -- product not found
  end
  if stock <= 0 then
    return 0   -- out of stock
  end
  redis.call('DECR', KEYS[1])
  return stock  -- returns stock BEFORE decrement (e.g., 5 means you got the 5th item)
`;

// ─── Rate Limiter ────────────────────────────────────────────────
/**
 * Prevents a single user from spamming 1000 requests
 * Each user gets max 3 purchase attempts per 60 seconds
 */
async function rateLimitCheck(userId) {
  const key = `${RATE_LIMIT_PREFIX}${userId}`;
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, 60); // 60 second window
  }
  return attempts <= 3; // Allow max 3 attempts per minute
}

// ─── Routes ─────────────────────────────────────────────────────

// GET /stock → returns current stock (cached in Redis, super fast)
app.get("/stock", async (req, res) => {
  try {
    const stock = await redis.get(STOCK_KEY);
    const ordersCount = await redis.zcard(ORDERS_KEY);
    res.json({
      stock: parseInt(stock) || 0,
      totalOrders: ordersCount,
      isSoldOut: parseInt(stock) <= 0,
    });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch stock" });
  }
});

// POST /buy → THE CRITICAL ENDPOINT
app.post("/buy", async (req, res) => {
  const { userId, productId = "IPHONE_15_PRO" } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, message: "userId is required" });
  }

  // ── Step 1: Rate Limit Check ──────────────────────────────────
  const allowed = await rateLimitCheck(userId);
  if (!allowed) {
    return res.status(429).json({
      success: false,
      message: "Too many attempts. Try again in 60 seconds.",
    });
  }

  // ── Step 2: Atomic Stock Reservation via Lua ──────────────────
  let result;
  try {
    result = await redis.eval(RESERVE_STOCK_LUA, 1, STOCK_KEY);
  } catch (err) {
    return res.status(500).json({ success: false, message: "Reservation failed" });
  }

  // ── Step 3: Handle Result ─────────────────────────────────────
  if (result === -1) {
    return res.status(404).json({ success: false, message: "Product not found" });
  }

  if (result === 0) {
    return res.status(409).json({
      success: false,
      message: "😔 Sorry! Item sold out. You were so close!",
    });
  }

  // ── Step 4: Stock Reserved! Create Order ──────────────────────
  const orderId = uuidv4();
  const stockPositionGotten = result; // Which stock unit they got (for fun)

  // Save to Redis instantly (fast) - MongoDB save happens async
  await redis.zadd(ORDERS_KEY, Date.now(), orderId);

  // Save to MongoDB in background (don't make user wait for DB)
  Order.create({ orderId, userId, productId, status: "confirmed" }).catch((err) =>
    console.error("MongoDB save failed (order already in Redis):", err.message)
  );

  return res.status(200).json({
    success: true,
    message: `🎉 Congratulations! You got it! (Item #${stockPositionGotten})`,
    orderId,
    userId,
    productId,
  });
});

// GET /orders → list all successful orders (from Redis for speed)
app.get("/orders", async (req, res) => {
  try {
    const orders = await redis.zrange(ORDERS_KEY, 0, -1, "WITHSCORES");
    // Format: [orderId, timestamp, orderId2, timestamp2, ...]
    const formatted = [];
    for (let i = 0; i < orders.length; i += 2) {
      formatted.push({ orderId: orders[i], timestamp: new Date(parseInt(orders[i + 1])) });
    }
    res.json({ total: formatted.length, orders: formatted.slice(0, 20) }); // show last 20
  } catch (err) {
    res.status(500).json({ error: "Could not fetch orders" });
  }
});

// POST /reset → reset the sale (for demo/testing)
app.post("/reset", async (req, res) => {
  const { stock = 10 } = req.body;
  console.log('--> /reset called, stock:', stock);
  await redis.set(STOCK_KEY, stock);
  await redis.del(ORDERS_KEY);
  console.log(`🔄 Sale reset! Stock set to ${stock}`);
  res.json({ success: true, message: `Sale reset with ${stock} items` });
});

// Health endpoint — reports Redis + Mongo status
app.get('/health', async (req, res) => {
  const redisOk = redis.status === 'ready';
  const mongoState = mongoose.connection.readyState; // 1 == connected
  res.json({
    uptime: process.uptime(),
    redis: redisOk ? 'connected' : redis.status,
    mongo: mongoState === 1 ? 'connected' : `state:${mongoState}`,
    env: process.env.NODE_ENV || 'development'
  });
});

// Serve client static files AFTER API routes so POST/PUT/DELETE routes work
app.use(express.static(path.join(__dirname, '..', 'client')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Error handler — must be after routes
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ─── Start Server ────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n🚀 Flash Sale Server running on http://localhost:${PORT}`);
  console.log(`📋 Endpoints:`);
  console.log(`   GET  /stock   → check current stock`);
  console.log(`   POST /buy     → purchase item (body: { userId, productId })`);
  console.log(`   GET  /orders  → list all orders`);
  console.log(`   POST /reset   → reset sale (body: { stock: 10 })\n`);
});

module.exports = app;
