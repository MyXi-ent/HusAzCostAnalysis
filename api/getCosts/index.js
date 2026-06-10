const { CosmosClient } = require('@azure/cosmos');

const endpoint = process.env.COSMOS_ENDPOINT || 'https://husazcomoserverless.documents.azure.com:443/';
const key = process.env.COSMOS_KEY;
const dbName = 'HusAzConsumption';
const containerName = 'HusAzConsumptionCosmoDB';

let client;
function getContainer() {
  if (!client) client = new CosmosClient({ endpoint, key });
  return client.database(dbName).container(containerName);
}

module.exports = async function (context, req) {
  const startDate = req.query.startDate || req.body?.startDate;
  const endDate = req.query.endDate || req.body?.endDate;
  const groupBy = req.query.groupBy || req.body?.groupBy || 'ServiceName';

  if (!startDate || !endDate) {
    context.res = { status: 400, body: { error: 'startDate and endDate required' } };
    return;
  }

  const container = getContainer();

  try {
    // Daily totals
    const { resources: dailyTotals } = await container.items.query({
      query: `SELECT c.Date, SUM(c.Cost) AS totalCost FROM c 
              WHERE c.Date >= @start AND c.Date <= @end 
              GROUP BY c.Date`,
      parameters: [
        { name: '@start', value: `${startDate}T00:00:00` },
        { name: '@end', value: `${endDate}T00:00:00` }
      ]
    }).fetchAll();

    // Service breakdown
    const { resources: serviceBreakdown } = await container.items.query({
      query: `SELECT c.ServiceName, SUM(c.Cost) AS totalCost, COUNT(1) AS records FROM c 
              WHERE c.Date >= @start AND c.Date <= @end 
              GROUP BY c.ServiceName`,
      parameters: [
        { name: '@start', value: `${startDate}T00:00:00` },
        { name: '@end', value: `${endDate}T00:00:00` }
      ]
    }).fetchAll();

    // Sort daily by date, services by cost desc
    dailyTotals.sort((a, b) => a.Date.localeCompare(b.Date));
    serviceBreakdown.sort((a, b) => b.totalCost - a.totalCost);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        dateRange: { startDate, endDate },
        dailyTotals: dailyTotals.map(d => ({
          date: d.Date.split('T')[0],
          cost: Math.round(d.totalCost * 100) / 100
        })),
        serviceBreakdown: serviceBreakdown.map(s => ({
          service: s.ServiceName,
          cost: Math.round(s.totalCost * 100) / 100,
          records: s.records
        })),
        totalCost: Math.round(serviceBreakdown.reduce((sum, s) => sum + s.totalCost, 0) * 100) / 100
      }
    };
  } catch (err) {
    context.res = { status: 500, body: { error: err.message } };
  }
};
