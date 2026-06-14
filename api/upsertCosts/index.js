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
  // Deterministic ID from Date + ServiceName + ServiceResource to enable upsert
  const key = `${doc.Date}|${doc.ServiceName || ''}|${doc.ServiceType || ''}|${doc.ServiceResource || ''}`;
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
      'x-ms-documentdb-partitionkey': JSON.stringify([doc.Date]),
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  return res;
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

  let succeeded = 0;
  let failed = 0;
  const errors = [];

  for (const raw of docs) {
    try {
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
        Quantity: raw.Quantity ?? raw.quantity ?? 0,
        Cost: raw.Cost ?? raw.cost ?? 0
      };

      if (!doc.Date) {
        failed++;
        if (errors.length < 10) errors.push(`Doc missing Date field, keys: ${Object.keys(raw).join(',')}`);
        continue;
      }

      const res = await upsertDoc(doc);
      if (res.status >= 200 && res.status < 300) {
        succeeded++;
      } else {
        failed++;
        const errMsg = `Cosmos ${res.status}: ${typeof res.body === 'object' ? (res.body.message || JSON.stringify(res.body).substring(0, 200)) : String(res.body).substring(0, 200)}`;
        context.log.error(errMsg);
        if (errors.length < 10) errors.push(errMsg);
      }
    } catch (err) {
      failed++;
      context.log.error('Upsert exception:', err.message, err.stack?.substring(0, 200));
      if (errors.length < 10) errors.push(err.message);
    }
  }

  context.log(`Upsert complete: ${succeeded} succeeded, ${failed} failed, errors: ${JSON.stringify(errors)}`);
  const status = failed === 0 ? 200 : (succeeded > 0 ? 207 : 500);
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: { succeeded, failed, total: docs.length, errors }
  };
};
