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
 * Optional: ARM_SUBSCRIPTIONS — JSON array to sync more than one subscription:
 *   [{"name":"Xi_Sponsored_2","id":"<guid>"},
 *    {"name":"Xi_Sponsored_Subscription_NEW","id":"<guid>","cred":"XI"}]
 *   `cred` selects an alternate credential set (ARM_XI_TENANT_ID, ARM_XI_CLIENT_ID,
 *   ARM_XI_CLIENT_SECRET), needed when a subscription lives in a different tenant.
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
 *   subscription name          → SubscriptionName
 *   subscription id            → SubscriptionGuid
 */
const https = require("https");
const crypto = require("crypto");

// ─── Azure ARM Auth ───────────────────────────────────────────────────────────
// Credentials default to the ARM_* vars. A subscription may name an alternate
// credential set via `cred`, resolving to ARM_<CRED>_TENANT_ID / _CLIENT_ID /
// _CLIENT_SECRET. This is mandatory for subscriptions in another tenant: a
// single-tenant app registration cannot issue a token for a tenant it is not in.
function resolveCredentials(cred) {
  const prefix = cred ? `ARM_${String(cred).toUpperCase()}_` : "ARM_";
  return {
    tenantId: process.env[`${prefix}TENANT_ID`] || process.env.ARM_TENANT_ID,
    clientId: process.env[`${prefix}CLIENT_ID`] || process.env.ARM_CLIENT_ID,
    clientSecret: process.env[`${prefix}CLIENT_SECRET`] || process.env.ARM_CLIENT_SECRET,
  };
}

function resolveSubscriptions() {
  const raw = process.env.ARM_SUBSCRIPTIONS;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("ARM_SUBSCRIPTIONS must be a non-empty JSON array");
    }
    for (const s of parsed) {
      if (!s.id || !s.name) throw new Error("each ARM_SUBSCRIPTIONS entry needs both id and name");
    }
    return parsed;
  }
  if (!process.env.ARM_SUBSCRIPTION_ID) return [];
  return [{ name: "Xi_Sponsored_Subscription", id: process.env.ARM_SUBSCRIPTION_ID }];
}

// Documents for this subscription keep the original id formula, so the existing
// Cosmos records are updated in place instead of being duplicated alongside new ones.
const LEGACY_ID_SUBSCRIPTION = "75920ee3-5dda-44fd-89ea-619c3265442e";

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
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
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

async function getArmToken(cred) {
  const { tenantId, clientId, clientSecret } = resolveCredentials(cred);
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(`Missing credentials for cred=${cred || "default"}`);
  }
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
  // Meter identity is only unique within a subscription, so anything other than the
  // original subscription is namespaced by its guid to avoid cross-subscription
  // records overwriting each other.
  const scope = doc.SubscriptionGuid === LEGACY_ID_SUBSCRIPTION ? "" : `${doc.SubscriptionGuid}|`;
  const key = `${scope}${doc.Date}|${doc.ServiceName || ""}|${doc.ServiceType || ""}|${doc.ServiceResource || ""}|${doc.ResourceName || ""}`;
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
async function fetchCostData(getToken, subscriptionId, startDate, endDate) {
  const allRows = [];
  const body = JSON.stringify({
    type: "ActualCost",
    dataset: {
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

  let nextLink = `/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2026-06-01`;
  let retries429 = 0;
  let tokenRefreshes = 0;
  // Cost Management advertises Retry-After: 60 but the throttle window is far
  // longer in practice, so honour the header as a floor and back off beyond it.
  const MAX_429_RETRIES = parseInt(process.env.COST_API_MAX_RETRIES || "20", 10);
  const MAX_BACKOFF_SECONDS = 300;

  while (nextLink) {
    const isFullUrl = nextLink.startsWith("https://");
    const hostname = isFullUrl ? new URL(nextLink).hostname : "management.azure.com";
    const path = isFullUrl ? nextLink.replace(`https://${hostname}`, "") : nextLink;

    let res = await httpPost(hostname, path, body, {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });

    // A long throttle backoff can outlive the token, so mint a new one and retry.
    if (res.status === 401 && JSON.stringify(res.body).includes("ExpiredAuthenticationToken")) {
      if (++tokenRefreshes > 5) throw new Error("ARM token kept expiring — giving up");
      console.warn("ARM token expired during backoff — refreshing");
      await getToken(true);
      continue;
    }

    if (res.status === 429) {
      retries429++;
      if (retries429 > MAX_429_RETRIES) throw new Error(`Cost API 429 after ${MAX_429_RETRIES} retries — rate limit not clearing`);
      const retryAfter = parseInt(res.headers?.["retry-after"] || res.headers?.["x-ms-ratelimit-microsoft.consumption-retry-after"] || "60", 10);
      const wait = Math.min(Math.max(retryAfter, 30 * 2 ** (retries429 - 1)), MAX_BACKOFF_SECONDS);
      console.warn(`Cost API 429 — retry ${retries429}/${MAX_429_RETRIES} in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    retries429 = 0;
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
function mapRowToCosmos(row, sub) {
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
    SubscriptionName: sub.name,
    SubscriptionGuid: sub.id,
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

  if (!cosmosKey) {
    context.res = { status: 500, body: { error: "Missing COSMOS_KEY" } };
    return;
  }

  let subscriptions;
  try {
    subscriptions = resolveSubscriptions();
  } catch (err) {
    context.res = { status: 500, body: { error: `Invalid ARM_SUBSCRIPTIONS: ${err.message}` } };
    return;
  }
  if (subscriptions.length === 0) {
    context.res = { status: 500, body: { error: "No subscriptions configured (set ARM_SUBSCRIPTION_ID or ARM_SUBSCRIPTIONS)" } };
    return;
  }

  let startDate, endDate;
  if (req.body?.startDate && req.body?.endDate) {
    startDate = req.body.startDate;
    endDate = req.body.endDate;
  } else {
    const days = Math.min(Math.max(1, parseInt(req.body?.days) || 2), 30);
    const now = new Date();
    endDate = now.toISOString().split("T")[0];
    startDate = new Date(now.getTime() - days * 86400000).toISOString().split("T")[0];
  }

  context.log(`Fetching ${startDate} to ${endDate} for ${subscriptions.length} subscription(s)`);

  // One token per credential set, shared by every subscription using it.
  // Throttle backoff can outlast the hour-long token lifetime, so callers can
  // force a refresh after an ExpiredAuthenticationToken.
  const tokenCache = new Map();
  async function tokenFor(cred, forceRefresh) {
    const key = cred || "default";
    if (forceRefresh) tokenCache.delete(key);
    if (!tokenCache.has(key)) tokenCache.set(key, await getArmToken(cred));
    return tokenCache.get(key);
  }

  const CONCURRENCY = 20;
  const results = [];
  let totalFetched = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  // A failure on one subscription must not abort the others
  for (const sub of subscriptions) {
    try {
      const rows = await fetchCostData((force) => tokenFor(sub.cred, force), sub.id, startDate, endDate);
      context.log(`${sub.name}: fetched ${rows.length} rows`);
      totalFetched += rows.length;

      if (rows.length === 0) {
        results.push({ subscription: sub.name, fetched: 0, succeeded: 0, failed: 0 });
        continue;
      }

      let succeeded = 0;
      let failed = 0;
      const errors = [];
      const docs = rows.map((row) => mapRowToCosmos(row, sub));

      for (let i = 0; i < docs.length; i += CONCURRENCY) {
        const chunk = docs.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(chunk.map((doc) => upsertDoc(doc)));

        for (const r of settled) {
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
      }

      totalSucceeded += succeeded;
      totalFailed += failed;
      context.log(`${sub.name}: ${succeeded} ok, ${failed} failed`);
      results.push({ subscription: sub.name, fetched: rows.length, succeeded, failed, errors });
    } catch (err) {
      context.log.error(`${sub.name} failed:`, err.message);
      results.push({ subscription: sub.name, error: err.message });
    }
  }

  const allFailed = results.every((r) => r.error);
  context.res = {
    status: allFailed ? 500 : 200,
    headers: { "Content-Type": "application/json" },
    body: {
      startDate,
      endDate,
      fetched: totalFetched,
      succeeded: totalSucceeded,
      failed: totalFailed,
      subscriptions: results,
    },
  };
};
