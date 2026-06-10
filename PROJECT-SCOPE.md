# Azure Cost Analysis — Project Scope

## Overview
Internal dashboard displaying real Azure subscription cost data, read from Cosmos DB. Shows daily spend trends, service-level breakdowns, and resource-level drill-downs.

## URLs
| Environment | URL |
|-------------|-----|
| Production | https://agreeable-field-08434d80f.7.azurestaticapps.net |
| Custom Domain | https://azure.cost.myxi.ai (pending DNS validation) |

## Azure Resources
| Resource | Name | SKU | Resource Group |
|----------|------|-----|----------------|
| Static Web App | HusAzCostAnalysis | Free | HusAzRGMoHajjCareAI |
| Cosmos DB (Serverless) | husazcomoserverless | Serverless | HusAzRGMoHajjCareAI |
| Location | East US 2 / West US 2 | — | — |

## Data Source
| Property | Value |
|----------|-------|
| Account | `husazcomoserverless` |
| Endpoint | `https://husazcomoserverless.documents.azure.com:443/` |
| Database | `HusAzConsumption` |
| Container | `HusAzConsumptionCosmoDB` |
| Partition Key | `/Date` (not confirmed yet) |
| Date Range | 2025-06-01 → present (daily) |
| Records | ~42,658 |
| Granularity | Daily, per-resource line items |

### Document Schema
```json
{
  "Date": "2026-06-06T00:00:00",
  "SubscriptionName": "Xi_Sponsored_Subscription",
  "SubscriptionGuid": "75920ee3-5dda-44fd-89ea-619c3265442e",
  "ResourceGuid": "a96e144b-d24b-51ec-908c-fdde4bc98343",
  "ServiceName": "Virtual Machines",
  "ServiceType": "Dadsv5 Series Windows",
  "ServiceRegion": "CA Central",
  "ServiceResource": "D16ads v5",
  "Quantity": 7.700012,
  "Cost": 12.75122
}
```

## Repository
| Property | Value |
|----------|-------|
| Repo | https://github.com/MyXi-ent/HusAzCostAnalysis |
| Branch | main |
| Deployment | GitHub Actions (auto-created by Azure SWA) |
| Workflow | `.github/workflows/azure-static-web-apps-agreeable-field-08434d80f.yml` |

## Authentication
| Property | Value |
|----------|-------|
| Provider | Microsoft (AAD) |
| Method | SWA built-in auth with role-based invitations |
| Required Role | `viewer` |
| Blocked Providers | GitHub, Twitter (return 404) |

### Authorized Users
| Email | Role | Invitation Expiry |
|-------|------|-------------------|
| mhussein@myxi.ai | viewer | 2026-06-17 |
| rayan@myxi.ai | viewer | 2026-06-17 |

## Tech Stack
- Static HTML/CSS/JS frontend (no build step)
- Azure Static Web Apps (Free tier)
- Azure Functions API (linked backend) for Cosmos DB queries
- `@azure/cosmos` SDK for data access
- `staticwebapp.config.json` for auth routing

## Custom Domain Setup
- **CNAME**: `azure.cost.myxi.ai` → `agreeable-field-08434d80f.7.azurestaticapps.net`
- **Validation**: DNS TXT token method (in progress)
