---
name: azure-multi-tenant-cli
description: 'Use when running Azure CLI commands that span more than one Entra ID tenant — e.g. querying cost, resources, or role assignments across Haytham (71a46d06) and Xi (37c98e37) tenants without switching context. Covers staying signed into all tenants simultaneously, avoiding the hanging `az login --tenant` browser prompt, cross-tenant Cost Management queries, and why single-tenant service principals cannot authenticate across tenants.'
---

# Azure Multi-Tenant CLI Access

Stay authenticated to **every** tenant at once so no `az account set` switching is ever needed.

## The Core Technique

```powershell
az account list --all --refresh
```

`--refresh` re-enumerates every tenant the signed-in identity can reach and caches
tokens for **all of them simultaneously**. After this, target any subscription
directly:

```powershell
az resource list --subscription 79177aea-6f1e-40aa-b5ab-e78b363d93ed
az role assignment list --scope "/subscriptions/<id>"
```

No `az account set`. No tenant switching. Tokens for both tenants coexist.

## Do NOT use `az login --tenant <id>`

- Opens an **interactive browser prompt that frequently hangs** the terminal.
- It also *narrows* the cached context to that one tenant, which is the opposite
  of the goal.
- Only needed for a first-ever sign-in, or after a full `az logout`.

If a login does hang, kill the terminal and run `az account list --all --refresh`
in a fresh shell — an existing refresh token usually makes interactive login
unnecessary.

## Verify Coverage

```powershell
# Which tenants exist at all (including ones with no subscriptions)
az rest --method get --url "https://management.azure.com/tenants?api-version=2022-12-01" `
  --query "value[].{tenantId:tenantId,name:displayName,domain:defaultDomain}" -o table
```

A `WARNING: The following tenants don't contain accessible subscriptions` message
is **normal** — it just means that tenant has directory access but no subscriptions.

## CRITICAL: Service Principals Do Not Cross Tenants

A cross-tenant *interactive* login works, but an app registration with
`signInAudience: AzureADMyOrg` (single-tenant) **cannot** issue a token for a
different tenant. Automation that must read multiple tenants needs either:

1. A **separate app registration + secret in each tenant** (cleanest, isolated), or
2. Converting the app to multi-tenant and provisioning the SP in the other tenant
   (requires admin consent; riskier if the app is also used for deployments).

Check before assuming:

```powershell
az ad app show --id <appId> --query "{name:displayName,audience:signInAudience}" -o json
az role assignment list --assignee <appId> --scope "/subscriptions/<subId>" --query "[].roleDefinitionName" -o tsv
```

Read-only cost access needs the `Cost Management Reader` role, granted **per
subscription** — it is not inherited across subscriptions.

## Gotchas

- **Multi-line commands pasted into the terminal often execute only the first
  line.** Write a `.ps1` to a temp path outside the repo (`C:\temp\`) and run it
  with `pwsh -NoProfile -File <path>`.
- **PowerShell cannot pass inline JSON to `az`.** Write the body to a file and
  reference it with `@`:
  ```powershell
  $body | Out-File -Encoding ascii C:\temp\q.json -NoNewline
  az rest --method post --url "..." --body "@C:\temp\q.json" --headers "Content-Type=application/json"
  ```
- **Cost Management API returns HTTP 429 aggressively.** Querying several
  subscriptions in a tight loop will rate-limit; add a delay or retry, and never
  interpret a 429 as `$0`.
- **A subscription showing $0 for 30 days may still have spend over 90 days.**
  Widen the window before concluding a subscription is unused.
- **Always re-verify subscription GUIDs from `az account list`.** Using a stale or
  mistyped GUID returns a valid-looking `$0` rather than an error.

## Reference — Tenants & Subscriptions (confirmed 2026-07-25)

Signed-in identity `mhussein@myxi.ai` reaches both tenants.

**Haytham tenant** `71a46d06-d6c8-4e81-8fe9-d2d6355392df`

| Subscription | ID |
|---|---|
| Xi_Sponsored_Subscription | `75920ee3-5dda-44fd-89ea-619c3265442e` |
| Xi_Sponsored_2 | `0620706e-3dfe-4346-95a4-568fb398caa4` |
| Xi_Sponsored_3 | `e435cf65-3013-45b2-ae64-47f2bfaf09aa` |
| ISV_Insta_Sub | `572546c0-97fb-44f3-94a8-311e67c6817b` |
| Pay-As-You-Go | `8cd89d93-1704-4fb5-8e99-27ad2ac8ccc5` |
| Unknown | `72029368-6545-433c-82c5-3cc3710611fa` |

**Xi tenant** `37c98e37-5c60-4bb8-a161-a946ea9279a2`

| Subscription | ID |
|---|---|
| Xi_Sponsored_Subscription_NEW | `79177aea-6f1e-40aa-b5ab-e78b363d93ed` |

Tenants with directory access but **no** subscriptions:
InstaConsult `c3a884ab-77a1-4e79-af4c-ce32554f4f4c`,
Foothill `eda60734-6629-4439-b419-266a437d6773`.
