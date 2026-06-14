// Enrich Cosmos DB documents with ResourceName based on ResourceGuid mapping
// Run with: $env:COSMOS_KEY = az cosmosdb keys list --name husazcomoserverless --resource-group HusAzRGMoHajjCareAI --query primaryMasterKey -o tsv; node enrich-resources.js

const https = require('https');
const crypto = require('crypto');

const host = 'husazcomoserverless.documents.azure.com';
const key = process.env.COSMOS_KEY;
const dbId = 'HusAzConsumption';
const collId = 'HusAzConsumptionCosmoDB';

// ResourceGuid → ResourceName mapping
// Derived from: az functionapp list / az webapp list / az appservice plan list
// Note: ResourceGuid is a BILLING METER ID, not a per-resource identifier.
// Multiple App Service Plans can share the same meter if they use the same SKU.
const RESOURCE_MAP = {
  // P2v3 meter - shared by EP2 (HusAzFuncMoHajjDash6886WABAP1) and P2v3 (voice-myxi)
  '9003fa3d-5892-5a94-b9de-b6b5c151b84e': 'EP2+P2v3: HusAzFuncMoHajjDash6886WABAP1 + voice-myxi',
  // P1v3 meter - ASP-HusWABAGPT-880c → HusAzLbaikWebSite
  '6b4d6c1f-9d3d-5be4-8f90-9081da8b3551': 'P1v3: ASP-HusWABAGPT-880c → HusAzLbaikWebSite',
  // P1v3 meter (old/deleted plan, last seen Aug 2025)
  'cc850c00-f902-5960-a359-f3cd3abfccf5': 'P1v3: (decommissioned plan)',
  // Standard App / Static Web Apps
  '3503f67c-c189-5894-a06b-3ab051dc64f8': 'Static Web Apps (Standard)',
};

function generateAuth(verb, resourceType, resourceLink, date) {
  const text = `${verb}\n${resourceType}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(text).digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

function httpRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function queryDocs(sql, partitionKey) {
  let allDocs = [];
  let continuation = null;
  do {
    const date = new Date().toUTCString();
    const resourceLink = `dbs/${dbId}/colls/${collId}`;
    const token = generateAuth('post', 'docs', resourceLink, date);
    const body = JSON.stringify({ query: sql });
    const headers = {
      'Authorization': token,
      'x-ms-date': date,
      'x-ms-version': '2020-07-15',
      'Content-Type': 'application/query+json',
      'x-ms-documentdb-isquery': 'True',
      'x-ms-documentdb-partitionkey': JSON.stringify([partitionKey]),
      'x-ms-max-item-count': '1000',
      'Content-Length': Buffer.byteLength(body)
    };
    if (continuation) headers['x-ms-continuation'] = continuation;
    const res = await httpRequest({
      hostname: host, port: 443, method: 'POST',
      path: `/${resourceLink}/docs`, headers
    }, body);
    if (res.body.code) throw new Error(res.body.message);
    allDocs = allDocs.concat(res.body.Documents || []);
    continuation = res.headers['x-ms-continuation'] || null;
  } while (continuation);
  return allDocs;
}

async function upsertDoc(doc) {
  const date = new Date().toUTCString();
  const resourceLink = `dbs/${dbId}/colls/${collId}`;
  const token = generateAuth('post', 'docs', resourceLink, date);
  const body = JSON.stringify(doc);
  return httpRequest({
    hostname: host, port: 443, method: 'POST',
    path: `/${resourceLink}/docs`,
    headers: {
      'Authorization': token,
      'x-ms-date': date,
      'x-ms-version': '2020-07-15',
      'Content-Type': 'application/json',
      'x-ms-documentdb-is-upsert': 'True',
      'x-ms-documentdb-partitionkey': JSON.stringify([doc.ServiceName]),
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
}

async function main() {
  // Get all distinct ServiceNames (partition keys)
  const date = new Date().toUTCString();
  const resourceLink = `dbs/${dbId}/colls/${collId}`;
  const token = generateAuth('post', 'docs', resourceLink, date);
  const body = JSON.stringify({ query: 'SELECT DISTINCT c.ServiceName FROM c' });
  
  // Query each partition for docs that need enrichment
  const guids = Object.keys(RESOURCE_MAP);
  let totalUpdated = 0;
  let totalSkipped = 0;

  // Process partition: Azure App Service (where most plan costs live)
  const partitions = ['Azure App Service'];
  
  for (const partition of partitions) {
    console.log(`\nProcessing partition: ${partition}`);
    const docs = await queryDocs(
      `SELECT * FROM c WHERE IS_DEFINED(c.ResourceGuid) AND c.ResourceGuid IN ('9003fa3d-5892-5a94-b9de-b6b5c151b84e','6b4d6c1f-9d3d-5be4-8f90-9081da8b3551','cc850c00-f902-5960-a359-f3cd3abfccf5','3503f67c-c189-5894-a06b-3ab051dc64f8')`,
      partition
    );
    console.log(`  Found ${docs.length} docs without ResourceName`);

    const CONCURRENCY = 20;
    for (let i = 0; i < docs.length; i += CONCURRENCY) {
      const chunk = docs.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map(async (doc) => {
        const name = RESOURCE_MAP[doc.ResourceGuid];
        if (!name) return 'skip';
        if (doc.ResourceName === name) return 'skip'; // already correct
        doc.ResourceName = name;
        const res = await upsertDoc(doc);
        if (res.status >= 200 && res.status < 300) return 'ok';
        throw new Error(`${res.status}: ${res.body?.message || ''}`);
      }));

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value === 'ok') totalUpdated++;
        else if (r.status === 'fulfilled' && r.value === 'skip') totalSkipped++;
        else { console.error('  Error:', r.reason?.message); }
      }

      if ((i + CONCURRENCY) % 200 === 0 || i + CONCURRENCY >= docs.length) {
        console.log(`  Progress: ${Math.min(i + CONCURRENCY, docs.length)}/${docs.length} (${totalUpdated} updated, ${totalSkipped} no mapping)`);
      }
    }
  }

  console.log(`\nDone! Updated: ${totalUpdated}, Skipped (no mapping): ${totalSkipped}`);
}

main().catch(console.error);
