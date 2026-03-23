const API_BASE = (import.meta.env.VITE_CORE_API_URL as string | undefined)?.trim() ?? "";

function apiUrl(path: string) {
  if (!API_BASE) return path;
  return `${API_BASE.replace(/\/$/, "")}${path}`;
}

function authCredentials(): RequestCredentials {
  return "include";
}

function authHeaders(extra?: Record<string, string>) {
  return { ...(extra ?? {}) };
}

function encodePathPreservingSlashes(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function parseJsonOrThrow<T>(res: Response, message: string): Promise<T> {
  if (!res.ok) throw new Error(`${message} (${res.status})`);
  return (await res.json()) as T;
}

export type ProjectRole = "Owner" | "Teacher" | "Student" | "TA" | "Viewer";
export type SharePermission = "read" | "write";

export type OrganizationMembership = {
  organization_id: string;
  organization_name: string;
  is_admin: boolean;
  joined_at: string;
};

export type Project = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  my_role: ProjectRole | "Viewer";
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

export type RevisionAuthor = {
  user_id: string;
  display_name: string;
  email: string;
};

export type Revision = {
  id: string;
  project_id: string;
  actor_user_id: string | null;
  summary: string;
  created_at: string;
  authors: RevisionAuthor[];
};

export type RevisionDocument = {
  path: string;
  content: string;
};

export type RevisionDocumentsResponse = {
  revision_id: string;
  documents: RevisionDocument[];
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

export type AuthConfig = {
  allow_local_login: boolean;
  allow_local_registration: boolean;
  allow_oidc: boolean;
  site_name: string;
  issuer: string | null;
  client_id: string | null;
  redirect_uri: string | null;
  groups_claim: string;
};

export type AuthUser = {
  user_id: string;
  email: string;
  display_name: string;
  session_expires_at: string;
};

export type AdminAuthSettings = {
  allow_local_login: boolean;
  allow_local_registration: boolean;
  allow_oidc: boolean;
  site_name: string;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret: string | null;
  oidc_redirect_uri: string | null;
  oidc_groups_claim: string;
  updated_at: string;
};

export type ProjectShareLink = {
  id: string;
  project_id: string;
  token_prefix: string;
  token_value?: string | null;
  permission: SharePermission;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

export type CreateProjectShareLinkResponse = {
  link: ProjectShareLink;
  token: string;
};

export type JoinProjectShareLinkResponse = {
  project_id: string;
  role: ProjectRole | "Viewer";
};

export type ProjectOrganizationAccess = {
  project_id: string;
  organization_id: string;
  organization_name: string;
  permission: SharePermission;
  granted_by: string | null;
  granted_at: string;
};

export type ProjectAccessUser = {
  user_id: string;
  email: string;
  display_name: string;
  role: ProjectRole | "Viewer";
  access_type: "read" | "write" | "manage" | string;
  sources: string[];
};

export async function getAuthConfig() {
  const res = await fetch(apiUrl("/v1/auth/config"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<AuthConfig>(res, "Unable to load auth config");
}

export async function getAuthMe() {
  const res = await fetch(apiUrl("/v1/auth/me"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthUser;
}

export async function localLogin(email: string, password: string) {
  const res = await fetch(apiUrl("/v1/auth/local/login"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) throw new Error(`Local login failed (${res.status})`);
}

export async function localRegister(input: {
  email: string;
  password: string;
  display_name?: string;
}) {
  const res = await fetch(apiUrl("/v1/auth/local/register"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(`Local register failed (${res.status})`);
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

export async function createProject(input: {
  organization_id?: string | null;
  name: string;
  description?: string | null;
}) {
  const res = await fetch(apiUrl("/v1/projects"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<Project>(res, "Unable to create project");
}

export async function listMyOrganizations() {
  const res = await fetch(apiUrl("/v1/organizations/mine"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ organizations: OrganizationMembership[] }>(
    res,
    "Unable to list organizations"
  );
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
  const safePath = encodePathPreservingSlashes(path);
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

export async function getRevisionDocuments(projectId: string, revisionId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/revisions/${revisionId}/documents`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<RevisionDocumentsResponse>(res, "Unable to load revision documents");
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

export async function downloadProjectArchive(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/archive`), {
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) throw new Error(`Unable to download archive (${res.status})`);
  return res.blob();
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

export async function getAdminAuthSettings() {
  const res = await fetch(apiUrl("/v1/admin/settings/auth"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  const parsed = await parseJsonOrThrow<{ settings: AdminAuthSettings }>(
    res,
    "Unable to load auth settings"
  );
  return parsed.settings;
}

export async function upsertAdminAuthSettings(input: {
  allow_local_login: boolean;
  allow_local_registration: boolean;
  allow_oidc: boolean;
  site_name?: string | null;
  oidc_discovery_url?: string | null;
  oidc_client_id?: string | null;
  oidc_client_secret?: string | null;
  oidc_redirect_uri?: string | null;
  oidc_groups_claim?: string | null;
}) {
  const res = await fetch(apiUrl("/v1/admin/settings/auth"), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  const parsed = await parseJsonOrThrow<{ settings: AdminAuthSettings }>(
    res,
    "Unable to save auth settings"
  );
  return parsed.settings;
}

export async function listProjectShareLinks(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/share-links`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectShareLink[]>(res, "Unable to list share links");
}

export async function createProjectShareLink(
  projectId: string,
  input: { permission: SharePermission; expires_at?: string | null }
) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/share-links`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<CreateProjectShareLinkResponse>(res, "Unable to create share link");
}

export async function revokeProjectShareLink(projectId: string, shareLinkId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/share-links/${shareLinkId}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to revoke share link");
}

export async function listProjectOrganizationAccess(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/organization-access`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectOrganizationAccess[]>(
    res,
    "Unable to list organization access"
  );
}

export async function upsertProjectOrganizationAccess(
  projectId: string,
  organizationId: string,
  permission: SharePermission
) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/organization-access/${organizationId}`), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ permission })
  });
  return parseJsonOrThrow<ProjectOrganizationAccess>(
    res,
    "Unable to save organization access"
  );
}

export async function deleteProjectOrganizationAccess(projectId: string, organizationId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/organization-access/${organizationId}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Unable to remove organization access");
}

export async function listProjectAccessUsers(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/access-users`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ users: ProjectAccessUser[] }>(res, "Unable to list access users");
}

export async function joinProjectShareLink(token: string) {
  const res = await fetch(apiUrl(`/v1/share/${encodeURIComponent(token)}/join`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<JoinProjectShareLinkResponse>(res, "Unable to join shared project");
}
