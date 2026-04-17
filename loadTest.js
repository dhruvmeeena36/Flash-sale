/**
 * 🔥 Load Test — The Proof
 * 
 * Fires 500 concurrent requests SIMULTANEOUSLY for 10 items.
 * Expected result: EXACTLY 10 succeed, 490 get "sold out".
 * 
 * This proves the system NEVER oversells even under extreme concurrency.
 * 
 * Usage: node loadTest.js
 * (Make sure server is running: npm start)
 */

const http = require("http");

const SERVER = "http://localhost:3002";
const CONCURRENT_REQUESTS = 500; // Simulates 500 users clicking "Buy" at same moment
const STOCK_TO_SET = 10;         // Only 10 items available

// ─── Helper: HTTP POST ───────────────────────────────────────────
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, SERVER);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${SERVER}${path}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: true, raw: body, statusCode: res.statusCode });
        }
      });
    }).on("error", reject);
  });
}

// ─── Main Test ───────────────────────────────────────────────────
async function runLoadTest() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  ⚡ Flash Sale Load Test — Flipkart Style");
  console.log("═══════════════════════════════════════════════════\n");

  // Step 1: Reset sale with exactly 10 items
  console.log(`📦 Setting stock to ${STOCK_TO_SET} items...`);
  await post("/reset", { stock: STOCK_TO_SET });

  const before = await get("/stock");
  console.log(`📊 Stock before test: ${before.stock} items\n`);

  // Step 2: Fire all requests simultaneously
  console.log(`🔫 Firing ${CONCURRENT_REQUESTS} concurrent purchase requests...`);
  console.log(`   (Simulating ${CONCURRENT_REQUESTS} users clicking Buy at the SAME millisecond)\n`);

  const startTime = Date.now();

  // All requests fire at THE SAME TIME — this is the concurrency test
  const requests = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
    post("/buy", { userId: `user_${i + 1}`, productId: "IPHONE_15_PRO" })
  );

  const responses = await Promise.all(requests);
  const elapsed = Date.now() - startTime;

  // Step 3: Analyze results
  const successful = responses.filter((r) => r.status === 200);
  const soldOut    = responses.filter((r) => r.status === 409);
  const rateLimited = responses.filter((r) => r.status === 429);
  const errors     = responses.filter((r) => r.status >= 500);

  const after = await get("/stock");

  console.log("═══════════════════════════════════════════════════");
  console.log("  📊 RESULTS");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Total requests fired : ${CONCURRENT_REQUESTS}`);
  console.log(`  ✅ Successful orders : ${successful.length}`);
  console.log(`  ❌ Sold out (correct): ${soldOut.length}`);
  console.log(`  🚦 Rate limited      : ${rateLimited.length}`);
  console.log(`  💥 Server errors     : ${errors.length}`);
  console.log(`  📦 Stock remaining   : ${after.stock}`);
  console.log(`  ⏱️  Time elapsed      : ${elapsed}ms`);
  console.log("═══════════════════════════════════════════════════");

  // Step 4: Verdict
  console.log("\n  🔍 VERDICT:");
  if (successful.length === STOCK_TO_SET && after.stock === 0) {
    console.log(`  ✅ PERFECT! Exactly ${STOCK_TO_SET} orders placed.`);
    console.log(`  ✅ Stock = 0. Zero overselling. System is bulletproof!\n`);
  } else if (successful.length > STOCK_TO_SET) {
    console.log(`  ❌ OVERSELL DETECTED! ${successful.length} orders for ${STOCK_TO_SET} items!`);
    console.log(`  ❌ This means the atomic lock is NOT working.\n`);
  } else {
    console.log(`  ⚠️  ${successful.length} orders placed (expected ${STOCK_TO_SET}).`);
    console.log(`  Check server logs for details.\n`);
  }

  // Show who got the items
  if (successful.length > 0) {
    console.log("  🎉 Lucky winners:");
    successful.forEach((r) => console.log(`     - ${r.data.userId}: ${r.data.orderId?.slice(0, 8)}...`));
  }
  console.log("");
}

runLoadTest().catch(console.error);
