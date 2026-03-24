async fn list_revisions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RevisionsResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select id, project_id, actor_user_id, summary, created_at
         from revisions where project_id = $1 and is_complete = true order by created_at desc limit 200",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let revision_ids = rows
        .iter()
        .map(|r| r.get::<Uuid, _>("id"))
        .collect::<Vec<_>>();
    let author_map = load_revision_authors(&state.db, &revision_ids)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let revisions = rows
        .into_iter()
        .map(|r| {
            let id: Uuid = r.get("id");
            Revision {
                id,
                project_id: r.get("project_id"),
                actor_user_id: r.get("actor_user_id"),
                summary: r.get("summary"),
                created_at: r.get("created_at"),
                authors: author_map.get(&id).cloned().unwrap_or_default(),
            }
        })
        .collect();

    Ok(Json(RevisionsResponse { revisions }))
}

async fn create_revision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateRevisionInput>,
) -> Result<Json<Revision>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let summary = input.summary.trim().to_string();
    if summary.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let now = Utc::now();
    let row = create_project_revision(&state.db, project_id, Some(actor), &summary, now)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = sqlx::query(
        "insert into revision_authors (revision_id, user_id)
         values ($1, $2)
         on conflict (revision_id, user_id) do nothing",
    )
    .bind(row.id)
    .bind(actor)
    .execute(&state.db)
    .await;

    write_audit(
        &state.db,
        Some(actor),
        "revision.create",
        serde_json::json!({"project_id": project_id, "revision_id": row.id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Revision {
        id: row.id,
        project_id: row.project_id,
        actor_user_id: row.actor_user_id,
        summary: row.summary,
        created_at: row.created_at,
        authors: vec![RevisionAuthor {
            user_id: actor,
            display_name: lookup_user_display_name(&state.db, actor)
                .await
                .unwrap_or_else(|| "Unknown".to_string()),
            email: lookup_user_email(&state.db, actor)
                .await
                .unwrap_or_else(|| "unknown@example.com".to_string()),
        }],
    }))
}

#[derive(Clone)]
enum RevisionAnchorKind {
    None,
    Live,
    Revision(Uuid),
}

#[derive(Clone)]
struct RevisionTransferCandidate {
    transfer_mode: &'static str,
    anchor_kind: RevisionAnchorKind,
    document_upserts: HashMap<String, String>,
    deleted_documents: Vec<String>,
    asset_upserts: HashMap<String, RevisionStoredAsset>,
    deleted_assets: Vec<String>,
    estimated_bytes: usize,
}

fn estimate_asset_b64_bytes(size_bytes: i64) -> usize {
    let size = usize::try_from(size_bytes.max(0)).unwrap_or(0);
    ((size + 2) / 3) * 4
}

fn build_transfer_candidate(
    target: &RevisionStateData,
    baseline: Option<&RevisionStateData>,
    anchor_kind: RevisionAnchorKind,
) -> RevisionTransferCandidate {
    let mut document_upserts: HashMap<String, String> = HashMap::new();
    let mut deleted_documents: Vec<String> = Vec::new();
    let mut asset_upserts: HashMap<String, RevisionStoredAsset> = HashMap::new();
    let mut deleted_assets: Vec<String> = Vec::new();
    let mut estimated_bytes = 0usize;

    if let Some(base) = baseline {
        for (path, content) in target.documents.iter() {
            let needs_upsert = base
                .documents
                .get(path)
                .map(|previous| previous != content)
                .unwrap_or(true);
            if needs_upsert {
                estimated_bytes = estimated_bytes
                    .saturating_add(path.len())
                    .saturating_add(content.len())
                    .saturating_add(24);
                document_upserts.insert(path.clone(), content.clone());
            }
        }
        for path in base.documents.keys() {
            if target.documents.contains_key(path) {
                continue;
            }
            estimated_bytes = estimated_bytes.saturating_add(path.len()).saturating_add(12);
            deleted_documents.push(path.clone());
        }

        for (path, target_asset) in target.assets.iter() {
            let needs_upsert = base
                .assets
                .get(path)
                .map(|previous| !same_asset(previous, target_asset))
                .unwrap_or(true);
            if needs_upsert {
                estimated_bytes = estimated_bytes
                    .saturating_add(path.len())
                    .saturating_add(target_asset.content_type.len())
                    .saturating_add(estimate_asset_b64_bytes(target_asset.size_bytes))
                    .saturating_add(32);
                asset_upserts.insert(path.clone(), target_asset.clone());
            }
        }
        for path in base.assets.keys() {
            if target.assets.contains_key(path) {
                continue;
            }
            estimated_bytes = estimated_bytes.saturating_add(path.len()).saturating_add(12);
            deleted_assets.push(path.clone());
        }
    } else {
        for (path, content) in target.documents.iter() {
            estimated_bytes = estimated_bytes
                .saturating_add(path.len())
                .saturating_add(content.len())
                .saturating_add(24);
            document_upserts.insert(path.clone(), content.clone());
        }
        for (path, target_asset) in target.assets.iter() {
            estimated_bytes = estimated_bytes
                .saturating_add(path.len())
                .saturating_add(target_asset.content_type.len())
                .saturating_add(estimate_asset_b64_bytes(target_asset.size_bytes))
                .saturating_add(32);
            asset_upserts.insert(path.clone(), target_asset.clone());
        }
    }

    RevisionTransferCandidate {
        transfer_mode: if baseline.is_some() { "delta" } else { "full" },
        anchor_kind,
        document_upserts,
        deleted_documents,
        asset_upserts,
        deleted_assets,
        estimated_bytes,
    }
}

async fn stored_asset_bytes(
    state: &AppState,
    asset: &RevisionStoredAsset,
) -> Result<Vec<u8>, StatusCode> {
    if let Some(inline) = asset.inline_data.clone() {
        return Ok(inline);
    }
    let Some(storage) = state.storage.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    get_object(&storage, &asset.object_key)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn build_nodes_from_state(state: &RevisionStateData) -> Result<Vec<ProjectFileNode>, StatusCode> {
    let mut dirs: HashSet<String> = HashSet::new();
    let mut nodes: Vec<ProjectFileNode> = Vec::new();

    for (path, _) in state.documents.iter() {
        let clean = sanitize_project_path(path)?;
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

    for dir in state.directories.iter() {
        let clean = sanitize_project_path(dir)?;
        dirs.insert(clean);
    }

    for (path, _) in state.assets.iter() {
        let clean = sanitize_project_path(path)?;
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

    for dir in dirs {
        nodes.push(ProjectFileNode {
            path: dir,
            kind: "directory".to_string(),
        });
    }
    nodes.sort_by(|a, b| a.path.cmp(&b.path));
    nodes.dedup_by(|a, b| a.path == b.path && a.kind == b.kind);
    Ok(nodes)
}

async fn get_revision_documents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RevisionDocumentsQuery>,
    Path((project_id, revision_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<RevisionDocumentsResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let revision_row = sqlx::query(
        "select entry_file_path
         from revisions
         where id = $1 and project_id = $2 and is_complete = true",
    )
        .bind(revision_id)
        .bind(project_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if revision_row.is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    let entry_file_path = revision_row
        .and_then(|row| row.get::<Option<String>, _>("entry_file_path"))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "main.typ".to_string());

    let state_data = load_materialized_revision_state(&state.db, project_id, revision_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(target_state) = state_data else {
        return Err(StatusCode::NOT_FOUND);
    };
    let nodes = build_nodes_from_state(&target_state)?;

    let mut candidates = vec![build_transfer_candidate(
        &target_state,
        None,
        RevisionAnchorKind::None,
    )];

    if let Some(base_revision_id) = query.current_revision_id {
        if base_revision_id != revision_id {
            if let Some(base_revision_state) =
                load_materialized_revision_state(&state.db, project_id, base_revision_id)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            {
                candidates.push(build_transfer_candidate(
                    &target_state,
                    Some(&base_revision_state),
                    RevisionAnchorKind::Revision(base_revision_id),
                ));
            }
        }
    }

    if query.include_live_anchor.unwrap_or(false) {
        let live_state = load_project_state(&state.db, project_id)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        candidates.push(build_transfer_candidate(
            &target_state,
            Some(&live_state),
            RevisionAnchorKind::Live,
        ));
    }

    let selected = candidates
        .into_iter()
        .min_by_key(|item| {
            (
                item.estimated_bytes,
                if item.transfer_mode == "full" { 1usize } else { 0usize },
            )
        })
        .unwrap_or_else(|| {
            build_transfer_candidate(&target_state, None, RevisionAnchorKind::None)
        });

    let RevisionTransferCandidate {
        transfer_mode,
        anchor_kind,
        document_upserts,
        deleted_documents: raw_deleted_documents,
        asset_upserts,
        deleted_assets: raw_deleted_assets,
        ..
    } = selected;

    let mut document_pairs = document_upserts.into_iter().collect::<Vec<_>>();
    document_pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let documents: Vec<RevisionDocument> = document_pairs
        .into_iter()
        .map(|(path, content)| {
            let clean = sanitize_project_path(&path)?;
            Ok(RevisionDocument {
                path: clean,
                content,
            })
        })
        .collect::<Result<Vec<_>, StatusCode>>()?;

    let mut deleted_documents = raw_deleted_documents
        .into_iter()
        .map(|path| sanitize_project_path(&path))
        .collect::<Result<Vec<_>, StatusCode>>()?;
    deleted_documents.sort();
    deleted_documents.dedup();

    let mut asset_pairs = asset_upserts.into_iter().collect::<Vec<_>>();
    asset_pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let mut assets: Vec<RevisionAsset> = Vec::with_capacity(asset_pairs.len());
    for (path, asset_meta) in asset_pairs {
        let clean = sanitize_project_path(&path)?;
        let bytes = stored_asset_bytes(&state, &asset_meta).await?;
        assets.push(RevisionAsset {
            path: clean,
            content_type: asset_meta.content_type,
            size_bytes: asset_meta.size_bytes,
            content_base64: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                bytes,
            ),
        });
    }

    let mut deleted_assets = raw_deleted_assets
        .into_iter()
        .map(|path| sanitize_project_path(&path))
        .collect::<Result<Vec<_>, StatusCode>>()?;
    deleted_assets.sort();
    deleted_assets.dedup();

    let (base_anchor, base_revision_id) = match anchor_kind {
        RevisionAnchorKind::None => ("none".to_string(), None),
        RevisionAnchorKind::Live => ("live".to_string(), None),
        RevisionAnchorKind::Revision(id) => ("revision".to_string(), Some(id)),
    };

    Ok(Json(RevisionDocumentsResponse {
        revision_id,
        entry_file_path,
        transfer_mode: transfer_mode.to_string(),
        base_anchor,
        base_revision_id,
        nodes,
        documents,
        deleted_documents,
        assets,
        deleted_assets,
    }))
}

async fn list_documents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ListDocumentsQuery>,
) -> Result<Json<DocumentsResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = if let Some(path) = query.path {
        sqlx::query(
            "select id, project_id, path, content, updated_at
             from documents where project_id = $1 and path = $2 order by updated_at desc",
        )
        .bind(project_id)
        .bind(path)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    } else {
        sqlx::query(
            "select id, project_id, path, content, updated_at
             from documents where project_id = $1 order by updated_at desc limit 500",
        )
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };

    let documents = rows
        .into_iter()
        .map(|r| Document {
            id: r.get("id"),
            project_id: r.get("project_id"),
            path: r.get("path"),
            content: r.get("content"),
            updated_at: r.get("updated_at"),
        })
        .collect();

    Ok(Json(DocumentsResponse { documents }))
}

async fn create_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateDocumentInput>,
) -> Result<Json<Document>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let now = Utc::now();
    let id = Uuid::new_v4();
    let row = sqlx::query(
        "insert into documents (id, project_id, path, content, updated_at)
         values ($1, $2, $3, $4, $5)
         returning id, project_id, path, content, updated_at",
    )
    .bind(id)
    .bind(project_id)
    .bind(input.path)
    .bind(input.content)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::CONFLICT)?;

    write_audit(
        &state.db,
        Some(actor),
        "document.create",
        serde_json::json!({"project_id": project_id, "document_id": id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Document {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        content: row.get("content"),
        updated_at: row.get("updated_at"),
    }))
}

async fn upsert_document_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, path)): Path<(Uuid, String)>,
    Json(input): Json<UpsertDocumentByPathInput>,
) -> Result<Json<Document>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let now = Utc::now();
    let doc_id = Uuid::new_v4();
    let row = sqlx::query(
        "insert into documents (id, project_id, path, content, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, path) do update set content = excluded.content, updated_at = excluded.updated_at
         returning id, project_id, path, content, updated_at",
    )
    .bind(doc_id)
    .bind(project_id)
    .bind(path)
    .bind(input.content)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "document.upsert_by_path",
        serde_json::json!({"project_id": project_id, "document_id": row.get::<Uuid, _>("id"), "path": row.get::<String, _>("path")}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Document {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        content: row.get("content"),
        updated_at: row.get("updated_at"),
    }))
}

async fn get_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Document>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let row = sqlx::query(
        "select id, project_id, path, content, updated_at from documents where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(document_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };

    Ok(Json(Document {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        content: row.get("content"),
        updated_at: row.get("updated_at"),
    }))
}

async fn update_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateDocumentInput>,
) -> Result<Json<Document>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let now = Utc::now();
    let row = sqlx::query(
        "update documents set content = $3, updated_at = $4 where project_id = $1 and id = $2
         returning id, project_id, path, content, updated_at",
    )
    .bind(project_id)
    .bind(document_id)
    .bind(input.content)
    .bind(now)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };

    write_audit(
        &state.db,
        Some(actor),
        "document.update",
        serde_json::json!({"project_id": project_id, "document_id": document_id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Document {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        content: row.get("content"),
        updated_at: row.get("updated_at"),
    }))
}

async fn delete_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let result = sqlx::query("delete from documents where project_id = $1 and id = $2")
        .bind(project_id)
        .bind(document_id)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }

    write_audit(
        &state.db,
        Some(actor),
        "document.delete",
        serde_json::json!({"project_id": project_id, "document_id": document_id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, Deserialize)]
struct SnapshotDocumentPayload {
    path: String,
    content: String,
}

#[derive(Serialize, Deserialize)]
struct SnapshotPayload {
    project_id: Uuid,
    created_at: DateTime<Utc>,
    documents: Vec<SnapshotDocumentPayload>,
}

async fn list_project_snapshots(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectSnapshotListResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select id, project_id, object_key, created_by, created_at, document_count, byte_size
         from project_snapshots
         where project_id = $1
         order by created_at desc
         limit 200",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let snapshots = rows
        .into_iter()
        .map(|row| ProjectSnapshot {
            id: row.get("id"),
            project_id: row.get("project_id"),
            object_key: row.get("object_key"),
            created_by: row.get("created_by"),
            created_at: row.get("created_at"),
            document_count: row.get("document_count"),
            byte_size: row.get("byte_size"),
        })
        .collect();
    Ok(Json(ProjectSnapshotListResponse { snapshots }))
}

async fn create_project_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectSnapshot>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let Some(storage) = state.storage.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let rows =
        sqlx::query("select path, content from documents where project_id = $1 order by path asc")
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let documents = rows
        .iter()
        .map(|row| SnapshotDocumentPayload {
            path: row.get("path"),
            content: row.get("content"),
        })
        .collect::<Vec<_>>();
    let snapshot_payload = SnapshotPayload {
        project_id,
        created_at: Utc::now(),
        documents,
    };
    let bytes =
        serde_json::to_vec(&snapshot_payload).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let snapshot_id = Uuid::new_v4();
    let object_key = format!("projects/{project_id}/snapshots/{snapshot_id}.json");
    put_object(&storage, &object_key, "application/json", bytes.clone())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query(
        "insert into project_snapshots (id, project_id, object_key, created_by, created_at, document_count, byte_size)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, project_id, object_key, created_by, created_at, document_count, byte_size",
    )
    .bind(snapshot_id)
    .bind(project_id)
    .bind(object_key)
    .bind(actor)
    .bind(Utc::now())
    .bind(snapshot_payload.documents.len() as i32)
    .bind(bytes.len() as i64)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "project.snapshot.create",
        serde_json::json!({"project_id": project_id, "snapshot_id": snapshot_id}),
    )
    .await;

    Ok(Json(ProjectSnapshot {
        id: row.get("id"),
        project_id: row.get("project_id"),
        object_key: row.get("object_key"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        document_count: row.get("document_count"),
        byte_size: row.get("byte_size"),
    }))
}

async fn restore_project_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, snapshot_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let Some(storage) = state.storage.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let row =
        sqlx::query("select object_key from project_snapshots where project_id = $1 and id = $2")
            .bind(project_id)
            .bind(snapshot_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let object_key: String = row.get("object_key");
    let bytes = get_object(&storage, &object_key)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let payload: SnapshotPayload =
        serde_json::from_slice(&bytes).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    if payload.project_id != project_id {
        return Err(StatusCode::CONFLICT);
    }

    let existing_rows = sqlx::query("select id, path from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut existing_map: HashMap<String, Uuid> = HashMap::new();
    for row in existing_rows {
        existing_map.insert(row.get("path"), row.get("id"));
    }
    let mut restored_paths = HashSet::new();
    for doc in payload.documents {
        restored_paths.insert(doc.path.clone());
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, $3, $4, $5)
             on conflict (project_id, path)
             do update set content = excluded.content, updated_at = excluded.updated_at",
        )
        .bind(Uuid::new_v4())
        .bind(project_id)
        .bind(doc.path)
        .bind(doc.content)
        .bind(Utc::now())
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    for (path, doc_id) in existing_map {
        if !restored_paths.contains(&path) {
            let _ = sqlx::query("delete from documents where project_id = $1 and id = $2")
                .bind(project_id)
                .bind(doc_id)
                .execute(&state.db)
                .await;
        }
    }
    mark_project_dirty(&state.db, project_id, Some(actor)).await;
    write_audit(
        &state.db,
        Some(actor),
        "project.snapshot.restore",
        serde_json::json!({"project_id": project_id, "snapshot_id": snapshot_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_project_assets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectAssetListResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at
         from project_assets
         where project_id = $1
         order by created_at desc
         limit 500",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let assets = rows
        .into_iter()
        .map(|row| ProjectAsset {
            id: row.get("id"),
            project_id: row.get("project_id"),
            path: row.get("path"),
            object_key: row.get("object_key"),
            content_type: row.get("content_type"),
            size_bytes: row.get("size_bytes"),
            uploaded_by: row.get("uploaded_by"),
            created_at: row.get("created_at"),
        })
        .collect();
    Ok(Json(ProjectAssetListResponse { assets }))
}

async fn upload_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UploadAssetInput>,
) -> Result<Json<ProjectAsset>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let path = sanitize_project_path(&input.path)?;
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        input.content_base64,
    )
    .map_err(|_| StatusCode::BAD_REQUEST)?;
    let content_type = input
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let asset_id = Uuid::new_v4();
    let (object_key, inline_data) = if let Some(storage) = state.storage.clone() {
        let object_key = format!("projects/{project_id}/assets/{asset_id}");
        put_object(&storage, &object_key, &content_type, bytes.clone())
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        (object_key, None)
    } else {
        (format!("inline://{asset_id}"), Some(bytes.clone()))
    };
    let row = sqlx::query(
        "insert into project_assets (id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at, inline_data)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (project_id, path)
         do update set object_key = excluded.object_key, content_type = excluded.content_type, size_bytes = excluded.size_bytes, uploaded_by = excluded.uploaded_by, created_at = excluded.created_at, inline_data = excluded.inline_data
         returning id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at",
    )
    .bind(asset_id)
    .bind(project_id)
    .bind(path)
    .bind(object_key)
    .bind(content_type)
    .bind(bytes.len() as i64)
    .bind(actor)
    .bind(Utc::now())
    .bind(inline_data)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;
    write_audit(
        &state.db,
        Some(actor),
        "project.asset.upload",
        serde_json::json!({"project_id": project_id, "asset_id": row.get::<Uuid, _>("id")}),
    )
    .await;
    Ok(Json(ProjectAsset {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        object_key: row.get("object_key"),
        content_type: row.get("content_type"),
        size_bytes: row.get("size_bytes"),
        uploaded_by: row.get("uploaded_by"),
        created_at: row.get("created_at"),
    }))
}

async fn get_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, asset_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<ProjectAssetContentResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let row = sqlx::query(
        "select id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at, inline_data
         from project_assets
         where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(asset_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let bytes = if let Some(inline) = row.get::<Option<Vec<u8>>, _>("inline_data") {
        inline
    } else {
        let Some(storage) = state.storage.clone() else {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        };
        let object_key: String = row.get("object_key");
        get_object(&storage, &object_key)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };
    Ok(Json(ProjectAssetContentResponse {
        asset: ProjectAsset {
            id: row.get("id"),
            project_id: row.get("project_id"),
            path: row.get("path"),
            object_key: row.get("object_key"),
            content_type: row.get("content_type"),
            size_bytes: row.get("size_bytes"),
            uploaded_by: row.get("uploaded_by"),
            created_at: row.get("created_at"),
        },
        content_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
    }))
}

async fn delete_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, asset_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let row =
        sqlx::query("select object_key from project_assets where project_id = $1 and id = $2")
            .bind(project_id)
            .bind(asset_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let object_key: String = row.get("object_key");
    if !object_key.starts_with("inline://") {
        if let Some(storage) = state.storage.clone() {
            let _ = delete_object(&storage, &object_key).await;
        }
    }
    let result = sqlx::query("delete from project_assets where project_id = $1 and id = $2")
        .bind(project_id)
        .bind(asset_id)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.asset.delete",
        serde_json::json!({"project_id": project_id, "asset_id": asset_id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_project_asset_raw(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, asset_id)): Path<(Uuid, Uuid)>,
) -> Result<impl IntoResponse, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let row = sqlx::query(
        "select object_key, content_type, inline_data from project_assets where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(asset_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let content_type: String = row.get("content_type");
    let bytes = if let Some(inline) = row.get::<Option<Vec<u8>>, _>("inline_data") {
        inline
    } else {
        let Some(storage) = state.storage.clone() else {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        };
        let object_key: String = row.get("object_key");
        get_object(&storage, &object_key)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };
    let mut resp = axum::http::Response::new(Body::from(bytes));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    Ok(resp)
}

async fn download_project_archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows =
        sqlx::query("select path, content from documents where project_id = $1 order by path asc")
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for row in rows {
            let path: String = row.get("path");
            let content: String = row.get("content");
            zip.start_file(path, options)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            use std::io::Write;
            zip.write_all(content.as_bytes())
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        let asset_rows = sqlx::query(
            "select path, object_key, inline_data from project_assets where project_id = $1 order by path asc",
        )
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        for row in asset_rows {
            let path: String = row.get("path");
            let bytes = if let Some(inline) = row.get::<Option<Vec<u8>>, _>("inline_data") {
                inline
            } else {
                let Some(storage) = state.storage.clone() else {
                    continue;
                };
                let object_key: String = row.get("object_key");
                match get_object(&storage, &object_key).await {
                    Ok(data) => data,
                    Err(_) => continue,
                }
            };
            zip.start_file(path, options)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            use std::io::Write;
            zip.write_all(&bytes)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        zip.finish()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    let bytes = cursor.into_inner();
    let mut resp = axum::http::Response::new(Body::from(bytes));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/zip"),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&format!(
            "attachment; filename=\"project-{}.zip\"",
            project_id
        ))
        .unwrap_or_else(|_| header::HeaderValue::from_static("attachment")),
    );
    Ok(resp)
}

async fn update_project_archived(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectArchivedInput>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    if input.archived {
        sqlx::query(
            "insert into project_user_archives (project_id, user_id, archived_at)
             values ($1, $2, $3)
             on conflict (project_id, user_id)
             do update set archived_at = excluded.archived_at",
        )
        .bind(project_id)
        .bind(actor)
        .bind(Utc::now())
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    } else {
        sqlx::query("delete from project_user_archives where project_id = $1 and user_id = $2")
            .bind(project_id)
            .bind(actor)
            .execute(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    write_audit(
        &state.db,
        Some(actor),
        if input.archived {
            "project.archive"
        } else {
            "project.unarchive"
        },
        serde_json::json!({
            "project_id": project_id,
            "archived": input.archived
        }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn upload_project_pdf_artifact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UploadPdfArtifactInput>,
) -> Result<Json<PdfArtifact>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let entry_file_path =
        sanitize_project_path(input.entry_file_path.as_deref().unwrap_or("main.typ"))?;
    let content_type = input
        .content_type
        .unwrap_or_else(|| "application/pdf".to_string());
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        input.content_base64,
    )
    .map_err(|_| StatusCode::BAD_REQUEST)?;
    let id = Uuid::new_v4();
    let row = sqlx::query(
        "insert into project_pdf_artifacts
         (id, project_id, entry_file_path, content_type, pdf_bytes, size_bytes, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, project_id, entry_file_path, content_type, size_bytes, created_by, created_at",
    )
    .bind(id)
    .bind(project_id)
    .bind(&entry_file_path)
    .bind(&content_type)
    .bind(bytes.clone())
    .bind(i64::try_from(bytes.len()).unwrap_or(0))
    .bind(actor)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    write_audit(
        &state.db,
        Some(actor),
        "project.pdf.upload",
        serde_json::json!({ "project_id": project_id, "pdf_id": id, "entry_file_path": entry_file_path }),
    )
    .await;
    Ok(Json(PdfArtifact {
        id: row.get("id"),
        project_id: row.get("project_id"),
        entry_file_path: row.get("entry_file_path"),
        content_type: row.get("content_type"),
        size_bytes: row.get("size_bytes"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
    }))
}

async fn download_latest_project_pdf_artifact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let row = sqlx::query(
        "select entry_file_path, content_type, pdf_bytes
         from project_pdf_artifacts
         where project_id = $1
         order by created_at desc
         limit 1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let entry_file_path: String = row.get("entry_file_path");
    let content_type: String = row.get("content_type");
    let pdf_bytes: Vec<u8> = row.get("pdf_bytes");
    let mut resp = axum::http::Response::new(Body::from(pdf_bytes));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/pdf")),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&format!("attachment; filename=\"{}\"", entry_file_path))
            .unwrap_or_else(|_| header::HeaderValue::from_static("attachment")),
    );
    Ok(resp)
}
