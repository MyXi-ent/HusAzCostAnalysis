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
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
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
      continuation = res.headers['x-ms-continuation'] || null;
    } while (continuation);
  }
  return allDocs;
}

module.exports = async function (context, req) {
  context.log('getCosts function invoked', { method: req.method, url: req.url });
  const startDate = req.query.startDate || req.body?.startDate;
  const endDate = req.query.endDate || req.body?.endDate;
  const filterService = req.query.service || null;
  const filterResource = req.query.resource || null;
  const groupBy = req.query.groupBy || 'day';

  if (!startDate || !endDate) {
    context.log.warn('Missing date parameters', { startDate, endDate });
    context.res = { status: 400, body: { error: 'startDate and endDate required' } };
    return;
  }

  context.log(`Querying Cosmos DB for range: ${startDate} to ${endDate}, filter: ${filterService}/${filterResource}`);
  try {
    const docs = await cosmosQuery(
      "SELECT c.Date, c.ServiceName, c.ServiceResource, c.Cost, c.Quantity, c.ResourceName FROM c WHERE c.Date >= @start AND c.Date <= @end",
      [{ name: "@start", value: `${startDate}T00:00:00` }, { name: "@end", value: `${endDate}T00:00:00` }]
    );

    const dailyMap = {};
    const serviceMap = {};
    const serviceDaily = {};   // ServiceName -> { date -> cost }  (for anomaly detection)
    const resourceDaily = {};  // "ServiceName\0resKey" -> { date -> cost }
    const allDates = new Set();
    for (const d of docs) {
      const date = d.Date.split('T')[0];
      const res = d.ServiceResource || 'Other';
      const resourceName = d.ResourceName || '';
      const matchesFilter = (!filterService || d.ServiceName === filterService) &&
                            (!filterResource || res === filterResource);

      allDates.add(date);
      if (!serviceDaily[d.ServiceName]) serviceDaily[d.ServiceName] = {};
      serviceDaily[d.ServiceName][date] = (serviceDaily[d.ServiceName][date] || 0) + d.Cost;

      // dailyMap only includes filtered data when filter is active
      if (matchesFilter) {
        dailyMap[date] = (dailyMap[date] || 0) + d.Cost;
      }

      // serviceMap always includes everything (for breakdown display)
      if (!serviceMap[d.ServiceName]) serviceMap[d.ServiceName] = { cost: 0, records: 0, resources: {} };
      serviceMap[d.ServiceName].cost += d.Cost;
      serviceMap[d.ServiceName].records++;
      // Group by ServiceResource + ResourceName so different resources show separately
      const resKey = resourceName ? `${res}|${resourceName}` : res;
      if (!serviceMap[d.ServiceName].resources[resKey]) serviceMap[d.ServiceName].resources[resKey] = { cost: 0, records: 0, resourceName: '', meter: res, quantity: 0 };
      serviceMap[d.ServiceName].resources[resKey].cost += d.Cost;
      serviceMap[d.ServiceName].resources[resKey].records++;
      serviceMap[d.ServiceName].resources[resKey].quantity += (d.Quantity || 0);
      if (resourceName) serviceMap[d.ServiceName].resources[resKey].resourceName = resourceName;

      // Per-meter daily series, for row-level anomaly detection in the table view
      const meterKey = `${d.ServiceName}\u0000${resKey}`;
      if (!resourceDaily[meterKey]) resourceDaily[meterKey] = {};
      resourceDaily[meterKey][date] = (resourceDaily[meterKey][date] || 0) + d.Cost;
    }

    const dailyTotals = Object.entries(dailyMap)
      .map(([date, cost]) => ({ date, cost: Math.round(cost * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const serviceBreakdown = Object.entries(serviceMap)
      .map(([service, v]) => ({
        service,
        cost: Math.round(v.cost * 100) / 100,
        records: v.records,
        resources: Object.entries(v.resources)
          .map(([key, r]) => ({ name: r.meter || key, cost: Math.round(r.cost * 100) / 100, records: r.records, resourceName: r.resourceName || '', quantity: Math.round(r.quantity), _key: key }))
          .sort((a, b) => b.cost - a.cost)
      }))
      .sort((a, b) => b.cost - a.cost);

    // --- Anomaly / trend detection ---
    const sortedDates = [...allDates].sort();
    const usableDates = sortedDates.length > 1 ? sortedDates.slice(0, -1) : sortedDates;

    // For monthly groupBy, compare calendar months instead of sliding windows
    let recentDates, priorDates, hasTrendWindow;
    if (groupBy === 'month' && usableDates.length > 0) {
      const monthBuckets = {};
      for (const dt of usableDates) { const m = dt.substring(0, 7); (monthBuckets[m] = monthBuckets[m] || []).push(dt); }
      const months = Object.keys(monthBuckets).sort();
      if (months.length >= 2) {
        recentDates = monthBuckets[months[months.length - 1]];
        priorDates = monthBuckets[months[months.length - 2]];
        hasTrendWindow = true;
      } else {
        recentDates = []; priorDates = []; hasTrendWindow = false;
      }
    } else {
      const trendSize = groupBy === 'week' ? 7 : 7;
      recentDates = usableDates.slice(-trendSize);
      priorDates = usableDates.slice(-trendSize * 2, -trendSize);
      hasTrendWindow = recentDates.length >= 3 && priorDates.length >= 3;
    }

    function computeTrend(daily, minDelta) {
      // For monthly mode, compare totals; for daily mode, compare averages
      const useTotal = groupBy === 'month';
      const recentVal = recentDates.reduce((s, dt) => s + (daily[dt] || 0), 0);
      const priorVal = priorDates.reduce((s, dt) => s + (daily[dt] || 0), 0);
      const recentCmp = useTotal ? recentVal : recentVal / recentDates.length;
      const priorCmp = useTotal ? priorVal : priorVal / priorDates.length;
      const delta = recentCmp - priorCmp;
      const minD = useTotal ? minDelta * 30 : minDelta;
      const isNew = priorCmp < 0.01 && recentCmp >= 0.01;
      const pct = isNew ? null : (priorCmp > 0 ? (delta / priorCmp) * 100 : 0);

      let severity = null;
      if (Math.abs(delta) >= minD) {
        const magnitude = isNew ? Infinity : Math.abs(pct);
        if (magnitude >= 100) severity = 'high';
        else if (magnitude >= 25) severity = 'medium';
      }

      return {
        priorAvg: Math.round(priorCmp * 100) / 100,
        recentAvg: Math.round(recentCmp * 100) / 100,
        delta: Math.round(delta * 100) / 100,
        pct: pct === null ? null : Math.round(pct),
        isNew,
        severity,
        direction: delta >= 0 ? 'up' : 'down'
      };
    }

    if (hasTrendWindow) {
      for (const svc of serviceBreakdown) {
        svc.trend = computeTrend(serviceDaily[svc.service] || {}, 1);
        for (const r of svc.resources) {
          r.trend = computeTrend(resourceDaily[`${svc.service}\u0000${r._key}`] || {}, 0.5);
        }
      }
    }

    // Sustained growth detection: flag services with 3+ consecutive monthly increases
    const monthlyByService = {};
    for (const [svcName, daily] of Object.entries(serviceDaily)) {
      const months = {};
      for (const [dt, cost] of Object.entries(daily)) {
        const m = dt.substring(0, 7);
        months[m] = (months[m] || 0) + cost;
      }
      const sorted = Object.entries(months).sort((a, b) => a[0].localeCompare(b[0]));
      if (sorted.length < 3) continue;
      let streak = 0, maxStreak = 0;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i][1] > sorted[i - 1][1] * 1.05) { streak++; maxStreak = Math.max(maxStreak, streak); }
        else streak = 0;
      }
      if (maxStreak >= 2) {
        const first = sorted[sorted.length - maxStreak - 1][1];
        const last = sorted[sorted.length - 1][1];
        const totalPct = first > 0 ? Math.round(((last - first) / first) * 100) : null;
        monthlyByService[svcName] = { months: maxStreak + 1, totalPct, from: sorted[sorted.length - maxStreak - 1][0], to: sorted[sorted.length - 1][0] };
      }
    }
    for (const svc of serviceBreakdown) {
      if (monthlyByService[svc.service]) svc.growthWarning = monthlyByService[svc.service];
    }

    // _key was only needed to look up the per-meter series
    for (const svc of serviceBreakdown) for (const r of svc.resources) delete r._key;

    // totalCost reflects the filtered view (dailyTotals sum)
    const totalCost = Math.round(dailyTotals.reduce((s, d) => s + d.cost, 0) * 100) / 100;

    context.log(`Query returned ${docs.length} documents, total cost: $${totalCost}`);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        dateRange: { startDate, endDate },
        dailyTotals,
        serviceBreakdown,
        totalCost,
        trendWindow: { recentDays: recentDates.length, priorDays: priorDates.length }
      }
    };
  } catch (err) {
    context.log.error('getCosts failed', err.message);
    context.res = { status: 500, body: { error: err.message } };
  }
};
