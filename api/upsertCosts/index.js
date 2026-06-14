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
  context.log('upsertCosts invoked');

  const docs = req.body;
  if (!Array.isArray(docs) || docs.length === 0) {
    context.res = { status: 400, body: { error: 'Request body must be a non-empty array of cost documents' } };
    return;
  }

  // Limit batch size to prevent timeouts (5 min function timeout)
  if (docs.length > 5000) {
    context.res = { status: 400, body: { error: `Too many documents (${docs.length}). Max 5000 per batch.` } };
    return;
  }

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
        errors.push('Document missing Date field');
        continue;
      }

      const res = await upsertDoc(doc);
      if (res.status >= 200 && res.status < 300) {
        succeeded++;
      } else {
        failed++;
        if (errors.length < 5) errors.push(`${res.status}: ${res.body?.message || JSON.stringify(res.body).substring(0, 100)}`);
      }
    } catch (err) {
      failed++;
      if (errors.length < 5) errors.push(err.message);
    }
  }

  context.log(`Upsert complete: ${succeeded} succeeded, ${failed} failed`);
  const status = failed === 0 ? 200 : (succeeded > 0 ? 207 : 500);
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: { succeeded, failed, total: docs.length, errors }
  };
};
