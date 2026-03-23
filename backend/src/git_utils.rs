use std::collections::HashMap;
use std::env;
use std::path::{Component, Path as FsPath, PathBuf};
use std::process::Command;
use uuid::Uuid;

pub fn git_storage_root() -> PathBuf {
    env::var("GIT_STORAGE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./tmp/git"))
}

pub fn project_git_repo_path(project_id: Uuid) -> PathBuf {
    git_storage_root().join(project_id.to_string())
}

pub fn ensure_git_repo_initialized(repo_path: &str, default_branch: &str) -> Result<(), String> {
    let path = PathBuf::from(repo_path);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let git_dir = path.join(".git");
    if !git_dir.exists() {
        run_git(repo_path, &["init", "-b", default_branch])?;
    }
    run_git(
        repo_path,
        &["config", "receive.denyNonFastForwards", "true"],
    )?;
    run_git(
        repo_path,
        &["config", "receive.denyCurrentBranch", "updateInstead"],
    )?;
    run_git(repo_path, &["config", "http.receivepack", "true"])?;
    Ok(())
}

pub fn ensure_git_branch_checked_out(repo_path: &str, default_branch: &str) -> Result<(), String> {
    let has_branch = run_git(
        repo_path,
        &[
            "show-ref",
            "--verify",
            &format!("refs/heads/{}", default_branch),
        ],
    )
    .is_ok();
    if !has_branch {
        let _ = run_git(repo_path, &["checkout", "-B", default_branch]);
    } else {
        run_git(repo_path, &["checkout", default_branch])?;
    }
    Ok(())
}

pub fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

pub fn collect_repo_files(repo_path: &str) -> Result<HashMap<String, String>, String> {
    let root = PathBuf::from(repo_path);
    let mut out = HashMap::new();
    collect_repo_files_recursive(&root, &root, &mut out)?;
    Ok(out)
}

fn collect_repo_files_recursive(
    root: &PathBuf,
    current: &PathBuf,
    out: &mut HashMap<String, String>,
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
            let Ok(content) = String::from_utf8(bytes) else {
                continue;
            };
            out.insert(rel, content);
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
