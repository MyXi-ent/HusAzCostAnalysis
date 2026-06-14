// Copy documents from provisioned to serverless Cosmos DB
// Usage: node copy-containers.js
const https = require('https');
const crypto = require('crypto');

const SRC = { host: 'husazcosmodb.documents.azure.com', key: process.env.SRC_KEY };
const DST = { host: 'husazcomoserverless.documents.azure.com', key: process.env.DST_KEY };
const DB = 'HusAzMoHajj6886WABADashDemoDB';
const CONTAINERS = ['StressTestV13Threads', 'StressTestV14Threads', 'HusAzCosmoMoHajj6886OpenAiAssistStressTest'];

function generateAuth(key, verb, resourceType, resourceLink, date) {
  const text = `${verb}\n${resourceType}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(text).digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

function httpRequest(host, opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, port: 443, ...opts }, res => {
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

async function getPartitionKeyRanges(account, container) {
  const date = new Date().toUTCString();
  const resourceLink = `dbs/${DB}/colls/${container}`;
  const token = generateAuth(account.key, 'get', 'pkranges', resourceLink, date);
  const res = await httpRequest(account.host, {
    method: 'GET',
    path: `/${resourceLink}/pkranges`,
    headers: { 'Authorization': token, 'x-ms-date': date, 'x-ms-version': '2020-07-15' }
  });
  return res.body.PartitionKeyRanges || [];
}

async function readAllDocs(account, container) {
  const ranges = await getPartitionKeyRanges(account, container);
  const resourceLink = `dbs/${DB}/colls/${container}`;
  const docs = [];
  for (const range of ranges) {
    let continuation = null;
    do {
      const date = new Date().toUTCString();
      const token = generateAuth(account.key, 'post', 'docs', resourceLink, date);
      const headers = {
        'Authorization': token,
        'x-ms-date': date,
        'x-ms-version': '2020-07-15',
        'Content-Type': 'application/query+json',
        'x-ms-documentdb-isquery': 'True',
        'x-ms-documentdb-partitionkeyrangeid': range.id,
        'x-ms-max-item-count': '1000'
      };
      if (continuation) headers['x-ms-continuation'] = continuation;
      const body = JSON.stringify({ query: 'SELECT * FROM c' });
      headers['Content-Length'] = Buffer.byteLength(body);
      const res = await httpRequest(account.host, { method: 'POST', path: `/${resourceLink}/docs`, headers }, body);
      if (res.body.code) throw new Error(`Read failed: ${res.body.message}`);
      docs.push(...(res.body.Documents || []));
      continuation = res.headers['x-ms-continuation'] || null;
    } while (continuation);
  }
  return docs;
}

async function writeDoc(account, container, doc, pkPath) {
  const resourceLink = `dbs/${DB}/colls/${container}`;
  const date = new Date().toUTCString();
  const token = generateAuth(account.key, 'post', 'docs', resourceLink, date);
  const cleanDoc = { ...doc };
  delete cleanDoc._rid; delete cleanDoc._self; delete cleanDoc._etag; delete cleanDoc._attachments; delete cleanDoc._ts;
  
  // Extract partition key value from document
  const pkField = pkPath.replace('/', '');
  const pkValue = cleanDoc[pkField];
  
  const body = JSON.stringify(cleanDoc);
  const headers = {
    'Authorization': token,
    'x-ms-date': date,
    'x-ms-version': '2020-07-15',
    'Content-Type': 'application/json',
    'x-ms-documentdb-is-upsert': 'True',
    'x-ms-documentdb-partitionkey': JSON.stringify([pkValue]),
    'Content-Length': Buffer.byteLength(body)
  };
  const res = await httpRequest(account.host, { method: 'POST', path: `/${resourceLink}/docs`, headers }, body);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Write failed ${res.status}: ${JSON.stringify(res.body).substring(0, 200)}`);
  }
  return res.status;
}

async function main() {
  const pkPath = '/id'; // all 3 stress test containers use /id
  for (const container of CONTAINERS) {
    console.log(`\n=== ${container} ===`);
    console.log('Reading from provisioned...');
    const docs = await readAllDocs(SRC, container);
    console.log(`Found ${docs.length} documents`);
    
    if (docs.length === 0) {
      console.log('Empty container, nothing to copy');
      continue;
    }

    console.log('Writing to serverless...');
    let ok = 0, fail = 0;
    for (const doc of docs) {
      try {
        await writeDoc(DST, container, doc, pkPath);
        ok++;
        if (ok % 100 === 0) process.stdout.write(`  ${ok}/${docs.length}\r`);
      } catch (e) {
        fail++;
        if (fail <= 3) console.error(`  Failed doc ${doc.id}: ${e.message}`);
      }
    }
    console.log(`\nDone: ${ok} succeeded, ${fail} failed (total: ${docs.length})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
