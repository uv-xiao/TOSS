export const CORE_API_URL =
  process.env.NEXT_PUBLIC_CORE_API_URL ?? "http://localhost:8080";
const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? "";

function authHeaders(extra?: Record<string, string>) {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (DEV_USER_ID) {
    headers["x-user-id"] = DEV_USER_ID;
  }
  return headers;
}

export type ProjectRole = "Owner" | "Teacher" | "Student" | "TA";

export type Project = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  created_at: string;
};

export type GitSyncState = {
  project_id: string;
  branch: string;
  last_pull_at: string | null;
  last_push_at: string | null;
  has_conflicts: boolean;
  status: string;
};

export type GitRemoteConfig = {
  project_id: string;
  remote_url: string | null;
  local_path: string;
  default_branch: string;
};

export type Comment = {
  id: string;
  project_id: string;
  actor_user_id: string | null;
  body: string;
  anchor: string | null;
  created_at: string;
};

export type Revision = {
  id: string;
  project_id: string;
  actor_user_id: string | null;
  summary: string;
  created_at: string;
};

export type Document = {
  id: string;
  project_id: string;
  path: string;
  content: string;
  updated_at: string;
};

export type PersonalAccessTokenInfo = {
  id: string;
  label: string;
  token_prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type CreatePatResponse = {
  id: string;
  label: string;
  token: string;
  token_prefix: string;
  created_at: string;
  expires_at: string | null;
};

export type ProjectGroupRoleBinding = {
  project_id: string;
  group_name: string;
  role: ProjectRole;
  granted_at: string;
};

export type ProjectAsset = {
  id: string;
  project_id: string;
  path: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
};

export type ProjectAssetContent = {
  asset: ProjectAsset;
  content_base64: string;
};

export async function getAuthMe() {
  const res = await fetch(`${CORE_API_URL}/v1/auth/me`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) return null;
  return (await res.json()) as {
    user_id: string;
    email: string;
    display_name: string;
    session_expires_at: string;
  };
}

export function oidcLoginUrl() {
  return `${CORE_API_URL}/v1/auth/oidc/login`;
}

export async function logout() {
  await fetch(`${CORE_API_URL}/v1/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders()
  });
}

export async function listProjects() {
  const res = await fetch(`${CORE_API_URL}/v1/projects`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) {
    throw new Error("Unable to load projects");
  }
  return (await res.json()) as { projects: Project[] };
}

export async function getGitStatus(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/git/status/${projectId}`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) {
    throw new Error("Unable to get git status");
  }
  return (await res.json()) as GitSyncState;
}

export async function getGitConfig(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/git/config/${projectId}`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to get git config");
  return (await res.json()) as GitRemoteConfig;
}

export async function upsertGitConfig(
  projectId: string,
  input: { remote_url?: string | null; default_branch?: string | null }
) {
  const res = await fetch(`${CORE_API_URL}/v1/git/config/${projectId}`, {
    method: "PUT",
    credentials: "include",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({
      remote_url: input.remote_url ?? null,
      default_branch: input.default_branch ?? "main"
    })
  });
  if (!res.ok) throw new Error("Unable to update git config");
  return (await res.json()) as GitRemoteConfig;
}

export async function triggerGitPull(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/git/sync/pull/${projectId}`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({})
  });
  if (!res.ok) throw new Error("Git pull failed");
  return (await res.json()) as GitSyncState;
}

export async function triggerGitPush(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/git/sync/push/${projectId}`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({})
  });
  if (!res.ok) throw new Error("Git push failed");
  return (await res.json()) as GitSyncState;
}

export async function listPersonalAccessTokens() {
  const res = await fetch(`${CORE_API_URL}/v1/security/tokens`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to list tokens");
  return (await res.json()) as { tokens: PersonalAccessTokenInfo[] };
}

export async function createPersonalAccessToken(input: {
  label: string;
  expires_at?: string | null;
}) {
  const res = await fetch(`${CORE_API_URL}/v1/security/tokens`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({
      label: input.label,
      expires_at: input.expires_at ?? null
    })
  });
  if (!res.ok) throw new Error("Unable to create token");
  return (await res.json()) as CreatePatResponse;
}

export async function revokePersonalAccessToken(tokenId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/security/tokens/${tokenId}`, {
    method: "DELETE",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to revoke token");
}

export async function listComments(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/comments`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to list comments");
  return (await res.json()) as { comments: Comment[] };
}

export async function listRevisions(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/revisions`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to list revisions");
  return (await res.json()) as { revisions: Revision[] };
}

export async function listDocuments(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/documents`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to list documents");
  return (await res.json()) as { documents: Document[] };
}

export async function upsertDocumentByPath(projectId: string, path: string, content: string) {
  const safePath = encodeURIComponent(path);
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/documents/by-path/${safePath}`, {
    method: "PUT",
    credentials: "include",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({ content })
  });
  if (!res.ok) throw new Error("Unable to save document");
  return (await res.json()) as Document;
}

export async function createComment(projectId: string, body: string, anchor?: string) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/comments`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({ body, anchor })
  });
  if (!res.ok) throw new Error("Unable to create comment");
  return (await res.json()) as Comment;
}

export async function createRevision(projectId: string, summary: string) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/revisions`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({ summary })
  });
  if (!res.ok) throw new Error("Unable to create revision");
  return (await res.json()) as Revision;
}

export async function listProjectAssets(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/assets`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to list assets");
  return (await res.json()) as { assets: ProjectAsset[] };
}

export function projectAssetRawUrl(projectId: string, assetId: string) {
  return `${CORE_API_URL}/v1/projects/${projectId}/assets/${assetId}/raw`;
}

export async function getProjectAssetContent(projectId: string, assetId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/assets/${assetId}`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to load asset content");
  return (await res.json()) as ProjectAssetContent;
}

export async function listProjectGroupRoles(projectId: string) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/group-roles`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to list project group roles");
  return (await res.json()) as ProjectGroupRoleBinding[];
}

export async function upsertProjectGroupRole(
  projectId: string,
  input: { group_name: string; role: ProjectRole }
) {
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/group-roles`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error("Unable to upsert project group role");
  return (await res.json()) as ProjectGroupRoleBinding;
}

export async function deleteProjectGroupRole(projectId: string, groupName: string) {
  const safeName = encodeURIComponent(groupName);
  const res = await fetch(`${CORE_API_URL}/v1/projects/${projectId}/group-roles/${safeName}`, {
    method: "DELETE",
    credentials: "include",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to delete project group role");
}
