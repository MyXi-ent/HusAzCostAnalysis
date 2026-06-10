const { CosmosClient } = require('@azure/cosmos');

const endpoint = process.env.COSMOS_ENDPOINT || 'https://husazcomoserverless.documents.azure.com:443/';
const key = process.env.COSMOS_KEY;
const dbId = 'HusAzConsumption';
const collId = 'HusAzConsumptionCosmoDB';

const client = new CosmosClient({ endpoint, key });
const container = client.database(dbId).container(collId);

module.exports = async function (context, req) {
  const startDate = req.query.startDate || req.body?.startDate;
  const endDate = req.query.endDate || req.body?.endDate;

  if (!startDate || !endDate) {
    context.res = { status: 400, body: { error: 'startDate and endDate required' } };
    return;
  }

  try {
    const query = {
      query: "SELECT c.Date, c.ServiceName, c.Cost FROM c WHERE c.Date >= @start AND c.Date <= @end",
      parameters: [
        { name: "@start", value: `${startDate}T00:00:00` },
        { name: "@end", value: `${endDate}T00:00:00` }
      ]
    };

    const { resources: docs } = await container.items.query(query).fetchAll();

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
    context.log.error('getCosts error:', err.message);
    context.res = { status: 500, body: { error: err.message } };
  }
};
    context.res = { status: 500, body: { error: err.message } };
  }
};
