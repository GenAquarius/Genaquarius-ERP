# Microsoft Entra App Registration for SSO (genaquarius.com sign-in + 2FA).
data "azuread_client_config" "current" {}

# Security group that grants app access. ONLY members can sign in — not Global Admins.
# Seed it with just sandeep; add others when you want them in.
resource "azuread_group" "app_admins" {
  display_name     = "${var.prefix}-access"
  security_enabled = true
  members          = var.entra_db_admin_object_id == "" ? [] : [var.entra_db_admin_object_id]
  # Membership is managed operationally (az/portal) — don't let Terraform reset it.
  lifecycle {
    ignore_changes = [members]
  }
}

resource "azuread_application" "costing" {
  display_name     = "${var.prefix}-sso"
  sign_in_audience = "AzureADMyOrg" # only the GenAquarius tenant

  # Emit the user's security-group memberships in the id_token so the app can gate on them
  group_membership_claims = ["SecurityGroup"]

  web {
    redirect_uris = [
      "https://${var.prefix}.azurewebsites.net/api/auth/azure/callback",
      "${local.app_host}/api/auth/azure/callback",
    ]
  }

  # Delegated Microsoft Graph permissions: openid, profile, email, User.Read
  required_resource_access {
    resource_app_id = "00000003-0000-0000-c000-000000000000" # Microsoft Graph
    resource_access {
      id   = "e1fe6dd8-ba31-4d61-89e7-88639da4683d" # User.Read
      type = "Scope"
    }
    resource_access {
      id   = "37f7f235-527c-4136-accd-4a02d197296e" # openid
      type = "Scope"
    }
    resource_access {
      id   = "14dad69e-099b-42c9-810b-d002981feec1" # profile
      type = "Scope"
    }
    resource_access {
      id   = "64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0" # email
      type = "Scope"
    }
    # Application permission: send mail as any tenant user (used to send invoice
    # emails / timesheet reminders AS the logged-in user via Graph sendMail).
    resource_access {
      id   = "b633e1c5-b582-4048-a93e-9f11b44c7e96" # Mail.Send (Application)
      type = "Role"
    }
  }
}

# Microsoft Graph service principal (well-known app id) — needed to grant admin
# consent for the Mail.Send application role below.
data "azuread_service_principal" "msgraph" {
  client_id = "00000003-0000-0000-c000-000000000000"
}

# Grant admin consent for Mail.Send (application) to this app's service principal.
# Running `terraform apply` as a Global Admin performs the consent automatically —
# no portal click, no per-user prompt.
resource "azuread_app_role_assignment" "mail_send" {
  app_role_id         = "b633e1c5-b582-4048-a93e-9f11b44c7e96" # Mail.Send
  principal_object_id = azuread_service_principal.costing.object_id
  resource_object_id  = data.azuread_service_principal.msgraph.object_id
}

resource "azuread_service_principal" "costing" {
  client_id = azuread_application.costing.client_id
}

resource "azuread_application_password" "costing" {
  application_id = azuread_application.costing.id
  display_name   = "app-service-secret"
  end_date       = "2026-12-31T00:00:00Z"
}
