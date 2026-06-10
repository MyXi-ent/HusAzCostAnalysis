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

function cosmosQuery(sql, parameters) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const resourceLink = `dbs/${dbId}/colls/${collId}`;
    const token = generateAuth('post', 'docs', resourceLink, date);
    const body = JSON.stringify(parameters ? { query: sql, parameters } : { query: sql });

    const opts = {
      hostname: host,
      port: 443,
      path: `/${resourceLink}/docs`,
      method: 'POST',
      headers: {
        'Authorization': token,
        'x-ms-date': date,
        'x-ms-version': '2020-07-15',
        'Content-Type': 'application/query+json',
        'x-ms-documentdb-isquery': 'True',
        'x-ms-documentdb-query-enablecrosspartition': 'True',
        'x-ms-max-item-count': '-1',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code) reject(new Error(parsed.message));
          else resolve(parsed.Documents || []);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function (context, req) {
  const startDate = req.query.startDate || req.body?.startDate;
  const endDate = req.query.endDate || req.body?.endDate;

  if (!startDate || !endDate) {
    context.res = { status: 400, body: { error: 'startDate and endDate required' } };
    return;
  }

  try {
    // Fetch all records in range (Cosmos REST API handles cross-partition with the header)
    const docs = await cosmosQuery(
      `SELECT c.Date, c.ServiceName, c.Cost FROM c WHERE c.Date >= '${startDate}T00:00:00' AND c.Date <= '${endDate}T00:00:00'`
    );

    // Aggregate daily totals
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

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { dateRange: { startDate, endDate }, dailyTotals, serviceBreakdown, totalCost }
    };
  } catch (err) {
    context.res = { status: 500, body: { error: err.message } };
  }
};
    context.res = { status: 500, body: { error: err.message } };
  }
};
