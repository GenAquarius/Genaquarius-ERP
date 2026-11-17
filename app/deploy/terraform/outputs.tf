output "app_url" {
  value = "https://${azurerm_linux_web_app.app.default_hostname}"
}

output "mysql_fqdn" {
  value = azurerm_mysql_flexible_server.db.fqdn
}

output "entra_client_id" {
  value = azuread_application.costing.client_id
}

output "entra_tenant_id" {
  value = data.azuread_client_config.current.tenant_id
}

output "entra_client_secret" {
  value     = azuread_application_password.costing.value
  sensitive = true
}

output "redirect_uri" {
  value = "https://${var.prefix}.azurewebsites.net/api/auth/azure/callback"
}

output "access_group_id" {
  value       = azuread_group.app_admins.object_id
  description = "Entra group whose members can sign in (manage membership to control access)"
}
