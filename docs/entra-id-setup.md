# Entra ID App Registration — Tally Production

## Steps to register Tally in Microsoft Entra ID

### 1. Create App Registration

1. Go to [Azure Portal > Entra ID > App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
3. Configure:
   - **Name:** `Tally`
   - **Supported account types:** Accounts in this organizational directory only (Single tenant)
   - **Redirect URI:**
     - Platform: **Web**
     - URI: `https://tally.razorwire-productions.com/api/auth/_x_/oauth/callback`
4. Click **Register**

### 2. Note the IDs

After registration, copy these from the Overview page:
- **Application (client) ID** → This is `ENTRA_CLIENT_ID`
- **Directory (tenant) ID** → This is `ENTRA_TENANT_ID`

### 3. Create Client Secret

1. Go to **Certificates & secrets** > **Client secrets**
2. Click **New client secret**
3. Description: `Tally Production`
4. Expiry: 24 months (or per your policy)
5. Copy the **Value** → This is `ENTRA_CLIENT_SECRET`

### 4. Configure API Permissions

1. Go to **API permissions**
2. Ensure these are granted:
   - `openid` (delegated)
   - `profile` (delegated)
   - `email` (delegated)
3. Click **Grant admin consent** if required

### 5. Configure Token Claims (Optional)

1. Go to **Token configuration**
2. Add optional claims to the **ID token:**
   - `email`
   - `preferred_username`
   - `given_name`
   - `family_name`

### 6. Save to Vault

After completing the registration, save the credentials to Vault:

```bash
# Via PW orchestrator or direct Vault CLI
vault kv put secret/apps/tally/prod \
  ENTRA_CLIENT_ID="<application-id>" \
  ENTRA_CLIENT_SECRET="<client-secret-value>" \
  ENTRA_TENANT_ID="<directory-tenant-id>" \
  ENTRA_REDIRECT_URI="https://tally.razorwire-productions.com/api/auth/_x_/oauth/callback"
```

## Production Environment Variables

These will be injected by PW from Vault into the server container:

| Variable | Source | Description |
|----------|--------|-------------|
| `NODE_ENV` | `production` | Environment mode |
| `PORT` | `2727` | Server port |
| `CLIENT_URL` | `https://tally.razorwire-productions.com` | Public URL (for QR codes, redirects) |
| `MYSQL_URL` | `10.0.130.12` | Database VM IP |
| `MYSQL_USER` | Vault | DB application user |
| `MYSQL_PASSWORD` | Vault | DB password |
| `MYSQL_USE_SSL` | `true` | Enable SSL for MySQL |
| `TALLY_DB` | `TALLY` | Database name |
| `S3_ENDPOINT` | `https://10.0.130.13:9000` | MinIO endpoint |
| `S3_BUCKET` | `tally-files` | Storage bucket |
| `S3_ACCESS_KEY` | Vault | MinIO access key |
| `S3_SECRET_KEY` | Vault | MinIO secret key |
| `ENTRA_CLIENT_ID` | Vault | Entra app ID |
| `ENTRA_CLIENT_SECRET` | Vault | Entra secret |
| `ENTRA_TENANT_ID` | Vault | Entra tenant |
| `ENTRA_REDIRECT_URI` | `https://tally.razorwire-productions.com/api/auth/_x_/oauth/callback` | OAuth callback |
| `COOKIE_SECRET` | Vault | 32+ char secret for signed cookies |
| `BYPASS_AUTH` | `false` | Must be false in production |
| `LOG_LEVEL` | `info` | Logging level |
| `LOG_TO_FILE` | `true` | Enable file logging in production |
