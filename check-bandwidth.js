const { CosmosClient } = require('@azure/cosmos');
const client = new CosmosClient({ endpoint: 'https://husazcomoserverless.documents.azure.com:443/', key: process.env.COSMOS_KEY });
const c = client.database('HusAzConsumption').container('HusAzConsumptionCosmoDB');

async function main() {
  // Group by ServiceResource and ServiceType to find what's generating cost
  const q = `SELECT c.ServiceResource, c.ServiceType, c.ServiceRegion, c.Cost, c.Quantity, c.ResourceGuid FROM c 
    WHERE c.Date >= "2026-06-01" AND c.Date <= "2026-06-21" 
    AND CONTAINS(LOWER(c.ServiceName), "bandwidth")
    AND c.Cost > 0`;
  
  const { resources } = await c.items.query(q).fetchAll();
  
  const grouped = {};
  resources.forEach(r => {
    const key = r.ServiceResource + ' | ' + r.ServiceType + ' | ' + r.ServiceRegion + ' | GUID:' + r.ResourceGuid;
    if (!grouped[key]) grouped[key] = { cost: 0, qty: 0 };
    grouped[key].cost += r.Cost;
    grouped[key].qty += r.Quantity;
  });
  
  console.log('=== Bandwidth charges > $0 - June 2026 (by meter) ===');
  let total = 0;
  Object.entries(grouped).sort((a,b) => b[1].cost - a[1].cost).forEach(([k, v]) => {
    total += v.cost;
    console.log(`$${v.cost.toFixed(2)} (${v.qty.toFixed(2)} GB) - ${k}`);
  });
  console.log(`\nTOTAL: $${total.toFixed(2)}`);
}

main().catch(console.error);
