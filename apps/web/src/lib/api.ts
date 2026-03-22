import { resolveDevUserId } from "@/lib/dev-auth";

const API_BASE = (import.meta.env.VITE_CORE_API_URL as string | undefined)?.trim() ?? "";

function apiUrl(path: string) {
  if (!API_BASE) return path;
  return `${API_BASE.replace(/\/$/, "")}${path}`;
}

function devUserId() {
  return resolveDevUserId();
}

function authCredentials(): RequestCredentials {
  if (devUserId()) return "omit";
  return "include";
}

function authHeaders(extra?: Record<string, string>) {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const id = devUserId();
  if (id) headers["x-user-id"] = id;
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

export type ProjectTreeNode = {
  path: string;
  kind: "file" | "directory";
};

export type ProjectTreeResponse = {
  nodes: ProjectTreeNode[];
  entry_file_path: string;
};

export type Document = {
  id: string;
  project_id: string;
  path: string;
  content: string;
  updated_at: string;
};

export type Revision = {
  id: string;
  project_id: string;
  actor_user_id: string | null;
  summary: string;
  created_at: string;
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

export type GitRepoLink = {
  project_id: string;
  repo_url: string;
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

export type OrgGroupRoleMapping = {
  organization_id: string;
  group_name: string;
  role: ProjectRole;
  granted_at: string;
};

export type ProjectSettings = {
  project_id: string;
  entry_file_path: string;
  updated_at: string;
};

async function parseJsonOrThrow<T>(res: Response, message: string): Promise<T> {
  if (!res.ok) throw new Error(`${message} (${res.status})`);
  return (await res.json()) as T;
}

export async function getAuthMe() {
  const res = await fetch(apiUrl("/v1/auth/me"), {
    cache: "no-store",
    credentials: authCredentials(),
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
  return apiUrl("/v1/auth/oidc/login");
}

export async function logout() {
  await fetch(apiUrl("/v1/auth/logout"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders()
  });
}

export async function listProjects() {
  const res = await fetch(apiUrl("/v1/projects"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ projects: Project[] }>(res, "Unable to load projects");
}

export async function getProjectTree(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/tree`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectTreeResponse>(res, "Unable to load project tree");
}

export async function createProjectFile(
  projectId: string,
  input: { path: string; kind: "file" | "directory"; content?: string }
) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/files`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error("Unable to create path");
}

export async function moveProjectFile(projectId: string, fromPath: string, toPath: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/files/move`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ from_path: fromPath, to_path: toPath })
  });
  if (!res.ok) throw new Error("Unable to move path");
}

export async function deleteProjectFile(projectId: string, path: string) {
  const safePath = encodeURIComponent(path);
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/files/${safePath}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to delete path");
}

export async function listDocuments(projectId: string, path?: string) {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/documents${query}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ documents: Document[] }>(res, "Unable to list documents");
}

export async function upsertDocumentByPath(projectId: string, path: string, content: string) {
  const safePath = encodeURIComponent(path);
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/documents/by-path/${safePath}`), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ content })
  });
  return parseJsonOrThrow<Document>(res, "Unable to save document");
}

export async function listRevisions(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/revisions`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ revisions: Revision[] }>(res, "Unable to list revisions");
}

export async function createRevision(projectId: string, summary: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/revisions`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ summary })
  });
  return parseJsonOrThrow<Revision>(res, "Unable to create revision");
}

export async function listProjectAssets(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/assets`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ assets: ProjectAsset[] }>(res, "Unable to list assets");
}

export async function getProjectAssetContent(projectId: string, assetId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/assets/${assetId}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectAssetContent>(res, "Unable to load asset");
}

export async function uploadProjectAsset(
  projectId: string,
  input: { path: string; content_base64: string; content_type?: string }
) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/assets`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<ProjectAsset>(res, "Unable to upload asset");
}

export async function getGitRepoLink(projectId: string) {
  const res = await fetch(apiUrl(`/v1/git/repo-link/${projectId}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<GitRepoLink>(res, "Unable to get Git repo link");
}

export async function getProjectSettings(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/settings`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectSettings>(res, "Unable to load project settings");
}

export async function upsertProjectSettings(projectId: string, entryFilePath: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/settings`), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ entry_file_path: entryFilePath })
  });
  return parseJsonOrThrow<ProjectSettings>(res, "Unable to save project settings");
}

export function projectArchiveUrl(projectId: string) {
  return apiUrl(`/v1/projects/${projectId}/archive`);
}

export function latestProjectPdfUrl(projectId: string) {
  return apiUrl(`/v1/projects/${projectId}/pdf-artifacts/latest`);
}

export async function uploadProjectPdfArtifact(
  projectId: string,
  input: { entry_file_path: string; content_base64: string; content_type?: string }
) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/pdf-artifacts`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error("Unable to upload PDF artifact");
}

export async function listPersonalAccessTokens() {
  const res = await fetch(apiUrl("/v1/profile/security/tokens"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ tokens: PersonalAccessTokenInfo[] }>(res, "Unable to list tokens");
}

export async function createPersonalAccessToken(input: { label: string; expires_at?: string | null }) {
  const res = await fetch(apiUrl("/v1/profile/security/tokens"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ label: input.label, expires_at: input.expires_at ?? null })
  });
  return parseJsonOrThrow<CreatePatResponse>(res, "Unable to create token");
}

export async function revokePersonalAccessToken(tokenId: string) {
  const res = await fetch(apiUrl(`/v1/profile/security/tokens/${tokenId}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to revoke token");
}

export async function listOrgGroupRoleMappings(orgId: string) {
  const res = await fetch(apiUrl(`/v1/admin/orgs/${orgId}/oidc-group-role-mappings`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<OrgGroupRoleMapping[]>(res, "Unable to list org mappings");
}

export async function upsertOrgGroupRoleMapping(
  orgId: string,
  input: { group_name: string; role: ProjectRole }
) {
  const res = await fetch(apiUrl(`/v1/admin/orgs/${orgId}/oidc-group-role-mappings`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<OrgGroupRoleMapping>(res, "Unable to save mapping");
}

export async function deleteOrgGroupRoleMapping(orgId: string, groupName: string) {
  const safe = encodeURIComponent(groupName);
  const res = await fetch(apiUrl(`/v1/admin/orgs/${orgId}/oidc-group-role-mappings/${safe}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to delete mapping");
}
