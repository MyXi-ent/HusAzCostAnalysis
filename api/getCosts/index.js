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
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getPartitionKeyRanges() {
  const date = new Date().toUTCString();
  const resourceLink = `dbs/${dbId}/colls/${collId}`;
  const token = generateAuth('get', 'pkranges', resourceLink, date);
  const res = await httpRequest({
    hostname: host, port: 443, method: 'GET',
    path: `/${resourceLink}/pkranges`,
    headers: {
      'Authorization': token,
      'x-ms-date': date,
      'x-ms-version': '2020-07-15'
    }
  });
  return res.body.PartitionKeyRanges || [];
}

async function cosmosQuery(sql, parameters) {
  const ranges = await getPartitionKeyRanges();
  let allDocs = [];
  for (const range of ranges) {
    let continuation = null;
    do {
      const date = new Date().toUTCString();
      const resourceLink = `dbs/${dbId}/colls/${collId}`;
      const token = generateAuth('post', 'docs', resourceLink, date);
      const body = JSON.stringify(parameters ? { query: sql, parameters } : { query: sql });
      const headers = {
        'Authorization': token,
        'x-ms-date': date,
        'x-ms-version': '2020-07-15',
        'Content-Type': 'application/query+json',
        'x-ms-documentdb-isquery': 'True',
        'x-ms-documentdb-partitionkeyrangeid': range.id,
        'x-ms-max-item-count': '1000',
        'Content-Length': Buffer.byteLength(body)
      };
      if (continuation) headers['x-ms-continuation'] = continuation;
      const res = await httpRequest({
        hostname: host, port: 443, method: 'POST',
        path: `/${resourceLink}/docs`,
        headers
      }, body);
      if (res.body.code) throw new Error(res.body.message);
      allDocs = allDocs.concat(res.body.Documents || []);
      continuation = res.body._continuation || null;
    } while (continuation);
  }
  return allDocs;
}

module.exports = async function (context, req) {
  context.log('getCosts function invoked', { method: req.method, url: req.url });
  const startDate = req.query.startDate || req.body?.startDate;
  const endDate = req.query.endDate || req.body?.endDate;

  if (!startDate || !endDate) {
    context.log.warn('Missing date parameters', { startDate, endDate });
    context.res = { status: 400, body: { error: 'startDate and endDate required' } };
    return;
  }

  context.log(`Querying Cosmos DB for range: ${startDate} to ${endDate}`);
  try {
    const docs = await cosmosQuery(
      "SELECT c.Date, c.ServiceName, c.Cost FROM c WHERE c.Date >= @start AND c.Date <= @end",
      [{ name: "@start", value: `${startDate}T00:00:00` }, { name: "@end", value: `${endDate}T00:00:00` }]
    );

    const dailyMap = {};
    const serviceMap = {};
    for (const d of docs) {
      const date = d.Date.split('T')[0];
      dailyMap[date] = (dailyMap[date] || 0) + d.Cost;
      if (!serviceMap[d.ServiceName]) serviceMap[d.ServiceName] = { cost: 0, records: 0 };
      serviceMap[d.ServiceName].cost += d.Cost;
      serviceMap[d.ServiceName].records++;
    }

    const dailyTotals = Object.entries(dailyMap)
      .map(([date, cost]) => ({ date, cost: Math.round(cost * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const serviceBreakdown = Object.entries(serviceMap)
      .map(([service, v]) => ({ service, cost: Math.round(v.cost * 100) / 100, records: v.records }))
      .sort((a, b) => b.cost - a.cost);

    const totalCost = Math.round(serviceBreakdown.reduce((s, v) => s + v.cost, 0) * 100) / 100;

    context.log(`Query returned ${docs.length} documents, total cost: $${totalCost}`);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { dateRange: { startDate, endDate }, dailyTotals, serviceBreakdown, totalCost }
    };
  } catch (err) {
    context.log.error('getCosts failed', err.message);
    context.res = { status: 500, body: { error: err.message } };
  }
};
