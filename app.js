const ICON_MAP = {
    'API Management': 'api-management',
    'Automation': 'automation',
    'Azure App Service': 'azure-app-service',
    'Azure Cognitive Search': 'azure-data-explorer',
    'Azure Container Apps': 'azure-container-apps',
    'Azure Cosmos DB': 'azure-cosmos-db',
    'Azure Data Explorer': 'azure-data-explorer',
    'Azure Database for MySQL': 'azure-database-for-mysql',
    'Azure DNS': 'azure-dns',
    'Azure Front Door Service': 'azure-front-door',
    'Azure Grafana Service': 'azure-grafana-service',
    'Azure Machine Learning': 'azure-machine-learning',
    'Azure Maps': 'azure-monitor',
    'Azure Monitor': 'azure-monitor',
    'Bandwidth': 'virtual-network',
    'Event Grid': 'event-grid',
    'Event Hubs': 'event-hubs',
    'Foundry Models': 'foundry-models',
    'Foundry Tools': 'foundry-models',
    'Functions': 'functions',
    'GitHub': 'azure-app-service',
    'Key Vault': 'key-vault',
    'Load Balancer': 'load-balancer',
    'Log Analytics': 'log-analytics',
    'Logic Apps': 'azure-app-service',
    'Messaging': 'service-bus',
    'Microsoft Entra': 'microsoft-entra',
    'Phone Numbers': 'azure-monitor',
    'Service Bus': 'service-bus',
    'Storage': 'storage',
    'Virtual Machines': 'virtual-machines',
    'Virtual Network': 'virtual-network',
    'Web PubSub': 'service-bus'
};

const PORTAL_LINK_MAP = {
    'API Management': '#browse/Microsoft.ApiManagement%2Fservice',
    'Automation': '#browse/Microsoft.Automation%2FAutomationAccounts',
    'Azure App Service': '#browse/Microsoft.Web%2Fsites',
    'Azure Cognitive Search': '#browse/Microsoft.Search%2FsearchServices',
    'Azure Container Apps': '#browse/Microsoft.App%2FcontainerApps',
    'Azure Cosmos DB': '#browse/Microsoft.DocumentDb%2FdatabaseAccounts',
    'Azure Data Explorer': '#browse/Microsoft.Kusto%2Fclusters',
    'Azure Database for MySQL': '#browse/Microsoft.DBforMySQL%2FflexibleServers',
    'Azure DNS': '#browse/Microsoft.Network%2FdnsZones',
    'Azure Front Door Service': '#browse/Microsoft.Cdn%2Fprofiles',
    'Azure Grafana Service': '#browse/Microsoft.Dashboard%2Fgrafana',
    'Azure Machine Learning': '#browse/Microsoft.MachineLearningServices%2Fworkspaces',
    'Azure Monitor': '#browse/Microsoft.Insights%2Fcomponents',
    'Event Grid': '#browse/Microsoft.EventGrid%2Ftopics',
    'Event Hubs': '#browse/Microsoft.EventHub%2Fnamespaces',
    'Foundry Models': '#browse/Microsoft.CognitiveServices%2Faccounts',
    'Foundry Tools': '#browse/Microsoft.CognitiveServices%2Faccounts',
    'Functions': '#browse/Microsoft.Web%2Fsites/kind/functionapp',
    'Key Vault': '#browse/Microsoft.KeyVault%2Fvaults',
    'Load Balancer': '#browse/Microsoft.Network%2FloadBalancers',
    'Log Analytics': '#browse/Microsoft.OperationalInsights%2Fworkspaces',
    'Logic Apps': '#browse/Microsoft.Logic%2Fworkflows',
    'Messaging': '#browse/Microsoft.Communication%2FCommunicationServices',
    'Phone Numbers': '#browse/Microsoft.Communication%2FCommunicationServices',
    'Service Bus': '#browse/Microsoft.ServiceBus%2Fnamespaces',
    'Storage': '#browse/Microsoft.Storage%2FStorageAccounts',
    'Virtual Machines': '#browse/Microsoft.Compute%2FVirtualMachines',
    'Virtual Network': '#browse/Microsoft.Network%2FvirtualNetworks',
    'Web PubSub': '#browse/Microsoft.SignalRService%2FWebPubSub'
};

function getPortalUrl(serviceName) {
    const path = PORTAL_LINK_MAP[serviceName];
    return path ? `https://portal.azure.com/${path}` : null;
}

let dailyChart = null;
let currentData = null;
let currentGranularity = 'day';
let currentView = 'cards';
let currentSort = { key: 'cost', dir: 'desc' };
let resourceData = null;
let currentResourceFilter = null; // { service, resource }
let currentDateRange = { startDate: null, endDate: null };

async function loadResourceMap() {
    try {
        const res = await fetch('/api/getResources');
        if (res.ok) resourceData = await res.json();
    } catch (e) { /* optional - don't break if unavailable */ }
}

function getResourceName(serviceName, serviceResource) {
    if (!resourceData || !resourceData.skuMap) return null;
    // Try direct SKU match (VM sizes like D16ads v5 → Standard_D16ads_v5)
    const normalized = serviceResource.replace(/\s+/g, '').toLowerCase();
    for (const [sku, resources] of Object.entries(resourceData.skuMap)) {
        const normSku = sku.replace(/\s+/g, '').toLowerCase();
        if (normSku === normalized || normalized.includes(normSku) || normSku.includes(normalized)) {
            return resources;
        }
    }
    return null;
}

function getResourcePortalUrl(resourceId) {
    if (!resourceId) return null;
    return `https://portal.azure.com/#@71a46d06-d6c8-4e81-8fe9-d2d6355392df/resource${resourceId}`;
}

function buildResourceBadge(mapped) {
    const r = mapped[0];
    const url = getResourcePortalUrl(r.id);
    const title = mapped.map(m => `${m.name}${m.type ? ' (' + m.type + ')' : ''}`).join(', ');
    if (url) {
        return `<a class="resource-badge resource-badge-link" href="${url}" target="_blank" title="${title}">${r.name}</a>`;
    }
    return `<span class="resource-badge" title="${title}">${r.name}</span>`;
}

function getIconPath(serviceName) {
    const slug = ICON_MAP[serviceName];
    return slug ? `icons/${slug}.svg` : 'icons/azure-monitor.svg';
}

function formatCost(value) {
    if (value >= 1000) return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return '$' + value.toFixed(2);
}

function getDateRange(days) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    return {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0]
    };
}

async function fetchCostData(startDate, endDate, filter) {
    let url = `/api/getCosts?startDate=${startDate}&endDate=${endDate}`;
    if (filter) {
        url += `&service=${encodeURIComponent(filter.service)}&resource=${encodeURIComponent(filter.resource)}`;
    }
    const resp = await fetch(url);
    if (!resp.ok) {
        const text = await resp.text();
        console.error('API Error Response:', resp.status, text);
        let errMsg = `API error: ${resp.status}`;
        try { errMsg = JSON.parse(text).error || errMsg; } catch (e) { errMsg = text || errMsg; }
        throw new Error(errMsg);
    }
    return resp.json();
}

function aggregateByGranularity(dailyTotals, granularity) {
    if (granularity === 'day') return dailyTotals;
    const map = {};
    for (const d of dailyTotals) {
        let key;
        if (granularity === 'month') {
            key = d.date.substring(0, 7) + '-01';
        } else {
            // week: group by ISO week (Monday start)
            const dt = new Date(d.date + 'T00:00:00');
            const day = dt.getDay() || 7;
            dt.setDate(dt.getDate() - day + 1);
            key = dt.toISOString().split('T')[0];
        }
        map[key] = (map[key] || 0) + d.cost;
    }
    return Object.entries(map)
        .map(([date, cost]) => ({ date, cost: Math.round(cost * 100) / 100 }))
        .sort((a, b) => a.date.localeCompare(b.date));
}

function renderChart(dailyTotals) {
    const aggregated = aggregateByGranularity(dailyTotals, currentGranularity);
    const ctx = document.getElementById('dailyChart').getContext('2d');
    if (dailyChart) dailyChart.destroy();

    const timeUnit = currentGranularity === 'month' ? 'month' : currentGranularity === 'week' ? 'week' : (aggregated.length > 90 ? 'month' : 'week');
    const label = currentGranularity === 'month' ? 'Monthly Cost ($)' : currentGranularity === 'week' ? 'Weekly Cost ($)' : 'Daily Cost ($)';

    dailyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: aggregated.map(d => d.date),
            datasets: [{
                label,
                data: aggregated.map(d => d.cost),
                backgroundColor: 'rgba(79, 195, 247, 0.4)',
                borderColor: '#4fc3f7',
                borderWidth: 1,
                borderRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (event, elements) => {
                if (!elements.length) return;
                const idx = elements[0].index;
                const clickedDate = aggregated[idx].date;
                let start, end;
                if (currentGranularity === 'month') {
                    const dt = new Date(clickedDate + 'T00:00:00');
                    start = clickedDate;
                    end = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).toISOString().split('T')[0];
                } else if (currentGranularity === 'week') {
                    start = clickedDate;
                    const dt = new Date(clickedDate + 'T00:00:00');
                    dt.setDate(dt.getDate() + 6);
                    end = dt.toISOString().split('T')[0];
                } else {
                    start = clickedDate;
                    end = clickedDate;
                }
                loadData(start, end);
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => formatCost(ctx.parsed.y)
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: timeUnit },
                    grid: { color: '#2a3a5c' },
                    ticks: { color: '#888' }
                },
                y: {
                    grid: { color: '#2a3a5c' },
                    ticks: { color: '#888', callback: v => '$' + v }
                }
            }
        }
    });
}

function setResourceFilter(service, resource) {
    currentResourceFilter = { service, resource };
    document.getElementById('resourceFilterBanner').style.display = 'flex';
    document.getElementById('resourceFilterText').textContent = `${service} → ${resource}`;
    if (currentDateRange.startDate) {
        loadData(currentDateRange.startDate, currentDateRange.endDate);
    }
}

function clearResourceFilter() {
    currentResourceFilter = null;
    document.getElementById('resourceFilterBanner').style.display = 'none';
    if (currentDateRange.startDate) {
        loadData(currentDateRange.startDate, currentDateRange.endDate);
    }
}

function applyResourceFilter(serviceBreakdown) {
    if (!currentResourceFilter) return serviceBreakdown;
    const { service, resource } = currentResourceFilter;
    return serviceBreakdown
        .filter(svc => svc.service === service)
        .map(svc => ({
            ...svc,
            resources: (svc.resources || []).filter(r => r.name === resource),
            cost: (svc.resources || []).filter(r => r.name === resource).reduce((s, r) => s + r.cost, 0),
            records: (svc.resources || []).filter(r => r.name === resource).reduce((s, r) => s + r.records, 0)
        }))
        .filter(svc => svc.resources.length > 0);
}

function filterServices(serviceBreakdown, query) {
    if (!query) return serviceBreakdown;
    const q = query.toLowerCase();
    return serviceBreakdown.filter(svc =>
        svc.service.toLowerCase().includes(q) ||
        (svc.resources || []).some(r => r.name.toLowerCase().includes(q))
    );
}

function renderTable(serviceBreakdown) {
    const wrapper = document.getElementById('serviceTableWrapper');
    const tbody = document.getElementById('serviceTableBody');

    // Flatten to rows: one row per resource
    let rows = [];
    for (const svc of serviceBreakdown) {
        if (svc.resources && svc.resources.length > 0) {
            for (const r of svc.resources) {
                rows.push({ service: svc.service, resource: r.name, cost: r.cost, records: r.records });
            }
        } else {
            rows.push({ service: svc.service, resource: '—', cost: svc.cost, records: svc.records });
        }
    }

    // Sort
    rows.sort((a, b) => {
        const key = currentSort.key;
        const dir = currentSort.dir === 'asc' ? 1 : -1;
        if (key === 'cost' || key === 'records') return (a[key] - b[key]) * dir;
        return a[key].localeCompare(b[key]) * dir;
    });

    tbody.innerHTML = rows.map(r => {
        const portalUrl = getPortalUrl(r.service);
        const svcHtml = portalUrl
            ? `<a class="service-link" href="${portalUrl}" target="_blank">${r.service}</a>`
            : r.service;
        const clickable = r.resource !== '—' ? 'class="resource-clickable-row"' : '';
        return `
        <tr ${clickable} data-service="${r.service}" data-resource="${r.resource}">
            <td><img src="${getIconPath(r.service)}" class="table-icon" onerror="this.src='icons/azure-monitor.svg'">${svcHtml}</td>
            <td>${r.resource}</td>
            <td>${formatCost(r.cost)}</td>
            <td>${r.records}</td>
        </tr>`;
    }).join('');

    // Table row click to filter
    wrapper.querySelectorAll('.resource-clickable-row').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            setResourceFilter(row.dataset.service, row.dataset.resource);
        });
    });

    // Update sort indicators
    document.querySelectorAll('.service-table th').forEach(th => {
        const icon = th.querySelector('.sort-icon');
        if (th.dataset.sort === currentSort.key) {
            icon.textContent = currentSort.dir === 'asc' ? ' ▲' : ' ▼';
        } else {
            icon.textContent = '';
        }
    });
}

function renderServices(serviceBreakdown) {
    const grid = document.getElementById('serviceGrid');
    const maxCost = serviceBreakdown[0]?.cost || 1;

    grid.innerHTML = serviceBreakdown.map((svc, idx) => {
        const resources = svc.resources || [];
        const top10 = resources.slice(0, 10);
        const hasMore = resources.length > 10;
        const resourcesHtml = top10.map(r => {
            const mapped = getResourceName(svc.service, r.name);
            const badge = mapped ? buildResourceBadge(mapped) : '';
            return `
            <div class="resource-row resource-clickable" data-service="${svc.service}" data-resource="${r.name}">
                <span class="resource-name" title="${r.name}">${r.name}${badge}</span>
                <span class="resource-cost">${formatCost(r.cost)}</span>
            </div>`;
        }).join('');
        const moreHtml = hasMore ? `
            <div class="resource-row resource-more" data-svc-idx="${idx}">
                <a href="#" class="show-more-link">Show ${resources.length - 10} more...</a>
            </div>
            <div class="resource-overflow" id="overflow-${idx}" style="display:none">
                ${resources.slice(10).map(r => {
                    const mapped = getResourceName(svc.service, r.name);
                    const badge = mapped ? buildResourceBadge(mapped) : '';
                    return `
                    <div class="resource-row resource-clickable" data-service="${svc.service}" data-resource="${r.name}">
                        <span class="resource-name" title="${r.name}">${r.name}${badge}</span>
                        <span class="resource-cost">${formatCost(r.cost)}</span>
                    </div>`;
                }).join('')}
            </div>
        ` : '';

        const portalUrl = getPortalUrl(svc.service);
        const nameHtml = portalUrl
            ? `<a class="service-name service-link" href="${portalUrl}" target="_blank" title="Open in Azure Portal">${svc.service}</a>`
            : `<div class="service-name" title="${svc.service}">${svc.service}</div>`;

        return `
        <div class="service-card">
            <div class="service-icon">
                <img src="${getIconPath(svc.service)}" alt="${svc.service}" onerror="this.src='icons/azure-monitor.svg'">
            </div>
            <div class="service-info">
                ${nameHtml}
                <div class="service-cost">${formatCost(svc.cost)}</div>
                <div class="service-meta">${svc.records} line items</div>
                <div class="service-bar">
                    <div class="service-bar-fill" style="width: ${(svc.cost / maxCost * 100).toFixed(1)}%"></div>
                </div>
                ${resourcesHtml ? `<div class="resource-list">${resourcesHtml}${moreHtml}</div>` : ''}
            </div>
        </div>
    `;
    }).join('');

    grid.querySelectorAll('.show-more-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const row = e.target.closest('.resource-more');
            const idx = row.dataset.svcIdx;
            const overflow = document.getElementById('overflow-' + idx);
            overflow.style.display = '';
            row.style.display = 'none';
        });
    });

    grid.querySelectorAll('.resource-clickable').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('.resource-badge-link')) return; // don't hijack badge clicks
            setResourceFilter(row.dataset.service, row.dataset.resource);
        });
    });
}

function refreshView() {
    if (!currentData) return;
    const query = document.getElementById('serviceSearch').value;
    let filtered = applyResourceFilter(currentData.serviceBreakdown);
    filtered = filterServices(filtered, query);
    if (currentView === 'cards') {
        document.getElementById('serviceGrid').style.display = '';
        document.getElementById('serviceTableWrapper').style.display = 'none';
        renderServices(filtered);
    } else {
        document.getElementById('serviceGrid').style.display = 'none';
        document.getElementById('serviceTableWrapper').style.display = '';
        renderTable(filtered);
    }
}

function renderData(data, source) {
    currentData = data;
    document.querySelector('.total-value').textContent = formatCost(data.totalCost);
    if (data.dateRange) {
        const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        document.getElementById('dateRangeValue').textContent = `${fmt(data.dateRange.startDate)} — ${fmt(data.dateRange.endDate)}`;
    }
    renderChart(data.dailyTotals);
    refreshView();

    const srcEl = document.getElementById('dataSource');
    if (source === 'upload') {
        srcEl.className = 'data-source uploaded';
        srcEl.textContent = 'Data source: Uploaded JSON file';
    } else {
        srcEl.className = 'data-source';
        srcEl.textContent = `Data source: Cosmos DB | ${data.dateRange.startDate} to ${data.dateRange.endDate}`;
    }
}

async function loadData(startDate, endDate) {
    currentDateRange = { startDate, endDate };
    const grid = document.getElementById('serviceGrid');
    grid.innerHTML = '<div class="loading">Loading cost data...</div>';
    document.querySelector('.total-value').textContent = '—';

    try {
        const data = await fetchCostData(startDate, endDate, currentResourceFilter);
        renderData(data, 'api');
    } catch (err) {
        grid.innerHTML = `<div class="loading">Error: ${err.message}</div>`;
    }
}

function showToast(message, type, persistent) {
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    if (!persistent) setTimeout(() => toast.remove(), 6000);
}

async function processUploadedJSON(rawData) {
    // Expect array of objects with same schema as Cosmos docs
    let docs = Array.isArray(rawData) ? rawData : rawData.Documents || rawData.documents || [];
    if (!docs.length) { alert('No data found in JSON file'); return; }

    // Upsert to Cosmos DB via API
    showToast(`Uploading ${docs.length} documents to Cosmos DB...`, 'info', true);
    try {
        const res = await fetch('/api/upsertCosts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(docs)
        });
        let result;
        const text = await res.text();
        try { result = JSON.parse(text); } catch (e) { throw new Error(text || `HTTP ${res.status}`); }
        if (res.ok || res.status === 207) {
            const msg = result.failed > 0
                ? `Saved ${result.succeeded}/${result.total} documents (${result.failed} failed)`
                : `Successfully saved ${result.succeeded} documents to Cosmos DB`;
            showToast(msg, result.failed > 0 ? 'warning' : 'success');
        } else {
            showToast(`Upload failed: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (err) {
        showToast(`Upload failed: ${err.message}`, 'error');
    }

    // Normalize and render locally
    docs = docs.map(d => ({
        Date: d.Date || d.date,
        ServiceName: d.ServiceName || d.serviceName,
        Cost: d.Cost ?? d.cost ?? 0,
        Quantity: d.Quantity ?? d.quantity ?? 0
    }));

    const dailyMap = {};
    const serviceMap = {};
    docs.forEach(d => {
        const date = (d.Date || '').split('T')[0];
        if (!date) return;
        dailyMap[date] = (dailyMap[date] || 0) + d.Cost;
        if (!serviceMap[d.ServiceName]) serviceMap[d.ServiceName] = { cost: 0, records: 0 };
        serviceMap[d.ServiceName].cost += d.Cost;
        serviceMap[d.ServiceName].records++;
    });

    const dailyTotals = Object.entries(dailyMap)
        .map(([date, cost]) => ({ date, cost: Math.round(cost * 100) / 100 }))
        .sort((a, b) => a.date.localeCompare(b.date));

    const serviceBreakdown = Object.entries(serviceMap)
        .map(([service, v]) => ({ service, cost: Math.round(v.cost * 100) / 100, records: v.records }))
        .sort((a, b) => b.cost - a.cost);

    const totalCost = Math.round(serviceBreakdown.reduce((s, v) => s + v.cost, 0) * 100) / 100;
    const dates = dailyTotals.map(d => d.date);

    renderData({
        dateRange: { startDate: dates[0], endDate: dates[dates.length - 1] },
        dailyTotals,
        serviceBreakdown,
        totalCost
    }, 'upload');
}

// Event listeners
document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (btn.dataset.custom) {
            document.getElementById('customDateRange').style.display = 'flex';
        } else if (btn.dataset.all) {
            document.getElementById('customDateRange').style.display = 'none';
            loadData('2025-06-01', new Date().toISOString().split('T')[0]);
        } else {
            document.getElementById('customDateRange').style.display = 'none';
            const { startDate, endDate } = getDateRange(parseInt(btn.dataset.days));
            loadData(startDate, endDate);
        }
    });
});

document.querySelectorAll('.granularity-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.granularity-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentGranularity = btn.dataset.granularity;
        if (currentData) renderChart(currentData.dailyTotals);
    });
});

document.getElementById('applyDates').addEventListener('click', () => {
    const start = document.getElementById('startDate').value;
    const end = document.getElementById('endDate').value;
    if (start && end) loadData(start, end);
});

// View toggle
document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentView = btn.dataset.view;
        refreshView();
    });
});

// Search
document.getElementById('serviceSearch').addEventListener('input', () => refreshView());

// Table sort
document.querySelectorAll('.service-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (currentSort.key === key) {
            currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort = { key, dir: key === 'cost' || key === 'records' ? 'desc' : 'asc' };
        }
        refreshView();
    });
});

document.getElementById('uploadBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            processUploadedJSON(data);
        } catch (err) {
            alert('Invalid JSON file: ' + err.message);
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

// Load user info
(async () => {
    try {
        const res = await fetch('/.auth/me');
        const data = await res.json();
        const user = data.clientPrincipal;
        if (user) {
            document.getElementById('userName').textContent = user.userDetails;
        }
    } catch (e) { /* not logged in */ }
})();

// Calculate sponsorship remaining days
const _sponsorDaysEl = document.getElementById('sponsorDays');
if (_sponsorDaysEl) {
    const _expiry = new Date('2027-08-18T00:00:00');
    const _today = new Date();
    const _days = Math.ceil((_expiry - _today) / 86400000);
    _sponsorDaysEl.textContent = _days > 0 ? _days.toLocaleString() : 'Expired';
}

// Initial load — 90 days + resource map
loadResourceMap();
const { startDate, endDate } = getDateRange(90);
loadData(startDate, endDate);
