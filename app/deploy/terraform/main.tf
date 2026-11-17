resource "azurerm_resource_group" "rg" {
  name     = "${var.prefix}-rg"
  location = var.location
}

# Strong app secret for signing session JWTs
resource "random_password" "jwt" {
  length  = 48
  special = false
}

# ---------------- Azure Database for MySQL (Flexible, smallest burstable tier) ----------------
resource "azurerm_mysql_flexible_server" "db" {
  name                   = "${var.prefix}-mysql"
  resource_group_name    = azurerm_resource_group.rg.name
  location               = azurerm_resource_group.rg.location
  administrator_login    = var.mysql_admin_user
  administrator_password = var.mysql_admin_password
  sku_name               = "B_Standard_B1ms" # cheapest burstable
  version                = "8.0.21"

  storage {
    size_gb = 20
  }
}

resource "azurerm_mysql_flexible_database" "costing" {
  name                = "costing"
  resource_group_name = azurerm_resource_group.rg.name
  server_name         = azurerm_mysql_flexible_server.db.name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}

# Allow the App Service (Azure-internal) to reach the DB. This special 0.0.0.0 rule
# permits only Azure-hosted resources — NOT the public internet.
resource "azurerm_mysql_flexible_server_firewall_rule" "azure" {
  count               = var.private_db ? 0 : 1 # no public firewall when the DB is private
  name                = "AllowAzureServices"
  resource_group_name = azurerm_resource_group.rg.name
  server_name         = azurerm_mysql_flexible_server.db.name
  start_ip_address    = "0.0.0.0"
  end_ip_address      = "0.0.0.0"
}

# The ONLY external address allowed in — your laptop. Everyone else is blocked.
resource "azurerm_mysql_flexible_server_firewall_rule" "my_ip" {
  count               = (var.private_db || var.my_client_ip == "") ? 0 : 1
  name                = "AdminClientIP"
  resource_group_name = azurerm_resource_group.rg.name
  server_name         = azurerm_mysql_flexible_server.db.name
  start_ip_address    = var.my_client_ip
  end_ip_address      = var.my_client_ip
}

# NOTE: Making your genaquarius.com account the MySQL Entra administrator is done
# with the Azure CLI after `terraform apply` (it needs a user-assigned identity on the
# server; the CLI handles this in one step). See app/deploy/DEPLOYMENT.md → "Securing the DB".
#   az mysql flexible-server identity assign ...
#   az mysql flexible-server ad-admin create --display-name <you> --object-id <oid> ...

# Enforce TLS on every DB connection (data-in-transit encryption). The app connects
# with ?sslaccept=strict (see DATABASE_URL), so plaintext connections are refused.
resource "azurerm_mysql_flexible_server_configuration" "require_tls" {
  name                = "require_secure_transport"
  resource_group_name = azurerm_resource_group.rg.name
  server_name         = azurerm_mysql_flexible_server.db.name
  value               = "ON"
}

# Rename only (was "no_tls" when forced TLS was off) — no resource recreate.
moved {
  from = azurerm_mysql_flexible_server_configuration.no_tls
  to   = azurerm_mysql_flexible_server_configuration.require_tls
}

# ---------------- App Service (Linux, Node) — serves API + React ----------------
resource "azurerm_service_plan" "plan" {
  name                = "${var.prefix}-plan"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = "B1" # basic, cheapest always-on tier
}

locals {
  app_name = var.webapp_name != "" ? var.webapp_name : var.prefix
  app_host = "https://${local.app_name}.azurewebsites.net"
}

resource "azurerm_linux_web_app" "app" {
  name                = local.app_name
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.plan.id

  # Force HTTPS — HTTP requests are redirected to HTTPS.
  https_only = true

  # Regional VNet integration — the app's path to the private DB (only when private_db).
  virtual_network_subnet_id = var.private_db ? azurerm_subnet.appsvc[0].id : null

  site_config {
    application_stack { node_version = "22-lts" }
    # schema + seed are applied out-of-band; just run the compiled server
    app_command_line = "node dist/index.js"
    always_on        = true
    # Route the app's outbound (incl. DB traffic) through the VNet when private.
    vnet_route_all_enabled = var.private_db
  }

  app_settings = merge({
    NODE_ENV                          = "production"
    PORT                              = "8080"
    WEBSITES_PORT                     = "8080"
    SCM_DO_BUILD_DURING_DEPLOYMENT    = "false"
    DATABASE_URL                      = "mysql://${var.mysql_admin_user}:${var.mysql_admin_password}@${azurerm_mysql_flexible_server.db.fqdn}:3306/costing?sslaccept=strict"
    JWT_SECRET                        = random_password.jwt.result
    CLIENT_ORIGIN                     = local.app_host
    ALLOW_LOCAL_LOGIN                 = "false"
    BLOCKED_SIGNIN_ROLES              = var.blocked_signin_roles
    AZURE_AUTO_PROVISION              = "false"
    AZURE_TENANT_ID                   = data.azuread_client_config.current.tenant_id
    AZURE_CLIENT_ID                   = azuread_application.costing.client_id
    AZURE_CLIENT_SECRET               = azuread_application_password.costing.value
    AZURE_REDIRECT_URI                = "${local.app_host}/api/auth/azure/callback"
    AZURE_ALLOWED_GROUP_ID            = azuread_group.app_admins.object_id
  }, var.private_db ? {
    # Use Azure DNS so the app resolves the DB's private DNS zone over VNet integration.
    WEBSITE_DNS_SERVER = "168.63.129.16"
  } : {})
}
