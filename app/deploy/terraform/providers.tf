terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    azuread = { source = "hashicorp/azuread", version = "~> 3.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "azurerm" {
  features {}
  # Authenticate with `az login` (uses your GenAquarius tenant) before running.
  # Optionally set subscription_id = var.subscription_id
  subscription_id = var.subscription_id
}

provider "azuread" {
  # Same tenant as az login
}
