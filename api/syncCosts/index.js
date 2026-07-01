/**
 * syncCosts — Fetches cost data from Azure Cost Management Query API
 * and upserts into the existing Cosmos DB container.
 *
 * Uses Microsoft.CostManagement/query (works with sponsored subscriptions).
 * The Consumption/usageDetails API does NOT work with sponsored subs.
 *
 * Env vars required:
 *   ARM_TENANT_ID, ARM_CLIENT_ID, ARM_CLIENT_SECRET, ARM_SUBSCRIPTION_ID
 *   COSMOS_KEY (for Cosmos upsert)
 *
 * Call: POST /api/syncCosts  body: { "days": 5 }  (optional, default 2)
 *
 * Field mapping (Cost Management Query API → Cosmos):
 *   Row[0] (Cost)              → Cost
 *   Row[1] (UsageQuantity)     → Quantity
 *   Row[2] (UsageDate YYYYMMDD)→ Date (as "YYYY-MM-DDT00:00:00")
 *   Row[3] (MeterCategory)     → ServiceName
 *   Row[4] (MeterSubcategory)  → ServiceType
 *   Row[5] (Meter)             → ServiceResource
 *   Row[6] (ResourceId)        → ResourceName (last path segment)
 *   "Xi_Sponsored_Subscription"→ SubscriptionName
 *   subscriptionId             → SubscriptionGuid
 */
const https = require("https");
const crypto = require("crypto");

// ─── Azure ARM Auth ───────────────────────────────────────────────────────────
const tenantId = process.env.ARM_TENANT_ID;
const clientId = process.env.ARM_CLIENT_ID;
const clientSecret = process.env.ARM_CLIENT_SECRET;
const subscriptionId = process.env.ARM_SUBSCRIPTION_ID;

// ─── Cosmos DB ────────────────────────────────────────────────────────────────
const cosmosHost = "husazcomoserverless.documents.azure.com";
const cosmosKey = process.env.COSMOS_KEY;
const dbId = "HusAzConsumption";
const collId = "HusAzConsumptionCosmoDB";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function httpPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, port: 443, method: "POST", path, headers };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, port: 443, method: "GET", path, headers };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getArmToken() {
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&scope=https%3A%2F%2Fmanagement.azure.com%2F.default`;
  const result = await httpPost(
    "login.microsoftonline.com",
    `/${tenantId}/oauth2/v2.0/token`,
    body,
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
  );
  if (!result.body.access_token) {
    throw new Error(`Token failed: ${result.body.error_description || JSON.stringify(result.body)}`);
  }
  return result.body.access_token;
}

// ─── Cosmos Upsert ────────────────────────────────────────────────────────────
function generateCosmosAuth(verb, resourceType, resourceLink, date) {
  const text = `${verb}\n${resourceType}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac("sha256", Buffer.from(cosmosKey, "base64")).update(text).digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

function generateDocId(doc) {
  const key = `${doc.Date}|${doc.ServiceName || ""}|${doc.ServiceType || ""}|${doc.ServiceResource || ""}|${doc.ResourceName || ""}`;
  return crypto.createHash("md5").update(key).digest("hex");
}

async function upsertDoc(doc) {
  const date = new Date().toUTCString();
  const resourceLink = `dbs/${dbId}/colls/${collId}`;
  const token = generateCosmosAuth("post", "docs", resourceLink, date);
  const body = JSON.stringify(doc);

  return httpPost(cosmosHost, `/${resourceLink}/docs`, body, {
    Authorization: token,
    "x-ms-date": date,
    "x-ms-version": "2020-07-15",
    "Content-Type": "application/json",
    "x-ms-documentdb-is-upsert": "True",
    "x-ms-documentdb-partitionkey": JSON.stringify([doc.ServiceName]),
    "Content-Length": Buffer.byteLength(body),
  });
}

// ─── Fetch Cost Data (Cost Management Query API) ─────────────────────────────
async function fetchCostData(token, startDate, endDate) {
  const allRows = [];
  const body = JSON.stringify({
    type: "ActualCost",
    dataSet: {
      granularity: "Daily",
      aggregation: {
        totalCost: { name: "Cost", function: "Sum" },
        totalQuantity: { name: "UsageQuantity", function: "Sum" },
      },
      grouping: [
        { type: "Dimension", name: "MeterCategory" },
        { type: "Dimension", name: "MeterSubcategory" },
        { type: "Dimension", name: "Meter" },
        { type: "Dimension", name: "ResourceId" },
      ],
    },
    timeframe: "Custom",
    timePeriod: { from: startDate, to: endDate },
  });

  let nextLink = `/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;

  while (nextLink) {
    const isFullUrl = nextLink.startsWith("https://");
    const hostname = isFullUrl ? new URL(nextLink).hostname : "management.azure.com";
    const path = isFullUrl ? nextLink.replace(`https://${hostname}`, "") : nextLink;
    const isPost = !isFullUrl; // first request is POST, nextLink pages are GET

    let res;
    if (isPost) {
      res = await httpPost(hostname, path, body, {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
    } else {
      res = await httpGet(hostname, path, { Authorization: `Bearer ${token}` });
    }

    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 30000));
      continue;
    }
    if (res.status !== 200) {
      throw new Error(`Cost API ${res.status}: ${JSON.stringify(res.body).substring(0, 300)}`);
    }

    const rows = res.body.properties?.rows || [];
    allRows.push(...rows);
    nextLink = res.body.properties?.nextLink || null;
  }

  return allRows;
}

// ─── Map API row → Cosmos document ────────────────────────────────────────────
// Row format: [Cost, UsageQuantity, UsageDate(YYYYMMDD), MeterCategory, MeterSubcategory, Meter, ResourceId, Currency]
function mapRowToCosmos(row) {
  const cost = row[0] || 0;
  const quantity = row[1] || 0;
  const dateNum = String(row[2]);
  const dateStr = `${dateNum.substring(0, 4)}-${dateNum.substring(4, 6)}-${dateNum.substring(6, 8)}`;
  const meterCategory = row[3] || "";
  const meterSubcategory = row[4] || "";
  const meter = row[5] || "";
  const resourceId = row[6] || "";
  const resourceName = resourceId.split("/").pop() || "";

  const doc = {
    Date: `${dateStr}T00:00:00`,
    SubscriptionName: "Xi_Sponsored_Subscription",
    SubscriptionGuid: subscriptionId,
    ResourceGuid: "",
    ServiceName: meterCategory,
    ServiceType: meterSubcategory,
    ServiceRegion: "",
    ServiceResource: meter,
    ResourceName: resourceName,
    Quantity: quantity,
    Cost: cost,
  };
  doc.id = generateDocId(doc);
  return doc;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  context.log("syncCosts invoked");

  // Validate env vars
  if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
    context.res = { status: 500, body: { error: "Missing ARM_TENANT_ID/ARM_CLIENT_ID/ARM_CLIENT_SECRET/ARM_SUBSCRIPTION_ID" } };
    return;
  }
  if (!cosmosKey) {
    context.res = { status: 500, body: { error: "Missing COSMOS_KEY" } };
    return;
  }

  const days = Math.min(Math.max(1, parseInt(req.body?.days) || 2), 30);
  const now = new Date();
  const endDate = now.toISOString().split("T")[0];
  const startDate = new Date(now.getTime() - days * 86400000).toISOString().split("T")[0];

  context.log(`Fetching usage details: ${startDate} to ${endDate} (${days} days)`);

  try {
    // 1. Get ARM token
    const token = await getArmToken();
    context.log("ARM token acquired");

    // 2. Fetch cost data from Cost Management Query API
    const rows = await fetchCostData(token, startDate, endDate);
    context.log(`Fetched ${rows.length} cost rows from API`);

    if (rows.length === 0) {
      context.res = { status: 200, body: { message: "No records found for date range", startDate, endDate, synced: 0 } };
      return;
    }

    // 3. Map and upsert to Cosmos
    let succeeded = 0;
    let failed = 0;
    const errors = [];
    const CONCURRENCY = 20;
    const docs = rows.map(mapRowToCosmos);

    for (let i = 0; i < docs.length; i += CONCURRENCY) {
      const chunk = docs.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((doc) => upsertDoc(doc)));

      for (const r of results) {
        if (r.status === "fulfilled" && r.value.status >= 200 && r.value.status < 300) {
          succeeded++;
        } else {
          failed++;
          const msg = r.status === "fulfilled"
            ? `Cosmos ${r.value.status}: ${JSON.stringify(r.value.body).substring(0, 150)}`
            : r.reason?.message || "Unknown";
          if (errors.length < 5) errors.push(msg);
        }
      }

      // Log progress every 200
      if (i % 200 === 0 && i > 0) {
        context.log(`Progress: ${i}/${docs.length} — OK: ${succeeded}, Fail: ${failed}`);
      }
    }

    context.log(`syncCosts done: ${succeeded} succeeded, ${failed} failed`);
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { startDate, endDate, fetched: rows.length, succeeded, failed, errors },
    };
  } catch (err) {
    context.log.error("syncCosts failed:", err.message);
    context.res = { status: 500, body: { error: err.message } };
  }
};
