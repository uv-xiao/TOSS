use super::*;

pub(super) fn build_router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/v1/auth/config", get(auth_config))
        .route("/v1/auth/local/login", post(local_login))
        .route("/v1/auth/local/register", post(local_register))
        .route("/v1/auth/oidc/login", get(oidc_login))
        .route("/v1/auth/oidc/callback", get(oidc_callback))
        .route("/v1/auth/me", get(auth_me))
        .route("/v1/auth/logout", post(auth_logout))
        .route("/v1/realtime/auth/{project_id}", get(realtime_auth))
        .route("/v1/realtime/ws/{doc_id}", get(realtime_ws_handler))
        .route(
            "/v1/profile/security/tokens",
            get(list_personal_access_tokens).post(create_personal_access_token),
        )
        .route(
            "/v1/profile/security/tokens/{token_id}",
            delete(revoke_personal_access_token),
        )
        .route(
            "/v1/organizations",
            get(list_organizations).post(create_organization),
        )
        .route("/v1/organizations/mine", get(list_my_organizations))
        .route("/v1/projects", get(list_projects).post(create_project))
        .route("/v1/projects/{project_id}", patch(update_project_name))
        .route("/v1/projects/{project_id}/copy", post(copy_project))
        .route(
            "/v1/projects/{project_id}/template",
            put(update_project_template),
        )
        .route(
            "/v1/projects/{project_id}/template-organization-access",
            get(list_project_template_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/template-organization-access/{org_id}",
            put(upsert_project_template_organization_access)
                .delete(delete_project_template_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/thumbnail",
            get(get_project_thumbnail).put(upload_project_thumbnail),
        )
        .route("/v1/projects/{project_id}/tree", get(get_project_tree))
        .route("/v1/projects/{project_id}/files", post(create_project_file))
        .route(
            "/v1/projects/{project_id}/files/move",
            patch(move_project_file),
        )
        .route(
            "/v1/projects/{project_id}/files/{*path}",
            delete(delete_project_file),
        )
        .route(
            "/v1/projects/{project_id}/roles",
            get(list_roles).post(upsert_role),
        )
        .route(
            "/v1/projects/{project_id}/access-users",
            get(list_project_access_users),
        )
        .route(
            "/v1/projects/{project_id}/settings",
            get(get_project_settings).put(upsert_project_settings),
        )
        .route(
            "/v1/projects/{project_id}/organization-access",
            get(list_project_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/organization-access/{org_id}",
            put(upsert_project_organization_access).delete(delete_project_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/share-links",
            get(list_project_share_links).post(create_project_share_link),
        )
        .route(
            "/v1/projects/{project_id}/share-links/{share_link_id}",
            delete(revoke_project_share_link),
        )
        .route(
            "/v1/projects/{project_id}/group-roles",
            get(list_group_roles).post(upsert_group_role),
        )
        .route(
            "/v1/projects/{project_id}/group-roles/{group_name}",
            delete(delete_group_role),
        )
        .route(
            "/v1/projects/{project_id}/revisions",
            get(list_revisions).post(create_revision),
        )
        .route(
            "/v1/projects/{project_id}/revisions/{revision_id}/documents",
            get(get_revision_documents),
        )
        .route(
            "/v1/projects/{project_id}/documents",
            get(list_documents).post(create_document),
        )
        .route(
            "/v1/projects/{project_id}/documents/by-path/{path}",
            put(upsert_document_by_path),
        )
        .route(
            "/v1/projects/{project_id}/documents/{document_id}",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        .route(
            "/v1/projects/{project_id}/assets",
            get(list_project_assets).post(upload_project_asset),
        )
        .route(
            "/v1/projects/{project_id}/assets/{asset_id}",
            get(get_project_asset).delete(delete_project_asset),
        )
        .route(
            "/v1/projects/{project_id}/assets/{asset_id}/raw",
            get(get_project_asset_raw),
        )
        .route(
            "/v1/projects/{project_id}/archive",
            get(download_project_archive).patch(update_project_archived),
        )
        .route(
            "/v1/projects/{project_id}/pdf-artifacts",
            post(upload_project_pdf_artifact),
        )
        .route(
            "/v1/projects/{project_id}/pdf-artifacts/latest",
            get(download_latest_project_pdf_artifact),
        )
        .route("/v1/typst/packages/{*path}", get(typst_package_proxy))
        .route("/v1/git/status/{project_id}", get(git_status))
        .route("/v1/git/repo-link/{project_id}", get(git_repo_link))
        .route("/v1/git/repo/{project_id}/{*rest}", any(git_http_backend))
        .route("/v1/share/{token}/resolve", get(resolve_project_share_link))
        .route(
            "/v1/share/{token}/temporary-login",
            post(create_temporary_share_login),
        )
        .route("/v1/share/{token}/join", post(join_project_share_link))
        .route(
            "/v1/admin/orgs/{org_id}/oidc-group-role-mappings",
            get(list_org_group_role_mappings).post(upsert_org_group_role_mapping),
        )
        .route(
            "/v1/admin/orgs/{org_id}/oidc-group-role-mappings/{group_name}",
            delete(delete_org_group_role_mapping),
        )
        .route(
            "/v1/admin/settings/auth",
            get(get_admin_auth_settings).put(upsert_admin_auth_settings),
        )
}
