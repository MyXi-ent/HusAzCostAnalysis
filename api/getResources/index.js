const https = require('https');

const tenantId = process.env.ARM_TENANT_ID;
const clientId = process.env.ARM_CLIENT_ID;
const clientSecret = process.env.ARM_CLIENT_SECRET;
const subscriptionId = process.env.ARM_SUBSCRIPTION_ID;

function httpPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, port: 443, method: 'POST', path, headers };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, port: 443, method: 'GET', path,
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getToken() {
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&scope=https%3A%2F%2Fmanagement.azure.com%2F.default`;
  const result = await httpPost(
    'login.microsoftonline.com',
    `/${tenantId}/oauth2/v2.0/token`,
    body,
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  );
  if (!result.access_token) throw new Error(result.error_description || 'Token failed');
  return result.access_token;
}

async function queryResourceGraph(token, query) {
  const body = JSON.stringify({ query, subscriptions: [subscriptionId] });
  const result = await httpPost(
    'management.azure.com',
    '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
    body,
    {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  );
  return result.data || [];
}

module.exports = async function (context, req) {
  context.log('getResources invoked');
  try {
    const token = await getToken();

    // Query VMs with their sizes
    const vms = await queryResourceGraph(token,
      "Resources | where type == 'microsoft.compute/virtualmachines' | project name, resourceGroup, location, sku=properties.hardwareProfile.vmSize, id"
    );

    // Query App Service Plans with SKUs
    const plans = await queryResourceGraph(token,
      "Resources | where type == 'microsoft.web/serverfarms' | project name, resourceGroup, location, sku=sku.name, tier=sku.tier, id"
    );

    // Query Function Apps
    const functions = await queryResourceGraph(token,
      "Resources | where type == 'microsoft.web/sites' and kind contains 'functionapp' | project name, resourceGroup, location, id"
    );

    // Query Cosmos DB accounts
    const cosmos = await queryResourceGraph(token,
      "Resources | where type == 'microsoft.documentdb/databaseaccounts' | project name, resourceGroup, location, id"
    );

    // Query Communication Services
    const comms = await queryResourceGraph(token,
      "Resources | where type == 'microsoft.communication/communicationservices' | project name, resourceGroup, location, id"
    );

    // Build SKU-to-resource mapping
    const resourceMap = {};

    function addToMap(key, entry) {
      if (!key) return;
      if (!resourceMap[key]) resourceMap[key] = [];
      resourceMap[key].push(entry);
    }

    vms.forEach(vm => {
      const entry = { name: vm.name, type: 'VM', resourceGroup: vm.resourceGroup, id: vm.id };
      const raw = (vm.sku || '').replace('Standard_', '');
      // "D16ads_v5" → "D16ads v5"
      const spaced = raw.replace(/_/g, ' ');
      addToMap(spaced, entry);
      // Also add with 's' variants: "D2s_v3" → "D2 v3/D2s v3"
      const baseMatch = raw.match(/^([A-Za-z]+\d+)(a?s?)_?(v\d+)$/);
      if (baseMatch) {
        const [, base, suffix, ver] = baseMatch;
        addToMap(`${base} ${ver}/${base}${suffix} ${ver}`, entry);
        addToMap(`${base}${suffix} ${ver}`, entry);
        addToMap(`${base} ${ver}`, entry);
      }
    });

    plans.forEach(p => {
      const entry = { name: p.name, type: 'App Service Plan', resourceGroup: p.resourceGroup, id: p.id };
      addToMap(`${p.sku || ''} ${p.tier || ''}`.trim(), entry);
      // Also map by plan tier: "P2 v3 App" → "P2v3"
      if (p.sku) {
        addToMap(p.sku, entry);
        addToMap(`${p.sku} App`, entry);
      }
    });

    // Flat resource list for lookup
    const resources = {
      vms: vms.map(v => ({ name: v.name, sku: v.sku, resourceGroup: v.resourceGroup, id: v.id })),
      appServicePlans: plans.map(p => ({ name: p.name, sku: p.sku, tier: p.tier, resourceGroup: p.resourceGroup, id: p.id })),
      functions: functions.map(f => ({ name: f.name, resourceGroup: f.resourceGroup, id: f.id })),
      cosmos: cosmos.map(c => ({ name: c.name, resourceGroup: c.resourceGroup, id: c.id })),
      comms: comms.map(c => ({ name: c.name, resourceGroup: c.resourceGroup, id: c.id })),
      skuMap: resourceMap,
      // Include named resources for service-level matching
      byService: {
        'Functions': functions.map(f => ({ name: f.name, id: f.id })),
        'Azure Cosmos DB': cosmos.map(c => ({ name: c.name, id: c.id })),
        'Messaging': comms.map(c => ({ name: c.name, id: c.id })),
        'Phone Numbers': comms.map(c => ({ name: c.name, id: c.id }))
      }
    };

    context.log(`Found ${vms.length} VMs, ${plans.length} plans, ${functions.length} functions`);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: resources
    };
  } catch (err) {
    context.log.error('getResources failed:', err.message);
    context.res = { status: 500, body: { error: err.message } };
  }
};
