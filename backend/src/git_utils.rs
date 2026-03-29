use std::collections::HashMap;
use std::env;
use std::path::{Component, Path as FsPath, PathBuf};
use std::str;

use git2::{build::CheckoutBuilder, IndexAddOption, Oid, Repository, Signature, StatusOptions};
use uuid::Uuid;

pub fn git_storage_root() -> PathBuf {
    if let Ok(explicit) = env::var("GIT_STORAGE_PATH") {
        return PathBuf::from(explicit);
    }
    if let Ok(data_dir) = env::var("DATA_DIR") {
        return PathBuf::from(data_dir).join("git");
    }
    PathBuf::from("./tmp/git")
}

pub fn project_git_repo_path(project_id: Uuid) -> PathBuf {
    git_storage_root().join(project_id.to_string())
}

pub fn ensure_git_repo_initialized(repo_path: &str, default_branch: &str) -> Result<(), String> {
    let path = PathBuf::from(repo_path);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let git_dir = path.join(".git");
    if !git_dir.exists() {
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head(default_branch);
        Repository::init_opts(&path, &options).map_err(|e| e.to_string())?;
    }
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;
    let mut cfg = repo.config().map_err(|e| e.to_string())?;
    cfg.set_bool("receive.denyNonFastForwards", true)
        .map_err(|e| e.to_string())?;
    cfg.set_str("receive.denyCurrentBranch", "updateInstead")
        .map_err(|e| e.to_string())?;
    cfg.set_bool("http.receivepack", true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn ensure_git_branch_checked_out(repo_path: &str, default_branch: &str) -> Result<(), String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    let branch_ref = format!("refs/heads/{default_branch}");
    repo.set_head(&branch_ref).map_err(|e| e.to_string())?;
    if repo.find_reference(&branch_ref).is_ok() {
        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        let _ = repo.checkout_head(Some(&mut checkout));
    }
    Ok(())
}

fn default_git_signature() -> Result<Signature<'static>, String> {
    Signature::now("Typst Server", "noreply@typst-server.local").map_err(|e| e.to_string())
}

pub fn git_worktree_is_clean(repo_path: &str) -> Result<bool, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    Ok(statuses.is_empty())
}

pub fn git_commit_staged_if_changed(
    repo_path: &str,
    message: &str,
    author_name: &str,
    author_email: &str,
) -> Result<Option<String>, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;

    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let head_commit = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .and_then(|oid| repo.find_commit(oid).ok());

    if let Some(parent) = head_commit.as_ref() {
        if let Ok(parent_tree) = parent.tree() {
            if parent_tree.id() == tree.id() {
                return Ok(None);
            }
        }
    }

    let author = Signature::now(author_name, author_email).map_err(|e| e.to_string())?;
    let committer = default_git_signature()?;
    let commit_id = if let Some(parent) = head_commit {
        repo.commit(
            Some("HEAD"),
            &author,
            &committer,
            message,
            &tree,
            &[&parent],
        )
        .map_err(|e| e.to_string())?
    } else {
        repo.commit(Some("HEAD"), &author, &committer, message, &tree, &[])
            .map_err(|e| e.to_string())?
    };
    Ok(Some(commit_id.to_string()))
}

pub fn git_commit_allow_empty(
    repo_path: &str,
    message: &str,
    author_name: &str,
    author_email: &str,
) -> Result<String, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;

    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let head_commit = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .and_then(|oid| repo.find_commit(oid).ok());

    let author = Signature::now(author_name, author_email).map_err(|e| e.to_string())?;
    let committer = default_git_signature()?;
    let commit_id = if let Some(parent) = head_commit {
        repo.commit(
            Some("HEAD"),
            &author,
            &committer,
            message,
            &tree,
            &[&parent],
        )
        .map_err(|e| e.to_string())?
    } else {
        repo.commit(Some("HEAD"), &author, &committer, message, &tree, &[])
            .map_err(|e| e.to_string())?
    };
    Ok(commit_id.to_string())
}

pub fn git_head_oid(repo_path: &str) -> Result<Option<Oid>, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    Ok(repo.head().ok().and_then(|h| h.target()))
}

pub fn git_hard_reset_to(repo_path: &str, target: Oid) -> Result<(), String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    let object = repo.find_object(target, None).map_err(|e| e.to_string())?;
    repo.reset(&object, git2::ResetType::Hard, None)
        .map_err(|e| e.to_string())
}

pub fn git_ancestor(repo_path: &str, ancestor: Oid, tip: Oid) -> Result<bool, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    Ok(repo.graph_descendant_of(tip, ancestor).unwrap_or(false))
}

pub fn collect_repo_files(repo_path: &str) -> Result<HashMap<String, Vec<u8>>, String> {
    let root = PathBuf::from(repo_path);
    let mut out = HashMap::new();
    collect_repo_files_recursive(&root, &root, &mut out)?;
    Ok(out)
}

fn collect_repo_files_recursive(
    root: &PathBuf,
    current: &PathBuf,
    out: &mut HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(current).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            if path.file_name().and_then(|x| x.to_str()) == Some(".git") {
                continue;
            }
            collect_repo_files_recursive(root, &path, out)?;
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            out.insert(rel, bytes);
        }
    }
    Ok(())
}

pub fn sanitize_repo_relative_path(repo_path: &str, relative: &str) -> Result<PathBuf, String> {
    let rel_path = FsPath::new(relative);
    if rel_path.is_absolute() {
        return Err("document path cannot be absolute".to_string());
    }
    if rel_path.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("document path contains invalid traversal".to_string());
    }
    Ok(PathBuf::from(repo_path).join(rel_path))
}
