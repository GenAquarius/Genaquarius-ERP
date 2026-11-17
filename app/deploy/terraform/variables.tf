variable "subscription_id" {
  type        = string
  description = "Azure subscription ID in the GenAquarius tenant"
}

variable "location" {
  type        = string
  default     = "Central India"
  description = "Azure region"
}

variable "prefix" {
  type        = string
  default     = "ga-costing-test"
  description = "Name prefix for all resources (RG, MySQL, plan, Entra)"
}

variable "webapp_name" {
  type        = string
  default     = ""
  description = "Globally-unique App Service name (=> <name>.azurewebsites.net). Defaults to prefix."
}

variable "mysql_admin_user" {
  type    = string
  default = "costadmin"
}

variable "mysql_admin_password" {
  type        = string
  sensitive   = true
  description = "MySQL admin password (>=8 chars, upper/lower/number/symbol)"
}

# Roles blocked from signing in for now (matches the app's BLOCKED_SIGNIN_ROLES)
variable "blocked_signin_roles" {
  type    = string
  default = "EMPLOYEE,PROJECT_MANAGER"
}

# Your laptop's public IP — the ONLY non-Azure address allowed to reach the DB.
# Find it with: curl https://ifconfig.me
variable "my_client_ip" {
  type        = string
  default     = ""
  description = "Public IP allowed to connect to MySQL for admin. Leave empty to allow none."
}

# Your genaquarius.com identity to make the MySQL Entra (Azure AD) administrator.
variable "entra_db_admin_login" {
  type        = string
  default     = "" # e.g. sandeep.minocha@genaquarius.com
  description = "UPN of the genaquarius.com user who can open the DB via Entra token"
}
variable "entra_db_admin_object_id" {
  type        = string
  default     = "" # az ad user show --id <upn> --query id -o tsv
  description = "Entra object ID of that user"
}

# Put MySQL on a private VNet with NO public endpoint (App Service reaches it privately).
variable "private_db" {
  type        = bool
  default     = false
  description = "true = private VNet MySQL (no public endpoint); false = public endpoint locked by firewall"
}

# App connects to MySQL with its managed identity (Entra token) instead of a password.
variable "passwordless_db" {
  type        = bool
  default     = false
  description = "true = App Service uses its managed identity for DB auth (no SQL password in settings)"
}
