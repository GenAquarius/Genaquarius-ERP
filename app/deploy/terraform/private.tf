# ============================================================================
# Private networking (only when private_db = true)
# Gives MySQL a PRIVATE IP inside a VNet and removes its public endpoint, so the
# database has NO internet-reachable address at all. The App Service reaches it
# over regional VNet integration + a Private Endpoint; the public FQDN resolves
# to the private IP via a private DNS zone. (public_network_access is turned off
# out-of-band with the Azure CLI — the provider exposes it read-only.)
# ============================================================================

resource "azurerm_virtual_network" "vnet" {
  count               = var.private_db ? 1 : 0
  name                = "${var.prefix}-vnet"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  address_space       = ["10.40.0.0/16"]
}

# Subnet that holds the MySQL Private Endpoint NIC.
resource "azurerm_subnet" "pe" {
  count                = var.private_db ? 1 : 0
  name                 = "mysql-pe"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet[0].name
  address_prefixes     = ["10.40.1.0/28"]
}

# Subnet delegated to App Service for regional VNet integration (the app's outbound).
resource "azurerm_subnet" "appsvc" {
  count                = var.private_db ? 1 : 0
  name                 = "appsvc-int"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet[0].name
  address_prefixes     = ["10.40.2.0/27"]

  delegation {
    name = "webapp"
    service_delegation {
      name    = "Microsoft.Web/serverFarms"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

# Private DNS so the public FQDN resolves to the private IP from inside the VNet.
resource "azurerm_private_dns_zone" "mysql" {
  count               = var.private_db ? 1 : 0
  name                = "privatelink.mysql.database.azure.com"
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "mysql" {
  count                 = var.private_db ? 1 : 0
  name                  = "mysql-dns-link"
  resource_group_name   = azurerm_resource_group.rg.name
  private_dns_zone_name  = azurerm_private_dns_zone.mysql[0].name
  virtual_network_id    = azurerm_virtual_network.vnet[0].id
  registration_enabled  = false
}

# The Private Endpoint into the MySQL Flexible Server (registers the A record).
resource "azurerm_private_endpoint" "mysql" {
  count               = var.private_db ? 1 : 0
  name                = "${var.prefix}-mysql-pe"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  subnet_id           = azurerm_subnet.pe[0].id

  private_service_connection {
    name                           = "mysql-psc"
    private_connection_resource_id = azurerm_mysql_flexible_server.db.id
    subresource_names              = ["mysqlServer"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "mysql-dns-zg"
    private_dns_zone_ids = [azurerm_private_dns_zone.mysql[0].id]
  }
}
