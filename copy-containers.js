// Copy documents from provisioned to serverless Cosmos DB
// Usage: node copy-containers.js
const https = require('https');
const crypto = require('crypto');

const SRC = { host: 'husazcosmodb.documents.azure.com', key: process.env.SRC_KEY };
const DST = { host: 'husazcomoserverless.documents.azure.com', key: process.env.DST_KEY };
const JOBS = [
  { db: 'HusAzMoHajj6886WABADashDemoDB', container: 'UnhealthyEndpoints', pk: '/type' },
  { db: 'HusAzMoHajjWABAAstt', container: 'SttTranscriptionLogs', pk: '/userPhone' },
  { db: 'MoHAJJKB', container: 'UploadedFiles', pk: '/language' }
];
const CONCURRENCY = 20;

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

async function getPartitionKeyRanges(account, db, container) {
  const date = new Date().toUTCString();
  const resourceLink = `dbs/${db}/colls/${container}`;
  const token = generateAuth(account.key, 'get', 'pkranges', resourceLink, date);
  const res = await httpRequest(account.host, {
    method: 'GET',
    path: `/${resourceLink}/pkranges`,
    headers: { 'Authorization': token, 'x-ms-date': date, 'x-ms-version': '2020-07-15' }
  });
  return res.body.PartitionKeyRanges || [];
}

async function readAllDocs(account, db, container) {
  const ranges = await getPartitionKeyRanges(account, db, container);
  const resourceLink = `dbs/${db}/colls/${container}`;
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

async function writeDoc(account, db, container, doc, pkPath) {
  const resourceLink = `dbs/${db}/colls/${container}`;
  const cleanDoc = { ...doc };
  delete cleanDoc._rid; delete cleanDoc._self; delete cleanDoc._etag; delete cleanDoc._attachments; delete cleanDoc._ts;
  const pkField = pkPath.replace('/', '');
  const pkValue = cleanDoc[pkField];
  const bodyStr = JSON.stringify(cleanDoc);

  for (let attempt = 0; attempt < 5; attempt++) {
    const date = new Date().toUTCString();
    const token = generateAuth(account.key, 'post', 'docs', resourceLink, date);
    const headers = {
      'Authorization': token,
      'x-ms-date': date,
      'x-ms-version': '2020-07-15',
      'Content-Type': 'application/json',
      'x-ms-documentdb-is-upsert': 'True',
      'x-ms-documentdb-partitionkey': JSON.stringify([pkValue]),
      'Content-Length': Buffer.byteLength(bodyStr)
    };
    const res = await httpRequest(account.host, { method: 'POST', path: `/${resourceLink}/docs`, headers }, bodyStr);
    if (res.status === 200 || res.status === 201) return res.status;
    if (res.status === 429) {
      const retryMs = parseInt(res.headers['x-ms-retry-after-ms'] || '1000');
      await new Promise(r => setTimeout(r, retryMs));
      continue;
    }
    throw new Error(`Write failed ${res.status}: ${JSON.stringify(res.body).substring(0, 200)}`);
  }
  throw new Error('Write failed after 5 retries (429)');
}

async function main() {
  for (const { db, container, pk } of JOBS) {
    console.log(`\n=== ${db}/${container} (pk=${pk}) ===`);
    console.log('Reading from provisioned...');
    const docs = await readAllDocs(SRC, db, container);
    console.log(`Found ${docs.length} documents`);
    
    if (docs.length === 0) {
      console.log('Empty container, nothing to copy');
      continue;
    }

    console.log(`Writing to serverless (${CONCURRENCY} concurrent)...`);
    let ok = 0, fail = 0;
    for (let i = 0; i < docs.length; i += CONCURRENCY) {
      const batch = docs.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(doc => writeDoc(DST, db, container, doc, pk))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') ok++;
        else { fail++; if (fail <= 3) console.error(`  Failed: ${r.reason.message}`); }
      }
      if (ok % 500 < CONCURRENCY) process.stdout.write(`  ${ok}/${docs.length} (${fail} failed)\r`);
    }
    console.log(`\nDone: ${ok} succeeded, ${fail} failed (total: ${docs.length})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
