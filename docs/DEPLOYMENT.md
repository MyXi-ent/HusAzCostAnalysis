# Deployment (Xi tenant)

| Item | Value |
|---|---|
| Azure tenant | `37c98e37-5c60-4bb8-a161-a946ea9279a2` |
| Azure subscription | `79177aea-6f1e-40aa-b5ab-e78b363d93ed` |
| Target resource | `swa-costanalysis-prd-eus2-001` (resource group `rg-xiweb-prd-eus-001`) |
| Workflow | `.github/workflows/deploy-swa.yml, daily-cost-sync.yml` |
| Deploy identity (Entra app registration) | `xi-costanalysis-deploy` |

## Authentication

The workflow signs in with GitHub OIDC (`azure/login`). No publish profile, service-principal secret or `AZURE_CREDENTIALS` secret is used.

Repository **variables** (Settings, Secrets and variables, Actions, Variables): `AZURE_CLIENT_ID` (the application id of `xi-costanalysis-deploy`), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

Federated credential on `xi-costanalysis-deploy`: issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, subject `repo:MyXi-ent/HusAzCostAnalysis:ref:refs/heads/main`.

The identity needs only the permissions required to deploy to the target resource (for example Website Contributor on the resource).
## Cost sync

The daily cost sync signs in with OIDC and passes the ARM token to the sync script (ARM_ACCESS_TOKEN); no client secret is used. The deploy identity needs the Cost Management Reader role on the Xi subscription. The sync writes to the Xi Cosmos account; set the repository secret COSMOS_KEY for that account.
