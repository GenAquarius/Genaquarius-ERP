<#
    Azure Automation runbook: stop/start BOTH environments (live + QA/staging) to save cost.

    Linked to two schedules (IST):
        nightly-stop  -> daily 00:00 IST  (Action = Stop)
        morning-start -> daily 10:00 IST  (Action = Start)

    Real cost saving comes from STOPPING the MySQL Flexible Servers (storage-only when
    stopped; they auto-restart after 7 days, which the daily start covers). Stopping the
    web apps does NOT reduce the (shared) App Service Plan bill, but is included so "all
    resources" are off overnight (smaller attack surface).

    Auth: the Automation account's SYSTEM-ASSIGNED MANAGED IDENTITY. A token is fetched
    directly from the sandbox MSI endpoint with Invoke-RestMethod, so NO Az modules
    (Az.Accounts/Az.MySql) need to be imported into the Automation account.
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Start", "Stop")]
    [string]$Action
)

$ErrorActionPreference = "Stop"

# --- Get an ARM token from the Automation sandbox managed identity (no modules needed) ---
$resource = "https://management.azure.com/"
$tokenUri = "$($env:IDENTITY_ENDPOINT)?resource=$resource&api-version=2019-08-01"
$tok = Invoke-RestMethod -Method Get -Uri $tokenUri -Headers @{ "X-IDENTITY-HEADER" = $env:IDENTITY_HEADER }
$headers = @{ Authorization = "Bearer $($tok.access_token)" }

$sub = "b93bacae-5a30-4f41-b33f-9635fc20205a"
$rg  = "gacostingtest2a4c-rg"

# Resources in BOTH environments.
$mysqlServers = @("gacostingtest2a4c-mysql", "gacostingtest2a4c-mysqlstg")
$webApps      = @("genaquariusinternal",     "genaquariusinternal-stg")

$mysqlApi = "2023-12-30"
$webApi   = "2024-04-01"
$verb     = $Action.ToLower()   # start | stop

function Invoke-Op($path, $api, $label) {
    $uri = "https://management.azure.com$path/$verb`?api-version=$api"
    try {
        # ContentType + empty JSON body required by some ARM action endpoints (e.g. MySQL
        # flexible-server returns 415 Unsupported Media Type for a POST with no media type).
        Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType "application/json" -Body "{}" | Out-Null
        Write-Output "OK: $verb $label"
    } catch {
        Write-Warning "FAILED: $verb $label -> $($_.Exception.Message)"
    }
}

Write-Output "=== $Action both environments (rg $rg) ==="
foreach ($s in $mysqlServers) {
    Invoke-Op "/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.DBforMySQL/flexibleServers/$s" $mysqlApi "MySQL $s"
}
foreach ($a in $webApps) {
    Invoke-Op "/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Web/sites/$a" $webApi "WebApp $a"
}
Write-Output "=== $Action complete ==="
