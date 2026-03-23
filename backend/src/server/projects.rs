async fn list_projects(
    State(state): State<AppState>,
    Query(query): Query<ListProjectsQuery>,
    headers: HeaderMap,
) -> Result<Json<ProjectListResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let include_archived = query.include_archived.unwrap_or(true);
    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| format!("%{v}%"));
    let direct_rows = sqlx::query(
        "select p.id,
                p.name,
                p.owner_user_id,
                coalesce(owner.display_name, 'Unknown') as owner_display_name,
                p.created_at,
                greatest(
                  p.created_at,
                  coalesce((select max(d.updated_at) from documents d where d.project_id = p.id), p.created_at),
                  coalesce((select max(r.created_at) from revisions r where r.project_id = p.id), p.created_at),
                  coalesce((select max(a.created_at) from project_assets a where a.project_id = p.id), p.created_at)
                ) as last_edited_at,
                pua.archived_at as user_archived_at,
                pr.role as my_role
         from projects p
         join project_roles pr on pr.project_id = p.id
         left join users owner on owner.id = p.owner_user_id
         left join project_user_archives pua on pua.project_id = p.id and pua.user_id = $1
         where pr.user_id = $1
           and ($2::boolean = true or pua.archived_at is null)
           and ($3::text is null or p.name ilike $3)",
    )
    .bind(actor)
    .bind(include_archived)
    .bind(search.as_deref())
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let org_ids = user_organization_ids(&state.db, actor).await?;
    let org_rows = if org_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            "select p.id,
                    p.name,
                    p.owner_user_id,
                    coalesce(owner.display_name, 'Unknown') as owner_display_name,
                    p.created_at,
                    greatest(
                      p.created_at,
                      coalesce((select max(d.updated_at) from documents d where d.project_id = p.id), p.created_at),
                      coalesce((select max(r.created_at) from revisions r where r.project_id = p.id), p.created_at),
                      coalesce((select max(a.created_at) from project_assets a where a.project_id = p.id), p.created_at)
                    ) as last_edited_at,
                    pua.archived_at as user_archived_at,
                    poa.permission
             from projects p
             join project_organization_access poa on poa.project_id = p.id
             left join users owner on owner.id = p.owner_user_id
             left join project_user_archives pua on pua.project_id = p.id and pua.user_id = $2
             where poa.organization_id = any($1::uuid[])
               and ($3::boolean = true or pua.archived_at is null)
               and ($4::text is null or p.name ilike $4)",
        )
        .bind(&org_ids)
        .bind(actor)
        .bind(include_archived)
        .bind(search.as_deref())
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };
    let mut projects_by_id: HashMap<Uuid, Project> = HashMap::new();
    for row in direct_rows {
        let project_id: Uuid = row.get("id");
        projects_by_id.insert(
            project_id,
            Project {
                id: project_id,
                name: row.get("name"),
                owner_user_id: row.get("owner_user_id"),
                owner_display_name: row.get("owner_display_name"),
                my_role: row.get("my_role"),
                created_at: row.get("created_at"),
                last_edited_at: row.get("last_edited_at"),
                archived: row
                    .get::<Option<DateTime<Utc>>, _>("user_archived_at")
                    .is_some(),
                archived_at: row.get("user_archived_at"),
            },
        );
    }
    for row in org_rows {
        let project_id: Uuid = row.get("id");
        let permission: String = row.get("permission");
        let derived_role = if permission == "write" {
            "Student".to_string()
        } else {
            "Viewer".to_string()
        };
        if let Some(existing) = projects_by_id.get_mut(&project_id) {
            if role_rank(&derived_role) > role_rank(&existing.my_role) {
                existing.my_role = derived_role;
            }
            continue;
        }
        projects_by_id.insert(
            project_id,
            Project {
                id: project_id,
                name: row.get("name"),
                owner_user_id: row.get("owner_user_id"),
                owner_display_name: row.get("owner_display_name"),
                my_role: derived_role,
                created_at: row.get("created_at"),
                last_edited_at: row.get("last_edited_at"),
                archived: row
                    .get::<Option<DateTime<Utc>>, _>("user_archived_at")
                    .is_some(),
                archived_at: row.get("user_archived_at"),
            },
        );
    }
    let mut projects = projects_by_id.into_values().collect::<Vec<_>>();
    projects.sort_by(|a, b| b.last_edited_at.cmp(&a.last_edited_at));

    Ok(Json(ProjectListResponse { projects }))
}

async fn list_my_organizations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OrganizationMembershipListResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let rows = sqlx::query(
        "select o.id as organization_id, o.name as organization_name,
                (oa.user_id is not null) as is_admin,
                coalesce(om.joined_at, oa.granted_at, o.created_at) as joined_at
         from organizations o
         left join organization_memberships om
           on om.organization_id = o.id and om.user_id = $1
         left join org_admins oa
           on oa.organization_id = o.id and oa.user_id = $1
         where om.user_id is not null or oa.user_id is not null
         order by o.name asc",
    )
    .bind(actor)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let organizations = rows
        .into_iter()
        .map(|row| OrganizationMembership {
            organization_id: row.get("organization_id"),
            organization_name: row.get("organization_name"),
            is_admin: row.get("is_admin"),
            joined_at: row.get("joined_at"),
        })
        .collect();
    Ok(Json(OrganizationMembershipListResponse { organizations }))
}

async fn user_organization_ids(db: &PgPool, user_id: Uuid) -> Result<Vec<Uuid>, StatusCode> {
    let rows = sqlx::query(
        "select organization_id from organization_memberships where user_id = $1
         union
         select organization_id from org_admins where user_id = $1",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(rows
        .into_iter()
        .map(|row| row.get::<Uuid, _>("organization_id"))
        .collect())
}

async fn user_is_org_member(db: &PgPool, user_id: Uuid, org_id: Uuid) -> Result<bool, StatusCode> {
    let row = sqlx::query(
        "select 1
         from (
           select organization_id from organization_memberships where user_id = $1
           union
           select organization_id from org_admins where user_id = $1
         ) orgs
         where organization_id = $2
         limit 1",
    )
    .bind(user_id)
    .bind(org_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(row.is_some())
}

async fn default_organization_id(db: &PgPool) -> Result<Uuid, StatusCode> {
    if let Ok(parsed) = Uuid::parse_str(DEFAULT_ORG_ID) {
        let row = sqlx::query("select id from organizations where id = $1")
            .bind(parsed)
            .fetch_optional(db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if row.is_some() {
            return Ok(parsed);
        }
    }
    let row = sqlx::query("select id from organizations order by created_at asc limit 1")
        .fetch_optional(db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    row.map(|r| r.get("id"))
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)
}

async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateProjectInput>,
) -> Result<Json<Project>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let id = Uuid::new_v4();
    let created_at = Utc::now();
    let org_id = user_organization_ids(&state.db, actor)
        .await?
        .into_iter()
        .next()
        .unwrap_or(default_organization_id(&state.db).await?);
    let _ = sqlx::query(
        "insert into organization_memberships (organization_id, user_id, joined_at)
         values ($1, $2, $3)
         on conflict (organization_id, user_id) do nothing",
    )
    .bind(org_id)
    .bind(actor)
    .bind(created_at)
    .execute(&state.db)
    .await;
    let row = sqlx::query(
        "insert into projects (id, organization_id, owner_user_id, name, description, created_at)
         values ($1, $2, $3, $4, $5, $6)
         returning id, name, created_at, owner_user_id",
    )
    .bind(id)
    .bind(org_id)
    .bind(actor)
    .bind(input.name)
    .bind(Option::<String>::None)
    .bind(created_at)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let _ = sqlx::query(
        "insert into project_roles (project_id, user_id, role, granted_at) values ($1, $2, 'Owner', $3)
         on conflict (project_id, user_id) do update set role = excluded.role",
    )
    .bind(id)
    .bind(actor)
    .bind(created_at)
    .execute(&state.db)
    .await;

    let _ = sqlx::query(
        "insert into git_sync_states (project_id, branch, has_conflicts, status) values ($1, 'main', false, 'clean')
         on conflict (project_id) do nothing",
    )
    .bind(id)
    .execute(&state.db)
    .await;

    let _ = sqlx::query(
        "insert into project_settings (project_id, entry_file_path, updated_at)
         values ($1, 'main.typ', $2)
         on conflict (project_id) do nothing",
    )
    .bind(id)
    .bind(created_at)
    .execute(&state.db)
    .await;

    let _ = sqlx::query(
        "insert into documents (id, project_id, path, content, updated_at)
         values ($1, $2, 'main.typ', '', $3)
         on conflict (project_id, path) do nothing",
    )
    .bind(Uuid::new_v4())
    .bind(id)
    .bind(created_at)
    .execute(&state.db)
    .await;

    let owner_display_name = sqlx::query("select display_name from users where id = $1")
        .bind(actor)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(|r| r.get::<String, _>("display_name"))
        .unwrap_or_else(|| "Unknown".to_string());

    write_audit(
        &state.db,
        Some(actor),
        "project.create",
        serde_json::json!({"project_id": id, "name": row.get::<String, _>("name")}),
    )
    .await;

    Ok(Json(Project {
        id: row.get("id"),
        name: row.get("name"),
        owner_user_id: row.get("owner_user_id"),
        owner_display_name,
        my_role: "Owner".to_string(),
        created_at: row.get("created_at"),
        last_edited_at: row.get("created_at"),
        archived: false,
        archived_at: None,
    }))
}

fn normalized_share_permission(raw: &str) -> Option<&'static str> {
    let lowered = raw.trim().to_ascii_lowercase();
    match lowered.as_str() {
        "read" | "readonly" | "viewer" => Some("read"),
        "write" | "writable" | "edit" | "editor" => Some("write"),
        _ => None,
    }
}

fn grant_role_from_share_permission(permission: &str) -> &'static str {
    if permission == "write" {
        "Student"
    } else {
        "Viewer"
    }
}

async fn list_project_share_links(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectShareLink>>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let rows = sqlx::query(
        "select id, project_id, token_prefix, token_value, permission, created_by, created_at, expires_at, revoked_at
         from project_share_links
         where project_id = $1 and revoked_at is null
         order by permission asc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items = rows
        .into_iter()
        .map(|row| ProjectShareLink {
            id: row.get("id"),
            project_id: row.get("project_id"),
            token_prefix: row.get("token_prefix"),
            token_value: row.get("token_value"),
            permission: row.get("permission"),
            created_by: row.get("created_by"),
            created_at: row.get("created_at"),
            expires_at: row.get("expires_at"),
            revoked_at: row.get("revoked_at"),
        })
        .collect();
    Ok(Json(items))
}

async fn create_project_share_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateProjectShareLinkInput>,
) -> Result<Json<CreateProjectShareLinkResponse>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let permission =
        normalized_share_permission(&input.permission).ok_or(StatusCode::BAD_REQUEST)?;
    let expires_at = if let Some(raw) = input.expires_at {
        Some(
            DateTime::parse_from_rfc3339(&raw)
                .map_err(|_| StatusCode::BAD_REQUEST)?
                .with_timezone(&Utc),
        )
    } else {
        None
    };
    if let Some(expires_at) = expires_at {
        if expires_at <= Utc::now() {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    let now = Utc::now();
    let existing = sqlx::query(
        "select id, token_value
         from project_share_links
         where project_id = $1 and permission = $2 and revoked_at is null
         limit 1",
    )
    .bind(project_id)
    .bind(permission)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(existing) = existing {
        let existing_id: Uuid = existing.get("id");
        let existing_token: Option<String> = existing.get("token_value");
        let token = existing_token.unwrap_or_else(|| format!("psh_{}", random_token(36)));
        let token_prefix = token.chars().take(12).collect::<String>();
        let row = sqlx::query(
            "update project_share_links
             set token_prefix = $3,
                 token_hash = $4,
                 token_value = $5,
                 created_by = $6,
                 created_at = $7,
                 expires_at = $8
             where id = $1 and project_id = $2
             returning id, project_id, token_prefix, token_value, permission, created_by, created_at, expires_at, revoked_at",
        )
        .bind(existing_id)
        .bind(project_id)
        .bind(&token_prefix)
        .bind(token_sha256(&token))
        .bind(&token)
        .bind(actor)
        .bind(now)
        .bind(expires_at)
        .fetch_one(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        write_audit(
            &state.db,
            Some(actor),
            "project.share_link.enable",
            serde_json::json!({
                "project_id": project_id,
                "share_link_id": existing_id,
                "permission": permission,
                "expires_at": expires_at
            }),
        )
        .await;
        return Ok(Json(CreateProjectShareLinkResponse {
            link: ProjectShareLink {
                id: row.get("id"),
                project_id: row.get("project_id"),
                token_prefix: row.get("token_prefix"),
                token_value: row.get("token_value"),
                permission: row.get("permission"),
                created_by: row.get("created_by"),
                created_at: row.get("created_at"),
                expires_at: row.get("expires_at"),
                revoked_at: row.get("revoked_at"),
            },
            token,
        }));
    }
    let token = format!("psh_{}", random_token(36));
    let token_prefix = token.chars().take(12).collect::<String>();
    let id = Uuid::new_v4();
    let row = sqlx::query(
        "insert into project_share_links
         (id, project_id, token_prefix, token_hash, token_value, permission, created_by, created_at, expires_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null)
         returning id, project_id, token_prefix, token_value, permission, created_by, created_at, expires_at, revoked_at",
    )
    .bind(id)
    .bind(project_id)
    .bind(&token_prefix)
    .bind(token_sha256(&token))
    .bind(&token)
    .bind(permission)
    .bind(actor)
    .bind(now)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "project.share_link.create",
        serde_json::json!({
            "project_id": project_id,
            "share_link_id": id,
            "permission": permission,
            "expires_at": expires_at
        }),
    )
    .await;

    Ok(Json(CreateProjectShareLinkResponse {
        link: ProjectShareLink {
            id: row.get("id"),
            project_id: row.get("project_id"),
            token_prefix: row.get("token_prefix"),
            token_value: row.get("token_value"),
            permission: row.get("permission"),
            created_by: row.get("created_by"),
            created_at: row.get("created_at"),
            expires_at: row.get("expires_at"),
            revoked_at: row.get("revoked_at"),
        },
        token,
    }))
}

async fn revoke_project_share_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, share_link_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let result = sqlx::query(
        "update project_share_links
         set revoked_at = $3
         where id = $1 and project_id = $2 and revoked_at is null",
    )
    .bind(share_link_id)
    .bind(project_id)
    .bind(Utc::now())
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.share_link.revoke",
        serde_json::json!({"project_id": project_id, "share_link_id": share_link_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn join_project_share_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<JoinProjectShareLinkResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let token = token.trim();
    if token.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let row = sqlx::query(
        "select id, project_id, permission, created_by
         from project_share_links
         where (token_value = $1 or token_hash = $2)
           and revoked_at is null
           and (expires_at is null or expires_at > now())",
    )
    .bind(token)
    .bind(token_sha256(token))
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let project_id: Uuid = row.get("project_id");
    let permission: String = row.get("permission");
    let target_role = grant_role_from_share_permission(&permission).to_string();
    let granted_at = Utc::now();
    let existing =
        sqlx::query("select role from project_roles where project_id = $1 and user_id = $2")
            .bind(project_id)
            .bind(actor)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let final_role = if let Some(existing) = existing {
        let existing_role: String = existing.get("role");
        if role_rank(&existing_role) >= role_rank(&target_role) {
            existing_role
        } else {
            sqlx::query(
                "update project_roles
                 set role = $3, granted_at = $4
                 where project_id = $1 and user_id = $2",
            )
            .bind(project_id)
            .bind(actor)
            .bind(&target_role)
            .bind(granted_at)
            .execute(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            target_role.clone()
        }
    } else {
        sqlx::query(
            "insert into project_roles (project_id, user_id, role, granted_at)
             values ($1, $2, $3, $4)",
        )
        .bind(project_id)
        .bind(actor)
        .bind(&target_role)
        .bind(granted_at)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        target_role.clone()
    };

    write_audit(
        &state.db,
        Some(actor),
        "project.share_link.join",
        serde_json::json!({
            "project_id": project_id,
            "granted_role": final_role,
            "permission": permission
        }),
    )
    .await;

    Ok(Json(JoinProjectShareLinkResponse {
        project_id,
        role: final_role,
    }))
}

async fn list_roles(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectRoleBinding>>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select project_id, user_id, role, granted_at from project_roles where project_id = $1 order by granted_at desc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let roles = rows
        .into_iter()
        .map(|r| ProjectRoleBinding {
            project_id: r.get("project_id"),
            user_id: r.get("user_id"),
            role: r.get("role"),
            granted_at: r.get("granted_at"),
        })
        .collect();
    Ok(Json(roles))
}

async fn upsert_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertRoleInput>,
) -> Result<Json<ProjectRoleBinding>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let granted_at = Utc::now();
    let row = sqlx::query(
        "insert into project_roles (project_id, user_id, role, granted_at) values ($1, $2, $3, $4)
         on conflict (project_id, user_id) do update set role = excluded.role, granted_at = excluded.granted_at
         returning project_id, user_id, role, granted_at",
    )
    .bind(project_id)
    .bind(input.user_id)
    .bind(input.role)
    .bind(granted_at)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "project.role.upsert",
        serde_json::json!({"project_id": project_id, "target_user_id": input.user_id, "role": row.get::<String, _>("role")}),
    )
    .await;

    Ok(Json(ProjectRoleBinding {
        project_id: row.get("project_id"),
        user_id: row.get("user_id"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    }))
}

fn sanitize_project_path(raw: &str) -> Result<String, StatusCode> {
    let trimmed = raw.trim().trim_start_matches('/').to_string();
    if trimmed.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let p = std::path::Path::new(&trimmed);
    if p.is_absolute() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if p.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(trimmed)
}

async fn get_project_tree(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectTreeResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query("select path from documents where project_id = $1 order by path asc")
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let dir_rows =
        sqlx::query("select path from project_directories where project_id = $1 order by path asc")
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let asset_rows =
        sqlx::query("select path from project_assets where project_id = $1 order by path asc")
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let settings =
        sqlx::query("select entry_file_path from project_settings where project_id = $1")
            .bind(project_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let entry_file_path = settings
        .map(|r| r.get::<String, _>("entry_file_path"))
        .unwrap_or_else(|| "main.typ".to_string());

    let mut dirs: HashSet<String> = HashSet::new();
    let mut nodes = Vec::new();
    for row in rows {
        let file_path: String = row.get("path");
        let clean = sanitize_project_path(&file_path)?;
        let mut acc = String::new();
        let parts: Vec<&str> = clean.split('/').collect();
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            if acc.is_empty() {
                acc.push_str(part);
            } else {
                acc.push('/');
                acc.push_str(part);
            }
            dirs.insert(acc.clone());
        }
        nodes.push(ProjectFileNode {
            path: clean,
            kind: "file".to_string(),
        });
    }
    for row in asset_rows {
        let file_path: String = row.get("path");
        let clean = sanitize_project_path(&file_path)?;
        let mut acc = String::new();
        let parts: Vec<&str> = clean.split('/').collect();
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            if acc.is_empty() {
                acc.push_str(part);
            } else {
                acc.push('/');
                acc.push_str(part);
            }
            dirs.insert(acc.clone());
        }
        nodes.push(ProjectFileNode {
            path: clean,
            kind: "file".to_string(),
        });
    }
    for row in dir_rows {
        let dir_path: String = row.get("path");
        let clean = sanitize_project_path(&dir_path)?;
        dirs.insert(clean);
    }
    for dir in dirs {
        nodes.push(ProjectFileNode {
            path: dir,
            kind: "directory".to_string(),
        });
    }
    nodes.sort_by(|a, b| a.path.cmp(&b.path));
    nodes.dedup_by(|a, b| a.path == b.path && a.kind == b.kind);
    Ok(Json(ProjectTreeResponse {
        nodes,
        entry_file_path,
    }))
}

async fn create_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateProjectFileInput>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let path = sanitize_project_path(&input.path)?;
    let now = Utc::now();
    match input.kind.as_str() {
        "directory" => {
            sqlx::query(
                "insert into project_directories (project_id, path, created_at)
                 values ($1, $2, $3)
                 on conflict (project_id, path) do nothing",
            )
            .bind(project_id)
            .bind(&path)
            .bind(now)
            .execute(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        _ => {
            sqlx::query(
                "insert into documents (id, project_id, path, content, updated_at)
                 values ($1, $2, $3, $4, $5)
                 on conflict (project_id, path)
                 do update set content = excluded.content, updated_at = excluded.updated_at",
            )
            .bind(Uuid::new_v4())
            .bind(project_id)
            .bind(&path)
            .bind(input.content.unwrap_or_default())
            .bind(now)
            .execute(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            mark_project_dirty(&state.db, project_id, Some(actor)).await;
        }
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.file.create",
        serde_json::json!({ "project_id": project_id, "path": path, "kind": input.kind }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn move_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<MoveProjectFileInput>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let from_path = sanitize_project_path(&input.from_path)?;
    let to_path = sanitize_project_path(&input.to_path)?;
    let now = Utc::now();

    let dir_move = sqlx::query(
        "update project_directories
         set path = case
             when path = $2 then $3
             else $3 || substring(path from char_length($2) + 1)
         end
         where project_id = $1 and (path = $2 or path like ($2 || '/%'))",
    )
    .bind(project_id)
    .bind(&from_path)
    .bind(&to_path)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let doc_move = sqlx::query(
        "update documents
         set path = case
             when path = $2 then $3
             else $3 || substring(path from char_length($2) + 1)
         end,
         updated_at = $4
         where project_id = $1 and (path = $2 or path like ($2 || '/%'))",
    )
    .bind(project_id)
    .bind(&from_path)
    .bind(&to_path)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let asset_move = sqlx::query(
        "update project_assets
         set path = case
             when path = $2 then $3
             else $3 || substring(path from char_length($2) + 1)
         end
         where project_id = $1 and (path = $2 or path like ($2 || '/%'))",
    )
    .bind(project_id)
    .bind(&from_path)
    .bind(&to_path)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if dir_move.rows_affected() > 0
        || doc_move.rows_affected() > 0
        || asset_move.rows_affected() > 0
    {
        mark_project_dirty(&state.db, project_id, Some(actor)).await;
    }

    write_audit(
        &state.db,
        Some(actor),
        "project.file.move",
        serde_json::json!({ "project_id": project_id, "from_path": from_path, "to_path": to_path }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, path)): Path<(Uuid, String)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let clean_path = sanitize_project_path(&path)?;

    let _ = sqlx::query(
        "delete from project_directories
         where project_id = $1 and (path = $2 or path like ($2 || '/%'))",
    )
    .bind(project_id)
    .bind(&clean_path)
    .execute(&state.db)
    .await;

    let deleted_docs = sqlx::query(
        "delete from documents
         where project_id = $1 and (path = $2 or path like ($2 || '/%'))",
    )
    .bind(project_id)
    .bind(&clean_path)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let deleted_assets = sqlx::query(
        "delete from project_assets
         where project_id = $1 and (path = $2 or path like ($2 || '/%'))",
    )
    .bind(project_id)
    .bind(&clean_path)
    .execute(&state.db)
    .await;

    if deleted_docs.rows_affected() > 0
        || deleted_assets
            .ok()
            .map(|r| r.rows_affected() > 0)
            .unwrap_or(false)
    {
        mark_project_dirty(&state.db, project_id, Some(actor)).await;
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.file.delete",
        serde_json::json!({ "project_id": project_id, "path": clean_path }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_project_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectSettingsResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let row = sqlx::query(
        "insert into project_settings (project_id, entry_file_path, updated_at)
         values ($1, 'main.typ', $2)
         on conflict (project_id) do update set project_id = excluded.project_id
         returning project_id, entry_file_path, updated_at",
    )
    .bind(project_id)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(ProjectSettingsResponse {
        project_id: row.get("project_id"),
        entry_file_path: row.get("entry_file_path"),
        updated_at: row.get("updated_at"),
    }))
}

async fn upsert_project_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertProjectSettingsInput>,
) -> Result<Json<ProjectSettingsResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let entry_file_path = sanitize_project_path(&input.entry_file_path)?;
    let row = sqlx::query(
        "insert into project_settings (project_id, entry_file_path, updated_at)
         values ($1, $2, $3)
         on conflict (project_id) do update set entry_file_path = excluded.entry_file_path, updated_at = excluded.updated_at
         returning project_id, entry_file_path, updated_at",
    )
    .bind(project_id)
    .bind(&entry_file_path)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(ProjectSettingsResponse {
        project_id: row.get("project_id"),
        entry_file_path: row.get("entry_file_path"),
        updated_at: row.get("updated_at"),
    }))
}

fn normalized_org_permission(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "read" | "readonly" | "viewer" => Some("read"),
        "write" | "writable" | "edit" | "editor" => Some("write"),
        _ => None,
    }
}

fn role_from_org_permission(permission: &str) -> &'static str {
    if permission == "write" {
        "Student"
    } else {
        "Viewer"
    }
}

async fn list_project_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectOrganizationAccess>>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let rows = sqlx::query(
        "select poa.project_id, poa.organization_id, o.name as organization_name,
                poa.permission, poa.granted_by, poa.granted_at
         from project_organization_access poa
         join organizations o on o.id = poa.organization_id
         where poa.project_id = $1
         order by o.name asc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items = rows
        .into_iter()
        .map(|row| ProjectOrganizationAccess {
            project_id: row.get("project_id"),
            organization_id: row.get("organization_id"),
            organization_name: row.get("organization_name"),
            permission: row.get("permission"),
            granted_by: row.get("granted_by"),
            granted_at: row.get("granted_at"),
        })
        .collect();
    Ok(Json(items))
}

async fn upsert_project_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, org_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpsertProjectOrganizationAccessInput>,
) -> Result<Json<ProjectOrganizationAccess>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let permission = normalized_org_permission(&input.permission).ok_or(StatusCode::BAD_REQUEST)?;
    if !user_is_org_member(&state.db, actor, org_id).await? {
        return Err(StatusCode::FORBIDDEN);
    }
    let row = sqlx::query(
        "insert into project_organization_access
         (project_id, organization_id, permission, granted_by, granted_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, organization_id) do update
         set permission = excluded.permission, granted_by = excluded.granted_by, granted_at = excluded.granted_at
         returning project_id, organization_id, permission, granted_by, granted_at",
    )
    .bind(project_id)
    .bind(org_id)
    .bind(permission)
    .bind(actor)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let org_name_row = sqlx::query("select name from organizations where id = $1")
        .bind(org_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let organization_name = org_name_row
        .map(|r| r.get::<String, _>("name"))
        .unwrap_or_else(|| org_id.to_string());
    write_audit(
        &state.db,
        Some(actor),
        "project.organization_access.upsert",
        serde_json::json!({
            "project_id": project_id,
            "organization_id": org_id,
            "permission": permission
        }),
    )
    .await;
    Ok(Json(ProjectOrganizationAccess {
        project_id: row.get("project_id"),
        organization_id: row.get("organization_id"),
        organization_name,
        permission: row.get("permission"),
        granted_by: row.get("granted_by"),
        granted_at: row.get("granted_at"),
    }))
}

async fn delete_project_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, org_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let result = sqlx::query(
        "delete from project_organization_access where project_id = $1 and organization_id = $2",
    )
    .bind(project_id)
    .bind(org_id)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.organization_access.delete",
        serde_json::json!({ "project_id": project_id, "organization_id": org_id }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_project_access_users(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectAccessUserListResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let share_rows = sqlx::query(
        "select actor_user_id
         from audit_events
         where event_type = 'project.share_link.join'
           and payload->>'project_id' = $1
           and actor_user_id is not null",
    )
    .bind(project_id.to_string())
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let share_user_ids: HashSet<Uuid> = share_rows
        .into_iter()
        .filter_map(|row| row.get::<Option<Uuid>, _>("actor_user_id"))
        .collect();
    let direct_rows = sqlx::query(
        "select u.id as user_id, u.email, u.display_name, pr.role
         from project_roles pr
         join users u on u.id = pr.user_id
         where pr.project_id = $1",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let org_rows = sqlx::query(
        "select distinct u.id as user_id, u.email, u.display_name,
                poa.permission, o.name as organization_name
         from project_organization_access poa
         join organizations o on o.id = poa.organization_id
         join (
           select organization_id, user_id from organization_memberships
           union
           select organization_id, user_id from org_admins
         ) members on members.organization_id = poa.organization_id
         join users u on u.id = members.user_id
         where poa.project_id = $1",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut users: HashMap<Uuid, ProjectAccessUser> = HashMap::new();
    for row in direct_rows {
        let user_id: Uuid = row.get("user_id");
        let role: String = row.get("role");
        let access_type = access_type_from_role(&role).to_string();
        let source = if share_user_ids.contains(&user_id) {
            "share_link_invite".to_string()
        } else {
            "direct_role".to_string()
        };
        users
            .entry(user_id)
            .and_modify(|entry| {
                if role_rank(&role) > role_rank(&entry.role) {
                    entry.role = role.clone();
                    entry.access_type = access_type.clone();
                }
                if !entry.sources.contains(&source) {
                    entry.sources.push(source.clone());
                }
            })
            .or_insert_with(|| ProjectAccessUser {
                user_id,
                email: row.get("email"),
                display_name: row.get("display_name"),
                role,
                access_type,
                sources: vec![source],
            });
    }
    for row in org_rows {
        let user_id: Uuid = row.get("user_id");
        let permission: String = row.get("permission");
        let organization_name: String = row.get("organization_name");
        let role = role_from_org_permission(&permission).to_string();
        let access_type = access_type_from_role(&role).to_string();
        let source = format!("organization:{organization_name}");
        users
            .entry(user_id)
            .and_modify(|entry| {
                if role_rank(&role) > role_rank(&entry.role) {
                    entry.role = role.clone();
                    entry.access_type = access_type.clone();
                }
                if !entry.sources.contains(&source) {
                    entry.sources.push(source.clone());
                }
            })
            .or_insert_with(|| ProjectAccessUser {
                user_id,
                email: row.get("email"),
                display_name: row.get("display_name"),
                role,
                access_type,
                sources: vec![source],
            });
    }
    let mut output = users.into_values().collect::<Vec<_>>();
    for user in &mut output {
        user.sources.sort();
    }
    output.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });
    Ok(Json(ProjectAccessUserListResponse { users: output }))
}

async fn list_group_roles(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectGroupRoleBinding>>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select project_id, group_name, role, granted_at
         from project_group_roles
         where project_id = $1
         order by group_name asc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let roles = rows
        .into_iter()
        .map(|r| ProjectGroupRoleBinding {
            project_id: r.get("project_id"),
            group_name: r.get("group_name"),
            role: r.get("role"),
            granted_at: r.get("granted_at"),
        })
        .collect();
    Ok(Json(roles))
}

async fn upsert_group_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertProjectGroupRoleInput>,
) -> Result<Json<ProjectGroupRoleBinding>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    if ProjectRole::from_db(&input.role).is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let group_name = input.group_name.trim().to_string();
    if group_name.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let granted_at = Utc::now();
    let row = sqlx::query(
        "insert into project_group_roles (project_id, group_name, role, granted_at)
         values ($1, $2, $3, $4)
         on conflict (project_id, group_name) do update
         set role = excluded.role, granted_at = excluded.granted_at
         returning project_id, group_name, role, granted_at",
    )
    .bind(project_id)
    .bind(&group_name)
    .bind(&input.role)
    .bind(granted_at)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    write_audit(
        &state.db,
        Some(actor),
        "project.group_role.upsert",
        serde_json::json!({"project_id": project_id, "group_name": group_name, "role": input.role}),
    )
    .await;
    Ok(Json(ProjectGroupRoleBinding {
        project_id: row.get("project_id"),
        group_name: row.get("group_name"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    }))
}

async fn delete_group_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, group_name)): Path<(Uuid, String)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let result =
        sqlx::query("delete from project_group_roles where project_id = $1 and group_name = $2")
            .bind(project_id)
            .bind(group_name.clone())
            .execute(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.group_role.delete",
        serde_json::json!({"project_id": project_id, "group_name": group_name}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn ensure_org_admin(
    db: &PgPool,
    headers: &HeaderMap,
    org_id: Uuid,
) -> Result<Uuid, StatusCode> {
    let Some(actor) = request_user_id(db, headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let row = sqlx::query("select 1 from org_admins where organization_id = $1 and user_id = $2")
        .bind(org_id)
        .bind(actor)
        .fetch_optional(db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if row.is_none() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(actor)
}

async fn list_org_group_role_mappings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id): Path<Uuid>,
) -> Result<Json<Vec<OrgGroupRoleMapping>>, StatusCode> {
    ensure_org_admin(&state.db, &headers, org_id).await?;
    let rows = sqlx::query(
        "select organization_id, group_name, role, granted_at
         from org_oidc_group_role_mappings
         where organization_id = $1
         order by group_name asc",
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items = rows
        .into_iter()
        .map(|r| OrgGroupRoleMapping {
            organization_id: r.get("organization_id"),
            group_name: r.get("group_name"),
            role: r.get("role"),
            granted_at: r.get("granted_at"),
        })
        .collect();
    Ok(Json(items))
}

async fn upsert_org_group_role_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id): Path<Uuid>,
    Json(input): Json<UpsertOrgGroupRoleMappingInput>,
) -> Result<Json<OrgGroupRoleMapping>, StatusCode> {
    let actor = ensure_org_admin(&state.db, &headers, org_id).await?;
    if ProjectRole::from_db(&input.role).is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let group_name = input.group_name.trim().to_string();
    if group_name.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let row = sqlx::query(
        "insert into org_oidc_group_role_mappings (organization_id, group_name, role, granted_at)
         values ($1, $2, $3, $4)
         on conflict (organization_id, group_name) do update
         set role = excluded.role, granted_at = excluded.granted_at
         returning organization_id, group_name, role, granted_at",
    )
    .bind(org_id)
    .bind(&group_name)
    .bind(&input.role)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    write_audit(
        &state.db,
        Some(actor),
        "admin.org_group_role.upsert",
        serde_json::json!({"organization_id": org_id, "group_name": group_name, "role": input.role}),
    )
    .await;
    Ok(Json(OrgGroupRoleMapping {
        organization_id: row.get("organization_id"),
        group_name: row.get("group_name"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    }))
}

async fn delete_org_group_role_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id, group_name)): Path<(Uuid, String)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_org_admin(&state.db, &headers, org_id).await?;
    let result = sqlx::query(
        "delete from org_oidc_group_role_mappings where organization_id = $1 and group_name = $2",
    )
    .bind(org_id)
    .bind(group_name.clone())
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(actor),
        "admin.org_group_role.delete",
        serde_json::json!({"organization_id": org_id, "group_name": group_name}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_admin_auth_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminAuthSettingsResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let has_admin = sqlx::query("select 1 from org_admins where user_id = $1 limit 1")
        .bind(actor)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if has_admin.is_none() {
        return Err(StatusCode::FORBIDDEN);
    }
    let settings = load_auth_settings(&state.db, &state.oidc).await?;
    Ok(Json(AdminAuthSettingsResponse { settings }))
}

async fn upsert_admin_auth_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpsertAdminAuthSettingsInput>,
) -> Result<Json<AdminAuthSettingsResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let has_admin = sqlx::query("select 1 from org_admins where user_id = $1 limit 1")
        .bind(actor)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if has_admin.is_none() {
        return Err(StatusCode::FORBIDDEN);
    }

    let discovery_url = input
        .oidc_discovery_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    if input.allow_oidc {
        let Some(discovery_url) = discovery_url.clone() else {
            return Err(StatusCode::BAD_REQUEST);
        };
        let issuer = discovery_issuer(&discovery_url).map_err(|_| StatusCode::BAD_REQUEST)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(Policy::none())
            .build()
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let discovery = CoreProviderMetadata::discover_async(issuer, &client).await;
        if discovery.is_err() {
            return Err(StatusCode::BAD_GATEWAY);
        }
    }

    let groups_claim = input
        .oidc_groups_claim
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("groups")
        .to_string();
    let site_name = input
        .site_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("Typst Collaboration")
        .to_string();
    sqlx::query(
        "insert into auth_settings
         (id, allow_local_login, allow_local_registration, allow_oidc, site_name,
          oidc_issuer, oidc_client_id, oidc_client_secret, oidc_redirect_uri, oidc_groups_claim, updated_at)
         values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (id) do update
         set allow_local_login = excluded.allow_local_login,
             allow_local_registration = excluded.allow_local_registration,
             allow_oidc = excluded.allow_oidc,
             site_name = excluded.site_name,
             oidc_issuer = excluded.oidc_issuer,
             oidc_client_id = excluded.oidc_client_id,
             oidc_client_secret = excluded.oidc_client_secret,
             oidc_redirect_uri = excluded.oidc_redirect_uri,
             oidc_groups_claim = excluded.oidc_groups_claim,
             updated_at = excluded.updated_at",
    )
    .bind(input.allow_local_login)
    .bind(input.allow_local_registration)
    .bind(input.allow_oidc)
    .bind(site_name)
    .bind(discovery_url)
    .bind(input.oidc_client_id.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
    .bind(
        input
            .oidc_client_secret
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
    )
    .bind(input.oidc_redirect_uri.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
    .bind(groups_claim)
    .bind(Utc::now())
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "admin.auth_settings.upsert",
        serde_json::json!({
            "allow_local_login": input.allow_local_login,
            "allow_local_registration": input.allow_local_registration,
            "allow_oidc": input.allow_oidc,
            "site_name": input.site_name
        }),
    )
    .await;
    let settings = load_auth_settings(&state.db, &state.oidc).await?;
    Ok(Json(AdminAuthSettingsResponse { settings }))
}
