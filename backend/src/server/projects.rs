use super::*;

pub(super) fn project_thumbnail_path(
    data_dir: &std::path::Path,
    project_id: Uuid,
) -> std::path::PathBuf {
    data_dir
        .join("thumbnails")
        .join(format!("{project_id}.thumb"))
}

pub(super) async fn read_thumbnail_bytes_from_fs(
    state: &AppState,
    project_id: Uuid,
) -> Result<Option<Vec<u8>>, StatusCode> {
    let path = project_thumbnail_path(&state.data_dir, project_id);
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub(super) async fn write_thumbnail_bytes_to_fs(
    state: &AppState,
    project_id: Uuid,
    bytes: &[u8],
) -> Result<(), StatusCode> {
    let dir = state.data_dir.join("thumbnails");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let final_path = project_thumbnail_path(&state.data_dir, project_id);
    let tmp_path = dir.join(format!(".{project_id}.{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&tmp_path, bytes)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

pub(super) async fn upsert_thumbnail_metadata(
    db: &PgPool,
    project_id: Uuid,
    content_type: &str,
    actor: Uuid,
    now: DateTime<Utc>,
) -> Result<(), StatusCode> {
    sqlx::query(
        "insert into project_thumbnails (project_id, content_type, image_data, updated_by, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id) do update
         set content_type = excluded.content_type,
             image_data = excluded.image_data,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(content_type)
    .bind(Vec::<u8>::new())
    .bind(actor)
    .bind(now)
    .execute(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

pub(super) async fn list_projects(
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
                p.is_template,
                exists(select 1 from project_thumbnails pt where pt.project_id = p.id) as has_thumbnail,
                p.created_at,
                greatest(
                  p.created_at,
                  coalesce((select max(d.updated_at) from documents d where d.project_id = p.id), p.created_at),
                  coalesce((select gr.last_server_sync_at from git_repositories gr where gr.project_id = p.id), p.created_at),
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
                    p.is_template,
                    exists(select 1 from project_thumbnails pt where pt.project_id = p.id) as has_thumbnail,
                    p.created_at,
                    greatest(
                      p.created_at,
                      coalesce((select max(d.updated_at) from documents d where d.project_id = p.id), p.created_at),
                      coalesce((select gr.last_server_sync_at from git_repositories gr where gr.project_id = p.id), p.created_at),
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
    let template_rows = if org_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            "select p.id,
                    p.name,
                    p.owner_user_id,
                    coalesce(owner.display_name, 'Unknown') as owner_display_name,
                    p.is_template,
                    exists(select 1 from project_thumbnails pt where pt.project_id = p.id) as has_thumbnail,
                    p.created_at,
                    greatest(
                      p.created_at,
                      coalesce((select max(d.updated_at) from documents d where d.project_id = p.id), p.created_at),
                      coalesce((select gr.last_server_sync_at from git_repositories gr where gr.project_id = p.id), p.created_at),
                      coalesce((select max(a.created_at) from project_assets a where a.project_id = p.id), p.created_at)
                    ) as last_edited_at,
                    pua.archived_at as user_archived_at
             from projects p
             join project_template_organization_access ptoa on ptoa.project_id = p.id
             left join users owner on owner.id = p.owner_user_id
             left join project_user_archives pua on pua.project_id = p.id and pua.user_id = $2
             where ptoa.organization_id = any($1::uuid[])
               and p.is_template = true
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
                can_read: true,
                is_template: row.get("is_template"),
                has_thumbnail: row.get("has_thumbnail"),
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
            "ReadWrite".to_string()
        } else {
            "ReadOnly".to_string()
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
                can_read: true,
                is_template: row.get("is_template"),
                has_thumbnail: row.get("has_thumbnail"),
                created_at: row.get("created_at"),
                last_edited_at: row.get("last_edited_at"),
                archived: row
                    .get::<Option<DateTime<Utc>>, _>("user_archived_at")
                    .is_some(),
                archived_at: row.get("user_archived_at"),
            },
        );
    }
    for row in template_rows {
        let project_id: Uuid = row.get("id");
        if let Some(existing) = projects_by_id.get_mut(&project_id) {
            existing.is_template = row.get("is_template");
            existing.has_thumbnail = row.get("has_thumbnail");
            continue;
        }
        projects_by_id.insert(
            project_id,
            Project {
                id: project_id,
                name: row.get("name"),
                owner_user_id: row.get("owner_user_id"),
                owner_display_name: row.get("owner_display_name"),
                my_role: "ReadOnly".to_string(),
                can_read: false,
                is_template: row.get("is_template"),
                has_thumbnail: row.get("has_thumbnail"),
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

pub(super) async fn list_my_organizations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OrganizationMembershipListResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let rows = sqlx::query(
        "select o.id as organization_id, o.name as organization_name,
                om.role as membership_role,
                coalesce(om.joined_at, o.created_at) as joined_at
         from organizations o
         join organization_memberships om
           on om.organization_id = o.id and om.user_id = $1
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
            membership_role: row.get("membership_role"),
            joined_at: row.get("joined_at"),
        })
        .collect();
    Ok(Json(OrganizationMembershipListResponse { organizations }))
}

pub(super) async fn list_organizations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OrganizationListResponse>, StatusCode> {
    let Some(_actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let rows = sqlx::query("select id, name, created_at from organizations order by name asc")
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let organizations = rows
        .into_iter()
        .map(|row| Organization {
            id: row.get("id"),
            name: row.get("name"),
            created_at: row.get("created_at"),
        })
        .collect();
    Ok(Json(OrganizationListResponse { organizations }))
}

pub(super) async fn create_organization(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateOrganizationInput>,
) -> Result<Json<Organization>, StatusCode> {
    let actor = ensure_site_admin(&state.db, &headers).await?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let row = sqlx::query(
        "insert into organizations (id, name, created_at)
         values ($1, $2, $3)
         returning id, name, created_at",
    )
    .bind(Uuid::new_v4())
    .bind(name)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    write_audit(
        &state.db,
        Some(actor),
        "organization.create",
        serde_json::json!({"organization_id": row.get::<Uuid, _>("id"), "name": name}),
    )
    .await;
    Ok(Json(Organization {
        id: row.get("id"),
        name: row.get("name"),
        created_at: row.get("created_at"),
    }))
}

pub(super) async fn user_organization_ids(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<Uuid>, StatusCode> {
    let rows =
        sqlx::query("select organization_id from organization_memberships where user_id = $1")
            .bind(user_id)
            .fetch_all(db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(rows
        .into_iter()
        .map(|row| row.get::<Uuid, _>("organization_id"))
        .collect())
}

pub(super) async fn user_is_org_member(
    db: &PgPool,
    user_id: Uuid,
    org_id: Uuid,
) -> Result<bool, StatusCode> {
    let row = sqlx::query(
        "select 1 from organization_memberships where user_id = $1 and organization_id = $2 limit 1",
    )
    .bind(user_id)
    .bind(org_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(row.is_some())
}

pub(super) async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateProjectInput>,
) -> Result<Json<Project>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let id = Uuid::new_v4();
    let created_at = Utc::now();
    let row = sqlx::query(
        "insert into projects (id, owner_user_id, name, description, created_at)
         values ($1, $2, $3, $4, $5)
         returning id, name, created_at, owner_user_id",
    )
    .bind(id)
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
        can_read: true,
        is_template: false,
        has_thumbnail: false,
        created_at: row.get("created_at"),
        last_edited_at: row.get("created_at"),
        archived: false,
        archived_at: None,
    }))
}

pub(super) async fn update_project_name(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectNameInput>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let next_name = input.name.trim();
    if next_name.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let result = sqlx::query("update projects set name = $2 where id = $1")
        .bind(project_id)
        .bind(next_name)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.rename",
        serde_json::json!({
            "project_id": project_id,
            "name": next_name
        }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn has_template_organization_access(
    db: &PgPool,
    actor: Uuid,
    project_id: Uuid,
) -> Result<bool, StatusCode> {
    let row = sqlx::query(
        "select 1
         from projects p
         join project_template_organization_access ptoa on ptoa.project_id = p.id
         join (
           select organization_id from organization_memberships where user_id = $1
         ) my_orgs on my_orgs.organization_id = ptoa.organization_id
         where p.id = $2
           and p.is_template = true
         limit 1",
    )
    .bind(actor)
    .bind(project_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(row.is_some())
}

pub(super) async fn can_copy_project_for_user(
    db: &PgPool,
    actor: Uuid,
    project_id: Uuid,
) -> Result<bool, StatusCode> {
    if ensure_project_role_for_user(db, actor, project_id, AccessNeed::Read)
        .await
        .is_ok()
    {
        return Ok(true);
    }
    has_template_organization_access(db, actor, project_id).await
}

pub(super) async fn copy_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateProjectCopyInput>,
) -> Result<Json<Project>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !can_copy_project_for_user(&state.db, actor, project_id).await? {
        return Err(StatusCode::FORBIDDEN);
    }
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let source_docs =
        sqlx::query("select path, content from documents where project_id = $1 order by path asc")
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let source_dirs =
        sqlx::query("select path from project_directories where project_id = $1 order by path asc")
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let source_assets = sqlx::query(
        "select path, object_key, content_type, size_bytes, inline_data
         from project_assets
         where project_id = $1
         order by path asc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let source_entry_file =
        sqlx::query("select entry_file_path from project_settings where project_id = $1")
            .bind(project_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map(|row| row.get::<String, _>("entry_file_path"))
            .unwrap_or_else(|| "main.typ".to_string());
    let source_thumbnail_row = sqlx::query(
        "select content_type, image_data from project_thumbnails where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let source_thumbnail_data = if let Some(row) = source_thumbnail_row {
        let content_type: String = row.get("content_type");
        let fs_bytes = read_thumbnail_bytes_from_fs(&state, project_id).await?;
        let bytes = if let Some(bytes) = fs_bytes {
            bytes
        } else {
            let legacy_bytes: Vec<u8> = row.get("image_data");
            if legacy_bytes.is_empty() {
                Vec::new()
            } else {
                let _ = write_thumbnail_bytes_to_fs(&state, project_id, &legacy_bytes).await;
                legacy_bytes
            }
        };
        if bytes.is_empty() {
            None
        } else {
            Some((content_type, bytes))
        }
    } else {
        None
    };

    let now = Utc::now();
    let new_project_id = Uuid::new_v4();

    struct CopiedAsset {
        id: Uuid,
        path: String,
        object_key: String,
        content_type: String,
        size_bytes: i64,
        inline_data: Option<Vec<u8>>,
    }
    let mut copied_assets: Vec<CopiedAsset> = Vec::new();
    for row in source_assets {
        let source_path: String = row.get("path");
        let content_type: String = row.get("content_type");
        let size_bytes: i64 = row.get("size_bytes");
        let bytes = if let Some(inline) = row.get::<Option<Vec<u8>>, _>("inline_data") {
            inline
        } else {
            let source_object_key: String = row.get("object_key");
            let Some(storage) = state.storage.clone() else {
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            };
            get_object(&storage, &source_object_key)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        };
        let new_asset_id = Uuid::new_v4();
        let (object_key, inline_data) = if let Some(storage) = state.storage.clone() {
            let key = format!("projects/{new_project_id}/assets/{new_asset_id}");
            put_object(&storage, &key, &content_type, bytes.clone())
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            (key, None)
        } else {
            (format!("inline://{new_asset_id}"), Some(bytes))
        };
        copied_assets.push(CopiedAsset {
            id: new_asset_id,
            path: source_path,
            object_key,
            content_type,
            size_bytes,
            inline_data,
        });
    }

    let owner_display_name = sqlx::query("select display_name from users where id = $1")
        .bind(actor)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(|r| r.get::<String, _>("display_name"))
        .unwrap_or_else(|| "Unknown".to_string());

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query(
        "insert into projects (id, owner_user_id, name, description, created_at, is_template)
         values ($1, $2, $3, $4, $5, false)",
    )
    .bind(new_project_id)
    .bind(actor)
    .bind(&name)
    .bind(Option::<String>::None)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query(
        "insert into project_roles (project_id, user_id, role, granted_at)
         values ($1, $2, 'Owner', $3)",
    )
    .bind(new_project_id)
    .bind(actor)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query(
        "insert into git_sync_states (project_id, branch, has_conflicts, status)
         values ($1, 'main', false, 'clean')
         on conflict (project_id) do nothing",
    )
    .bind(new_project_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query(
        "insert into project_settings (project_id, entry_file_path, updated_at)
         values ($1, $2, $3)",
    )
    .bind(new_project_id)
    .bind(&source_entry_file)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    for row in source_dirs {
        let dir_path: String = row.get("path");
        sqlx::query(
            "insert into project_directories (project_id, path, created_at)
             values ($1, $2, $3)
             on conflict (project_id, path) do nothing",
        )
        .bind(new_project_id)
        .bind(dir_path)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    for row in source_docs {
        let doc_path: String = row.get("path");
        let content: String = row.get("content");
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, $3, $4, $5)",
        )
        .bind(Uuid::new_v4())
        .bind(new_project_id)
        .bind(doc_path)
        .bind(content)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    for asset in copied_assets {
        sqlx::query(
            "insert into project_assets
             (id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at, inline_data)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(asset.id)
        .bind(new_project_id)
        .bind(asset.path)
        .bind(asset.object_key)
        .bind(asset.content_type)
        .bind(asset.size_bytes)
        .bind(actor)
        .bind(now)
        .bind(asset.inline_data)
        .execute(&mut *tx)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    tx.commit()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut copied_has_thumbnail = false;
    if let Some((content_type, image_data)) = source_thumbnail_data {
        if write_thumbnail_bytes_to_fs(&state, new_project_id, &image_data)
            .await
            .is_ok()
            && upsert_thumbnail_metadata(&state.db, new_project_id, &content_type, actor, now)
                .await
                .is_ok()
        {
            copied_has_thumbnail = true;
        }
    }

    write_audit(
        &state.db,
        Some(actor),
        "project.copy",
        serde_json::json!({
            "source_project_id": project_id,
            "project_id": new_project_id,
            "name": name
        }),
    )
    .await;

    Ok(Json(Project {
        id: new_project_id,
        name,
        owner_user_id: Some(actor),
        owner_display_name,
        my_role: "Owner".to_string(),
        can_read: true,
        is_template: false,
        has_thumbnail: copied_has_thumbnail,
        created_at: now,
        last_edited_at: now,
        archived: false,
        archived_at: None,
    }))
}

pub(super) async fn update_project_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectTemplateInput>,
) -> Result<Json<ProjectTemplateResponse>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let now = Utc::now();
    let row = sqlx::query(
        "update projects
         set is_template = $2
         where id = $1
         returning id, is_template",
    )
    .bind(project_id)
    .bind(input.is_template)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let is_template: bool = row.get("is_template");
    if !is_template {
        let _ =
            sqlx::query("delete from project_template_organization_access where project_id = $1")
                .bind(project_id)
                .execute(&state.db)
                .await;
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.template.update",
        serde_json::json!({ "project_id": project_id, "is_template": is_template }),
    )
    .await;
    Ok(Json(ProjectTemplateResponse {
        project_id,
        is_template,
        updated_at: now,
    }))
}

pub(super) async fn list_project_template_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectTemplateOrganizationAccess>>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let rows = sqlx::query(
        "select ptoa.project_id, ptoa.organization_id, o.name as organization_name,
                ptoa.granted_by, ptoa.granted_at
         from project_template_organization_access ptoa
         join organizations o on o.id = ptoa.organization_id
         where ptoa.project_id = $1
         order by o.name asc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items = rows
        .into_iter()
        .map(|row| ProjectTemplateOrganizationAccess {
            project_id: row.get("project_id"),
            organization_id: row.get("organization_id"),
            organization_name: row.get("organization_name"),
            granted_by: row.get("granted_by"),
            granted_at: row.get("granted_at"),
        })
        .collect();
    Ok(Json(items))
}

pub(super) async fn upsert_project_template_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, org_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<ProjectTemplateOrganizationAccess>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let is_template_row = sqlx::query("select is_template from projects where id = $1")
        .bind(project_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(is_template_row) = is_template_row else {
        return Err(StatusCode::NOT_FOUND);
    };
    if !is_template_row.get::<bool, _>("is_template") {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !user_is_org_member(&state.db, actor, org_id).await? {
        return Err(StatusCode::FORBIDDEN);
    }
    let row = sqlx::query(
        "insert into project_template_organization_access
         (project_id, organization_id, granted_by, granted_at)
         values ($1, $2, $3, $4)
         on conflict (project_id, organization_id) do update
         set granted_by = excluded.granted_by, granted_at = excluded.granted_at
         returning project_id, organization_id, granted_by, granted_at",
    )
    .bind(project_id)
    .bind(org_id)
    .bind(actor)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let org_name = sqlx::query("select name from organizations where id = $1")
        .bind(org_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(|r| r.get::<String, _>("name"))
        .unwrap_or_else(|| org_id.to_string());
    write_audit(
        &state.db,
        Some(actor),
        "project.template.organization_access.upsert",
        serde_json::json!({ "project_id": project_id, "organization_id": org_id }),
    )
    .await;
    Ok(Json(ProjectTemplateOrganizationAccess {
        project_id: row.get("project_id"),
        organization_id: row.get("organization_id"),
        organization_name: org_name,
        granted_by: row.get("granted_by"),
        granted_at: row.get("granted_at"),
    }))
}

pub(super) async fn delete_project_template_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, org_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let result = sqlx::query(
        "delete from project_template_organization_access where project_id = $1 and organization_id = $2",
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
        "project.template.organization_access.delete",
        serde_json::json!({ "project_id": project_id, "organization_id": org_id }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn upload_project_thumbnail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UploadProjectThumbnailInput>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        input.content_base64,
    )
    .map_err(|_| StatusCode::BAD_REQUEST)?;
    if bytes.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let content_type = input
        .content_type
        .unwrap_or_else(|| "image/png".to_string())
        .trim()
        .to_string();
    if !content_type.starts_with("image/") {
        return Err(StatusCode::BAD_REQUEST);
    }
    let now = Utc::now();
    write_thumbnail_bytes_to_fs(&state, project_id, &bytes).await?;
    upsert_thumbnail_metadata(&state.db, project_id, &content_type, actor, now).await?;
    write_audit(
        &state.db,
        Some(actor),
        "project.thumbnail.upload",
        serde_json::json!({ "project_id": project_id }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn get_project_thumbnail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let mut readable = ensure_project_role_for_user(&state.db, actor, project_id, AccessNeed::Read)
        .await
        .is_ok();
    if !readable {
        readable = has_template_organization_access(&state.db, actor, project_id).await?;
    }
    if !readable {
        return Err(StatusCode::FORBIDDEN);
    }
    let row = sqlx::query(
        "select content_type, image_data
         from project_thumbnails
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let content_type: String = row.get("content_type");
    let fs_data = read_thumbnail_bytes_from_fs(&state, project_id).await?;
    let image_data = if let Some(bytes) = fs_data {
        bytes
    } else {
        let legacy_bytes: Vec<u8> = row.get("image_data");
        if legacy_bytes.is_empty() {
            let _ = sqlx::query("delete from project_thumbnails where project_id = $1")
                .bind(project_id)
                .execute(&state.db)
                .await;
            return Err(StatusCode::NOT_FOUND);
        }
        write_thumbnail_bytes_to_fs(&state, project_id, &legacy_bytes).await?;
        let _ = sqlx::query("update project_thumbnails set image_data = $2 where project_id = $1")
            .bind(project_id)
            .bind(Vec::<u8>::new())
            .execute(&state.db)
            .await;
        legacy_bytes
    };
    let mut resp = axum::http::Response::new(Body::from(image_data));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, max-age=60"),
    );
    Ok(resp)
}

pub(super) fn normalized_share_permission(raw: &str) -> Option<&'static str> {
    let lowered = raw.trim().to_ascii_lowercase();
    match lowered.as_str() {
        "read" | "readonly" | "viewer" => Some("read"),
        "write" | "writable" | "edit" | "editor" => Some("write"),
        _ => None,
    }
}

pub(super) fn grant_role_from_share_permission(permission: &str) -> &'static str {
    if permission == "write" {
        "ReadWrite"
    } else {
        "ReadOnly"
    }
}

pub(super) async fn list_project_share_links(
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

pub(super) async fn create_project_share_link(
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

pub(super) async fn revoke_project_share_link(
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

pub(super) async fn join_project_share_link(
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

pub(super) async fn resolve_project_share_link(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<ResolveProjectShareLinkResponse>, StatusCode> {
    let token = token.trim();
    if token.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let row = sqlx::query(
        "select l.project_id, l.permission, p.name as project_name
         from project_share_links l
         join projects p on p.id = l.project_id
         where (l.token_value = $1 or l.token_hash = $2)
           and l.revoked_at is null
           and (l.expires_at is null or l.expires_at > now())",
    )
    .bind(token)
    .bind(token_sha256(token))
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let settings = load_auth_settings(&state.db, &state.oidc).await?;
    Ok(Json(ResolveProjectShareLinkResponse {
        project_id: row.get("project_id"),
        project_name: row.get("project_name"),
        permission: row.get("permission"),
        anonymous_mode: settings.anonymous_mode,
    }))
}

pub(super) async fn create_temporary_share_login(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(input): Json<TemporaryShareLoginInput>,
) -> Result<Json<TemporaryShareLoginResponse>, StatusCode> {
    let token = token.trim();
    if token.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let display_name = input.display_name.trim();
    if display_name.is_empty() || display_name.len() > 64 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let settings = load_auth_settings(&state.db, &state.oidc).await?;
    if settings.anonymous_mode.trim().to_ascii_lowercase() != "read_write_named" {
        return Err(StatusCode::FORBIDDEN);
    }
    let row = sqlx::query(
        "select id, project_id, permission
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
    let permission: String = row.get("permission");
    if permission != "write" {
        return Err(StatusCode::FORBIDDEN);
    }
    let session_token = format!("gsh_{}", random_token(44));
    let session_id = Uuid::new_v4();
    let now = Utc::now();
    let expires_at = now + chrono::Duration::days(30);
    sqlx::query(
        "insert into anonymous_share_sessions
         (id, project_id, share_link_id, session_token_hash, display_name, permission, created_at, expires_at, last_used_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $7)",
    )
    .bind(session_id)
    .bind(row.get::<Uuid, _>("project_id"))
    .bind(row.get::<Uuid, _>("id"))
    .bind(token_sha256(&session_token))
    .bind(display_name)
    .bind("write")
    .bind(now)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(TemporaryShareLoginResponse {
        project_id: row.get("project_id"),
        session_token,
        session_id,
        display_name: display_name.to_string(),
        permission,
    }))
}

pub(super) async fn list_roles(
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

pub(super) async fn upsert_role(
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

pub(super) async fn get_project_tree(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectTreeResponse>, StatusCode> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    normalize_project_file_classification(&state, project_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
        if !is_document_text_path(&clean) {
            continue;
        }
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

pub(super) async fn create_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateProjectFileInput>,
) -> Result<StatusCode, StatusCode> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let actor = principal.user_id;
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
            if let Some(user_id) = actor {
                mark_project_dirty(&state.db, project_id, Some(user_id)).await;
            } else if let Some(display_name) = principal.guest_display_name.as_deref() {
                mark_project_dirty_guest(&state.db, project_id, display_name).await;
            } else {
                mark_project_dirty(&state.db, project_id, None).await;
            }
        }
        _ => {
            if is_document_text_path(&path) {
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
            } else {
                let asset_id = Uuid::new_v4();
                let object_key = format!("projects/{project_id}/assets/{asset_id}");
                let empty_bytes: Vec<u8> = Vec::new();
                let content_type = guess_content_type(&path);
                let (stored_object_key, inline_data) = if let Some(storage) = state.storage.clone()
                {
                    put_object(&storage, &object_key, &content_type, empty_bytes.clone())
                        .await
                        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                    (object_key, None)
                } else {
                    (format!("inline://{asset_id}"), Some(empty_bytes))
                };
                sqlx::query(
                    "insert into project_assets
                     (id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at, inline_data)
                     values ($1, $2, $3, $4, $5, 0, $6, $7, $8)
                     on conflict (project_id, path)
                     do update set
                       object_key = excluded.object_key,
                       content_type = excluded.content_type,
                       size_bytes = excluded.size_bytes,
                       uploaded_by = excluded.uploaded_by,
                       created_at = excluded.created_at,
                       inline_data = excluded.inline_data",
                )
                .bind(asset_id)
                .bind(project_id)
                .bind(&path)
                .bind(stored_object_key)
                .bind(content_type)
                .bind(actor)
                .bind(now)
                .bind(inline_data)
                .execute(&state.db)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                let _ = sqlx::query("delete from documents where project_id = $1 and path = $2")
                    .bind(project_id)
                    .bind(&path)
                    .execute(&state.db)
                    .await;
            }
            if let Some(user_id) = actor {
                mark_project_dirty(&state.db, project_id, Some(user_id)).await;
            } else if let Some(display_name) = principal.guest_display_name.as_deref() {
                mark_project_dirty_guest(&state.db, project_id, display_name).await;
            } else {
                mark_project_dirty(&state.db, project_id, None).await;
            }
        }
    }
    write_audit(
        &state.db,
        actor,
        "project.file.create",
        serde_json::json!({ "project_id": project_id, "path": path, "kind": input.kind }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn move_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<MoveProjectFileInput>,
) -> Result<StatusCode, StatusCode> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let actor = principal.user_id;
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
        if let Some(user_id) = actor {
            mark_project_dirty(&state.db, project_id, Some(user_id)).await;
        } else if let Some(display_name) = principal.guest_display_name.as_deref() {
            mark_project_dirty_guest(&state.db, project_id, display_name).await;
        } else {
            mark_project_dirty(&state.db, project_id, None).await;
        }
    }

    write_audit(
        &state.db,
        actor,
        "project.file.move",
        serde_json::json!({ "project_id": project_id, "from_path": from_path, "to_path": to_path }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn delete_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, path)): Path<(Uuid, String)>,
) -> Result<StatusCode, StatusCode> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let actor = principal.user_id;
    let clean_path = sanitize_project_path(&path)?;

    let deleted_dirs = sqlx::query(
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

    if deleted_dirs
        .as_ref()
        .ok()
        .map(|r| r.rows_affected() > 0)
        .unwrap_or(false)
        || deleted_docs.rows_affected() > 0
        || deleted_assets
            .ok()
            .map(|r| r.rows_affected() > 0)
            .unwrap_or(false)
    {
        if let Some(user_id) = actor {
            mark_project_dirty(&state.db, project_id, Some(user_id)).await;
        } else if let Some(display_name) = principal.guest_display_name.as_deref() {
            mark_project_dirty_guest(&state.db, project_id, display_name).await;
        } else {
            mark_project_dirty(&state.db, project_id, None).await;
        }
    }
    write_audit(
        &state.db,
        actor,
        "project.file.delete",
        serde_json::json!({ "project_id": project_id, "path": clean_path }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn get_project_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectSettingsResponse>, StatusCode> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
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

pub(super) async fn upsert_project_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertProjectSettingsInput>,
) -> Result<Json<ProjectSettingsResponse>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
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
    mark_project_dirty(&state.db, project_id, Some(actor)).await;
    Ok(Json(ProjectSettingsResponse {
        project_id: row.get("project_id"),
        entry_file_path: row.get("entry_file_path"),
        updated_at: row.get("updated_at"),
    }))
}

pub(super) fn normalized_org_permission(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "read" | "readonly" | "viewer" => Some("read"),
        "write" | "writable" | "edit" | "editor" => Some("write"),
        _ => None,
    }
}

pub(super) async fn list_project_organization_access(
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

pub(super) async fn upsert_project_organization_access(
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

pub(super) async fn delete_project_organization_access(
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

pub(super) async fn list_project_access_users(
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
         join organization_memberships members on members.organization_id = poa.organization_id
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
        let source = if share_user_ids.contains(&user_id) {
            "share_link_invite".to_string()
        } else {
            "direct_role".to_string()
        };
        merge_project_access_user(
            &mut users,
            user_id,
            row.get("email"),
            row.get("display_name"),
            role,
            source,
        );
    }
    for row in org_rows {
        let user_id: Uuid = row.get("user_id");
        let permission: String = row.get("permission");
        let organization_name: String = row.get("organization_name");
        let role = role_from_org_permission(&permission).to_string();
        let source = format!("organization:{organization_name}");
        merge_project_access_user(
            &mut users,
            user_id,
            row.get("email"),
            row.get("display_name"),
            role,
            source,
        );
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

pub(super) async fn list_group_roles(
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

pub(super) async fn upsert_group_role(
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

pub(super) async fn delete_group_role(
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

pub(super) async fn ensure_site_admin(
    db: &PgPool,
    headers: &HeaderMap,
) -> Result<Uuid, StatusCode> {
    let Some(actor) = request_user_id(db, headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !is_site_admin(db, actor).await? {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(actor)
}

pub(super) async fn list_org_group_role_mappings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id): Path<Uuid>,
) -> Result<Json<Vec<OrgGroupRoleMapping>>, StatusCode> {
    ensure_site_admin(&state.db, &headers).await?;
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

pub(super) async fn upsert_org_group_role_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id): Path<Uuid>,
    Json(input): Json<UpsertOrgGroupRoleMappingInput>,
) -> Result<Json<OrgGroupRoleMapping>, StatusCode> {
    let actor = ensure_site_admin(&state.db, &headers).await?;
    let role = input.role.trim().to_ascii_lowercase();
    if role != "owner" && role != "member" {
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
    .bind(&role)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    write_audit(
        &state.db,
        Some(actor),
        "admin.org_group_role.upsert",
        serde_json::json!({"organization_id": org_id, "group_name": group_name, "role": role}),
    )
    .await;
    Ok(Json(OrgGroupRoleMapping {
        organization_id: row.get("organization_id"),
        group_name: row.get("group_name"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    }))
}

pub(super) async fn delete_org_group_role_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id, group_name)): Path<(Uuid, String)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_site_admin(&state.db, &headers).await?;
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

pub(super) async fn get_admin_auth_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminAuthSettingsResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !is_site_admin(&state.db, actor).await? {
        return Err(StatusCode::FORBIDDEN);
    }
    let settings = load_auth_settings(&state.db, &state.oidc).await?;
    Ok(Json(AdminAuthSettingsResponse { settings }))
}

pub(super) async fn upsert_admin_auth_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpsertAdminAuthSettingsInput>,
) -> Result<Json<AdminAuthSettingsResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !is_site_admin(&state.db, actor).await? {
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
    let anonymous_mode = input
        .anonymous_mode
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("off")
        .to_ascii_lowercase();
    if !matches!(
        anonymous_mode.as_str(),
        "off" | "read_only" | "read_write_named"
    ) {
        return Err(StatusCode::BAD_REQUEST);
    }
    sqlx::query(
        "insert into auth_settings
         (id, allow_local_login, allow_local_registration, allow_oidc, anonymous_mode, site_name,
          oidc_issuer, oidc_client_id, oidc_client_secret, oidc_redirect_uri, oidc_groups_claim, updated_at)
         values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (id) do update
         set allow_local_login = excluded.allow_local_login,
             allow_local_registration = excluded.allow_local_registration,
             allow_oidc = excluded.allow_oidc,
             anonymous_mode = excluded.anonymous_mode,
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
    .bind(anonymous_mode)
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
            "anonymous_mode": input.anonymous_mode,
            "site_name": input.site_name
        }),
    )
    .await;
    let settings = load_auth_settings(&state.db, &state.oidc).await?;
    Ok(Json(AdminAuthSettingsResponse { settings }))
}
