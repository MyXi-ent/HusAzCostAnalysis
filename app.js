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

let dailyChart = null;
let currentData = null;

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

async function fetchCostData(startDate, endDate) {
    const resp = await fetch(`/api/getCosts?startDate=${startDate}&endDate=${endDate}`);
    if (!resp.ok) {
        const text = await resp.text();
        console.error('API Error Response:', resp.status, text);
        let errMsg = `API error: ${resp.status}`;
        try { errMsg = JSON.parse(text).error || errMsg; } catch (e) { errMsg = text || errMsg; }
        throw new Error(errMsg);
    }
    return resp.json();
}

function renderChart(dailyTotals) {
    const ctx = document.getElementById('dailyChart').getContext('2d');
    if (dailyChart) dailyChart.destroy();

    dailyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: dailyTotals.map(d => d.date),
            datasets: [{
                label: 'Daily Cost ($)',
                data: dailyTotals.map(d => d.cost),
                backgroundColor: 'rgba(79, 195, 247, 0.4)',
                borderColor: '#4fc3f7',
                borderWidth: 1,
                borderRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
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
                    time: { unit: dailyTotals.length > 90 ? 'month' : 'week' },
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

function renderServices(serviceBreakdown) {
    const grid = document.getElementById('serviceGrid');
    const maxCost = serviceBreakdown[0]?.cost || 1;

    grid.innerHTML = serviceBreakdown.map(svc => `
        <div class="service-card">
            <div class="service-icon">
                <img src="${getIconPath(svc.service)}" alt="${svc.service}" onerror="this.src='icons/azure-monitor.svg'">
            </div>
            <div class="service-info">
                <div class="service-name" title="${svc.service}">${svc.service}</div>
                <div class="service-cost">${formatCost(svc.cost)}</div>
                <div class="service-meta">${svc.records} line items</div>
                <div class="service-bar">
                    <div class="service-bar-fill" style="width: ${(svc.cost / maxCost * 100).toFixed(1)}%"></div>
                </div>
            </div>
        </div>
    `).join('');
}

function renderData(data, source) {
    currentData = data;
    document.querySelector('.total-value').textContent = formatCost(data.totalCost);
    renderChart(data.dailyTotals);
    renderServices(data.serviceBreakdown);

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
    const grid = document.getElementById('serviceGrid');
    grid.innerHTML = '<div class="loading">Loading cost data...</div>';
    document.querySelector('.total-value').textContent = '—';

    try {
        const data = await fetchCostData(startDate, endDate);
        renderData(data, 'api');
    } catch (err) {
        grid.innerHTML = `<div class="loading">Error: ${err.message}</div>`;
    }
}

function processUploadedJSON(rawData) {
    // Expect array of objects with same schema as Cosmos docs
    let docs = Array.isArray(rawData) ? rawData : rawData.Documents || rawData.documents || [];
    if (!docs.length) { alert('No data found in JSON file'); return; }

    // Normalize field names (handle both camelCase and PascalCase)
    docs = docs.map(d => ({
        Date: d.Date || d.date,
        ServiceName: d.ServiceName || d.serviceName,
        Cost: d.Cost ?? d.cost ?? 0,
        Quantity: d.Quantity ?? d.quantity ?? 0
    }));

    // Aggregate daily totals
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
        } else {
            document.getElementById('customDateRange').style.display = 'none';
            const { startDate, endDate } = getDateRange(parseInt(btn.dataset.days));
            loadData(startDate, endDate);
        }
    });
});

document.getElementById('applyDates').addEventListener('click', () => {
    const start = document.getElementById('startDate').value;
    const end = document.getElementById('endDate').value;
    if (start && end) loadData(start, end);
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

// Initial load — 90 days
const { startDate, endDate } = getDateRange(90);
loadData(startDate, endDate);
