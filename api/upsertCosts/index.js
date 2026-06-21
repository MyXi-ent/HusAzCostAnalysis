const https = require('https');
const crypto = require('crypto');

const host = 'husazcomoserverless.documents.azure.com';
const key = process.env.COSMOS_KEY;
const dbId = 'HusAzConsumption';
const collId = 'HusAzConsumptionCosmoDB';

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
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function generateDocId(doc) {
  // Deterministic ID from Date + ServiceName + ServiceResource + ResourceName to enable upsert
  const resName = doc.ResourceName || doc.resourceName || '';
  const key = `${doc.Date}|${doc.ServiceName || ''}|${doc.ServiceType || ''}|${doc.ServiceResource || ''}|${resName}`;
  return crypto.createHash('md5').update(key).digest('hex');
}

async function upsertDoc(doc) {
  const date = new Date().toUTCString();
  const resourceLink = `dbs/${dbId}/colls/${collId}`;
  const token = generateAuth('post', 'docs', resourceLink, date);
  const body = JSON.stringify(doc);

  const res = await httpRequest({
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

  return res;
}

async function getDocCount() {
  const date = new Date().toUTCString();
  const resourceLink = `dbs/${dbId}/colls/${collId}`;
  const token = generateAuth('post', 'docs', resourceLink, date);
  const body = JSON.stringify({ query: 'SELECT VALUE COUNT(1) FROM c' });
  const res = await httpRequest({
    hostname: host, port: 443, method: 'POST',
    path: `/${resourceLink}/docs`,
    headers: {
      'Authorization': token,
      'x-ms-date': date,
      'x-ms-version': '2020-07-15',
      'Content-Type': 'application/query+json',
      'x-ms-documentdb-isquery': 'True',
      'x-ms-documentdb-query-enablecrosspartition': 'True',
      'x-ms-max-item-count': '1',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  const docs = res.body?.Documents || [];
  return docs[0] || 0;
}

module.exports = async function (context, req) {
  context.log('upsertCosts invoked, body type:', typeof req.body, 'isArray:', Array.isArray(req.body));

  if (!req.body) {
    context.log.error('Request body is null/undefined');
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'Request body is empty' } };
    return;
  }

  const docs = req.body;
  if (!Array.isArray(docs)) {
    context.log.error('Body is not an array, keys:', Object.keys(docs || {}).slice(0, 5));
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: `Request body must be an array, got ${typeof docs}` } };
    return;
  }

  if (docs.length === 0) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'Array is empty' } };
    return;
  }

  // Limit batch size to prevent timeouts (5 min function timeout)
  if (docs.length > 5000) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: `Too many documents (${docs.length}). Max 5000 per batch.` } };
    return;
  }

  context.log(`Processing ${docs.length} documents. First doc keys:`, Object.keys(docs[0] || {}));

  const countBefore = await getDocCount();
  context.log(`Document count before upsert: ${countBefore}`);

  let succeeded = 0;
  let failed = 0;
  const errors = [];
  const CONCURRENCY = 20;

  function prepareDoc(raw) {
    const doc = {
      id: generateDocId(raw),
      Date: raw.Date || raw.date,
      SubscriptionName: raw.SubscriptionName || raw.subscriptionName || 'Xi_Sponsored_Subscription',
      SubscriptionGuid: raw.SubscriptionGuid || raw.subscriptionGuid || '75920ee3-5dda-44fd-89ea-619c3265442e',
      ResourceGuid: raw.ResourceGuid || raw.resourceGuid || '',
      ServiceName: raw.ServiceName || raw.serviceName || '',
      ServiceType: raw.ServiceType || raw.serviceType || '',
      ServiceRegion: raw.ServiceRegion || raw.serviceRegion || '',
      ServiceResource: raw.ServiceResource || raw.serviceResource || '',
      ResourceName: raw.ResourceName || raw.resourceName || '',
      Quantity: raw.Quantity ?? raw.quantity ?? 0,
      Cost: raw.Cost ?? raw.cost ?? 0
    };
    return doc;
  }

  // Process in parallel with concurrency limit
  for (let i = 0; i < docs.length; i += CONCURRENCY) {
    const chunk = docs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (raw) => {
      const doc = prepareDoc(raw);
      if (!doc.Date) throw new Error('Missing Date field');
      return upsertDoc(doc);
    }));

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.status >= 200 && r.value.status < 300) {
          succeeded++;
        } else {
          failed++;
          const errMsg = `Cosmos ${r.value.status}: ${typeof r.value.body === 'object' ? (r.value.body.message || JSON.stringify(r.value.body).substring(0, 200)) : String(r.value.body).substring(0, 200)}`;
          if (errors.length < 10) errors.push(errMsg);
        }
      } else {
        failed++;
        if (errors.length < 10) errors.push(r.reason?.message || 'Unknown error');
      }
    }
  }

  const countAfter = await getDocCount();
  const newRecords = countAfter - countBefore;
  context.log(`Upsert complete: ${succeeded} succeeded, ${failed} failed, new records: ${newRecords}, errors: ${JSON.stringify(errors)}`);
  const status = failed === 0 ? 200 : (succeeded > 0 ? 207 : 500);
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: { succeeded, failed, total: docs.length, newRecords, errors }
  };
};
