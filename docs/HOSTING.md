# Database hosting integrations

The Data step starts with Neon, Supabase, and PlanetScale. Choose a host, connect an account, choose a database or branch, then preview and select tables. Only selected tables are imported. Direct PostgreSQL/MySQL connections, files, REST, blob storage, and the ingestion API are shown directly below the hosts, separated by a divider.

Provider sign-in needs an OAuth integration that you register first. Without registration, Neon accepts an API key, Supabase accepts a personal access token, and PlanetScale accepts a service token ID and token. Each dialog includes a token setup link and a **Connect account** button. All three also offer direct database connections. Provider tokens are different from database passwords or Supabase project anon/service-role keys.

## Installation

Set the provider's client ID and secret using the variables in `.env.example`: `NEON_CLIENT_ID`, `NEON_CLIENT_SECRET`, `SUPABASE_CLIENT_ID`, `SUPABASE_CLIENT_SECRET`, `PLANETSCALE_CLIENT_ID`, and `PLANETSCALE_CLIENT_SECRET`. Compose passes these only to the app. Never put them in frontend code.

Register the exact callback for each workspace using the browser origin on this computer (`APP_ORIGIN` in development, `PUBLIC_ORIGIN` in Compose; `http://localhost:3001` by default):

```text
http://localhost:3001/api/v1/workspaces/WORKSPACE_ID/hosting/neon/callback
http://localhost:3001/api/v1/workspaces/WORKSPACE_ID/hosting/supabase/callback
http://localhost:3001/api/v1/workspaces/WORKSPACE_ID/hosting/planetscale/callback
```

The current callback is workspace-specific, so add callbacks for new workspaces. Local development uses `http://localhost:5173`. The provider must allow `localhost` callbacks; Foundry has no sign-in and must not be exposed to a network to obtain a public callback URL. Restart the app after changing credentials. The dialog will offer **Continue with…**. Check a real authorization and import before relying on it; mocked protocol tests do not establish provider approval or live connectivity.

## Providers

- **Neon:** [OAuth documentation](https://neon.com/docs/guides/oauth-integration). OAuth requires an approved commercial partnership. Foundry requests project read and offline refresh scopes; API keys are an alternative. Select a project, branch, and database. Foundry retrieves the existing database owner's connection URI without creating or resetting a role. For a separately provisioned restricted role, use a direct connection.
- **Supabase:** [OAuth documentation](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration) and [scopes](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes). Configure project and database configuration read access. Personal access tokens are an alternative. Select a project and enter its database password, which the Management API cannot retrieve. Foundry uses the direct PostgreSQL host. If its IPv6 endpoint is unreachable, use a reachable direct/pooler URL instead.
- **PlanetScale:** [OAuth documentation](https://planetscale.com/docs/api/planetscale-api-oauth-applications). Enable organization/database/branch listing and credential creation for your engine, including read-only production password access when applicable. Select an organization, database, and branch. Foundry creates a reader password for Vitess/MySQL, or a PostgreSQL role inheriting `pg_read_all_data` without replication, named `Helix Foundry …`.

Provider sign-in starts only from the app in the browser, and read-only API tokens cannot connect provider accounts. Authorized selections are rechecked server-side, and credentials remain encrypted on the server. The browser receives discovery results and an opaque workspace-scoped connection reference. Existing full imports, schema review, and automatic sync apply afterward. Provider sign-in does not grant replication privileges; restricted credentials may use the existing snapshot fallback when CDC is unavailable.

## Recovery and security

For PlanetScale without OAuth, create a service token in **Settings → Service tokens**, copy its ID and token into Foundry, and grant permissions only for the databases you intend to import. Foundry validates the token by listing its organizations before storing it. It uses PlanetScale's `ID:TOKEN` authorization scheme, not a bearer token. Organization and database choices are checked against that token's authorized resources at every step. See [service tokens](https://planetscale.com/docs/api/service-tokens).

Grant database/branch read access plus permission to create the connection credential: Vitess/MySQL uses `connect_branch` for development branches or `connect_production_read_only_branch` for production; PostgreSQL uses `create_branch_password` or `create_production_read_only_branch_password`. Foundry requests a reader credential. Broader token-management or source-data write permissions are unnecessary. Revoked tokens can be replaced using **Connect another account**. The SDK exposes `hostingServiceToken({ serviceTokenId, serviceToken })` alongside the existing Neon/Supabase method.

OAuth state expires after ten minutes and is single-use, bound to the browser, the local session, and the workspace. Neon and Supabase use PKCE. Tokens and database credentials are excluded from public resource retrieval and AI context. Request logs omit callback query strings. Account listings are paginated and bounded; oversized accounts receive an explicit direct-connection fallback rather than silently incomplete results.

Prepared credentials are persisted before discovery so discovery retries reuse them. An interrupted PlanetScale credential-creation response can leave an unused remote credential; revoke unused `Helix Foundry …` credentials in its console. Removing a source from setup does not revoke provider access. Revoke it at the provider when retiring a connection, retaining credentials still needed by other sources.

Outages, revoked access, and private networks can prevent connection. Retry after fixing access, reconnect, or use a direct URL. Foundry does not reset database passwords, modify server-wide network settings, or switch hosting providers automatically.

`tests/hosting.test.ts` covers mocked protocols, browser binding, encrypted persistence and refresh, read-only token and browser-only restrictions, workspace isolation, selected-resource checks, reader credential requests, and pagination. Live checks require configured integrations and an accessible test database.
