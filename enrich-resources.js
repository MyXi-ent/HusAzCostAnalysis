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
  // === Azure App Service ===
  '9003fa3d-5892-5a94-b9de-b6b5c151b84e': 'EP2+P2v3: HusAzFuncMoHajjDash6886WABAP1 + voice-myxi',
  '6b4d6c1f-9d3d-5be4-8f90-9081da8b3551': 'P1v3: HusAzLbaikWebSite',
  'cc850c00-f902-5960-a359-f3cd3abfccf5': 'P1v3: (decommissioned)',
  '3503f67c-c189-5894-a06b-3ab051dc64f8': 'SWA Standard (9 sites)',
  'a1ce959d-dde2-4bb4-8a58-edfdeb780d93': 'B1: HusAzPlanAzFuncP1 → HusAzShortenURL',
  'c0f5cb45-6fb1-41c9-8545-72ad400d9da4': 'F1: ASP-HusWABAGPT-8b0c (free)',
  'a90aec9f-eecb-42c7-8421-9b96716996dc': 'F1: (secondary free plan)',

  // === Azure Cosmos DB ===
  '65d4ded2-41ae-43a8-bb68-3c200e1ba864': 'husazcomoserverless (100 RU/s provisioned)',
  '727a51cb-7521-54cf-b3e2-a7cca08da5c6': 'Serverless RUs (husazcomoserverless)',
  'adcb29f0-8680-51f6-b779-dd63b73ab68c': 'Serverless RUs (hajjaiportal live+staging)',
  '56f07b6a-c7d9-490f-a196-a7ee08e28712': 'Data Stored (all Cosmos accounts)',
  'dffc0580-fe39-515f-86af-7a5cf75b74d8': 'Geo-Replication Out',
  'adae3632-6f0c-5bc0-b864-b6a7b437438c': 'Geo-Replication In',

  // === Functions ===
  'df5a0f19-e5ba-4d46-95cd-0fb29c69e7cd': 'Premium vCPU: HusAzFuncMoHajjDash6886WABAP1',
  '08bfd03b-1cc7-43b7-bb94-66082518eeaf': 'Premium Memory: HusAzFuncMoHajjDash6886WABAP1',
  '64944692-160a-5ca0-9f88-c61776ca0142': 'Always Ready: HusAzFuncMoHajjDash6886WABAP1',
  '027afd58-24db-521f-8309-dcb3da519422': 'Always Ready Exec: HusAzFuncMoHajjDash6886WABAP1',
  'cd5d6bae-9b8d-5456-ab84-46919175c318': 'On Demand Exec (Consumption functions)',
  '4d397fba-0393-57dd-9da3-f145b5c874fe': 'On Demand Executions (Consumption)',
  '2a384075-01d7-4f66-a84a-0eed3ca58876': 'Standard Exec Time (Consumption)',
  '4e5cd9e2-c20f-4d7f-acbe-58931b8b49ef': 'Standard Executions (Consumption)',

  // === Logic Apps ===
  '2fd48189-4cef-5169-833e-dbc17ac026a8': 'Standard vCPU: Logic App (WS1 plan)',
  '0a17dfcc-18ca-5552-b366-3bf008196eeb': 'Standard Memory: Logic App (WS1 plan)',
  '3d2036fb-cad3-47cf-98cb-0a66f53be6cd': 'Consumption Connector Actions',
  '155afecf-5804-4ca4-ae3d-2cff595ab8d4': 'Consumption Built-in Actions',
  '3b2bbe89-0295-459e-b5e9-7e43b90318da': 'Consumption Data Retention',

  // === Storage ===
  'd2cf0979-a625-4486-850c-72803f3f953c': 'P10 Disk (husazrgmohajjcareaib8b9)',
  '93a6a529-4f49-47cb-9b1e-db9e5f23263f': 'P10 Disk (secondary)',
  'ac8f32dc-f93c-404f-b0cb-b5d707762170': 'S10 Disk',
  '82cd70ab-1aee-4b30-bc04-8b71e1204dbc': 'S4 Disk Ops',

  // === Service Bus ===
  '9d0c5c5c-f0ff-48c2-8c68-9ee7ffd306af': 'Standard: husazservicebusmohajwaba',
  '2a9992f8-e914-490b-a7a6-6d21ba55acda': 'Standard Ops: husazservicebusmohajwaba',
  '3c5657c6-28c7-49f0-9456-9a165161954d': 'Basic Ops: HusAzServiceBusMoHajjWABAstt',

  // === Web PubSub ===
  'a88ceb1c-e801-537a-a763-1b09134b3b7c': 'Standard: HusAzWebPubSubMoHajjProduction',
  'bf15064a-be7d-5e7c-9e7e-9d70bb9f2fcd': 'Standard Free: HusAzWebPubSubMoHajjWABADash',
  'fee389c9-b466-5ad0-bedb-bf148c21b9cd': 'Premium Unit',

  // === Virtual Machines ===
  'a96e144b-d24b-51ec-908c-fdde4bc98343': 'D16ads v5 (ADX dev cluster)',
  '5c09eef6-5022-552e-8726-28e053d3c88e': 'D16ds v5',
  '08345b3c-580c-5321-8022-21acb3d2ab1e': 'L8s v3',
  'c8513e64-a9e6-4872-940b-17e057af45b1': 'E2a v4',
  '8e8148de-1c42-4817-856a-18d03034b223': 'D2a v4',
  'ae331802-83a5-4b9e-b287-85675f794e3d': 'D2 v3',

  // === Azure Data Explorer ===
  '538134cc-807b-57c3-ae89-e4726202a6a2': 'Dev Cluster Markup (ADX)',

  // === Azure Container Apps ===
  '2937c12a-555a-58f0-86fb-11db356f5fb0': 'vCPU Idle (Qdrant container)',
  'ba69f1c7-e68f-56b1-bc7e-79aa26713625': 'vCPU Active (Qdrant container)',
  'f3d673ac-8004-5c9e-a541-8c9eaac1dfea': 'Memory Active (Qdrant container)',
  'ac22f07d-3385-5dca-a67a-c888b544b546': 'Memory Idle (Qdrant container)',

  // === Log Analytics ===
  'ec00a25a-ab14-4b7b-a94f-66581f123295': 'Data Ingestion (workspace 1)',
  'ffbd06c0-e72e-42b6-b612-f03144b476df': 'Data Ingestion (workspace 2)',

  // === Azure Front Door ===
  '7e3eab72-0b95-5524-984a-d1697f73feee': 'Standard Base Fee (AFD profile)',

  // === Azure Database for MySQL ===
  '0fdef79c-c8a9-554e-a56f-501700548af2': 'B1ms Flexible Server',
  '68269786-3d2e-5c91-b144-6fc6e04e3f58': 'MySQL Storage',
  '655d488e-e818-5ace-8848-d0b5cb00ae71': 'MySQL IO',

  // === Azure Grafana Service ===
  'e23843ad-347d-5c3e-87d5-10d44cf30763': 'Standard User',
  'e29ce018-10e6-593f-8df9-3fd983f6b2da': 'Standard Node',

  // === Messaging (ACS) ===
  '5b15a006-77b6-5801-879e-98c1f2dfca7c': 'ACS Messages',
  '350f2fb8-597b-5a68-ba1f-d2d348163024': 'WhatsApp Consumption',

  // === Key Vault ===
  '0f824807-2376-435c-95c9-f992b67a07b0': 'Key Vault Operations',

  // === API Management ===
  '18a9ca11-300f-419a-9cd4-e9d5224c28f1': 'APIM Consumption Calls',
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

  // Process all partitions that have mappable ResourceGuids
  const partitions = [
    'Azure App Service', 'Azure Cosmos DB', 'Functions', 'Logic Apps',
    'Storage', 'Service Bus', 'Web PubSub', 'Virtual Machines',
    'Azure Data Explorer', 'Azure Container Apps', 'Log Analytics',
    'Azure Front Door Service', 'Azure Database for MySQL',
    'Azure Grafana Service', 'Messaging', 'Key Vault', 'API Management'
  ];
  
  const allGuids = Object.keys(RESOURCE_MAP);
  const guidList = allGuids.map(g => `'${g}'`).join(',');
  
  for (const partition of partitions) {
    console.log(`\nProcessing partition: ${partition}`);
    const docs = await queryDocs(
      `SELECT * FROM c WHERE IS_DEFINED(c.ResourceGuid) AND c.ResourceGuid IN (${guidList})`,
      partition
    );
    console.log(`  Found ${docs.length} docs to process`);

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
