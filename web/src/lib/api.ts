const API_BASE = (import.meta.env.VITE_CORE_API_URL as string | undefined)?.trim() ?? "";
let shareAccessToken: string | null = null;
let guestShareSession: string | null = null;

function apiUrl(path: string) {
  if (!API_BASE) return path;
  return `${API_BASE.replace(/\/$/, "")}${path}`;
}

function authCredentials(): RequestCredentials {
  return "include";
}

function authHeaders(extra?: Record<string, string>) {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (shareAccessToken) headers["x-share-token"] = shareAccessToken;
  if (guestShareSession) headers["x-guest-session"] = guestShareSession;
  return headers;
}

function encodePathPreservingSlashes(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function statusDefaultHint(status: number): string {
  if (status === 400) return "Invalid request";
  if (status === 401) return "Please sign in again";
  if (status === 403) return "Permission denied";
  if (status === 404) return "Resource not found";
  if (status === 409) return "Conflict";
  if (status >= 500) return "Server error";
  return "Request failed";
}

function messageFromErrorPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const fields = [record.error, record.message, record.detail];
  for (const value of fields) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function responseErrorMessage(res: Response): Promise<string | null> {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    const payload = await res.json().catch(() => null);
    return messageFromErrorPayload(payload);
  }
  const text = (await res.text().catch(() => "")).trim();
  return text || null;
}

async function throwApiError(res: Response, fallback: string): Promise<never> {
  const message = (await responseErrorMessage(res)) || statusDefaultHint(res.status);
  throw new ApiError(`${fallback}: ${message}`, res.status);
}

async function parseJsonOrThrow<T>(res: Response, message: string): Promise<T> {
  if (!res.ok) await throwApiError(res, message);
  return (await res.json()) as T;
}

export type ProjectRole = "Owner" | "ReadWrite" | "ReadOnly";
export type OrganizationMembershipRole = "owner" | "member";
export type SharePermission = "read" | "write";

export type OrganizationMembership = {
  organization_id: string;
  organization_name: string;
  membership_role: OrganizationMembershipRole | string;
  joined_at: string;
};

export type Project = {
  id: string;
  name: string;
  owner_user_id: string | null;
  owner_display_name: string;
  my_role: ProjectRole;
  can_read: boolean;
  is_template: boolean;
  has_thumbnail: boolean;
  created_at: string;
  last_edited_at: string;
  archived: boolean;
  archived_at: string | null;
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

export type RevisionAsset = {
  path: string;
  content_type: string;
  size_bytes: number;
  content_base64: string;
};

export type RevisionDocumentsResponse = {
  revision_id: string;
  entry_file_path: string;
  transfer_mode?: "full" | "delta" | string;
  base_anchor?: "none" | "live" | "revision" | string;
  base_revision_id?: string | null;
  nodes: ProjectTreeNode[];
  documents: RevisionDocument[];
  deleted_documents?: string[];
  assets: RevisionAsset[];
  deleted_assets?: string[];
};

export type DownloadProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

export type RevisionDocumentsFetchOptions = {
  currentRevisionId?: string | null;
  includeLiveAnchor?: boolean;
};

export type ListRevisionsOptions = {
  before?: string;
  limit?: number;
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
  role: OrganizationMembershipRole | string;
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
  anonymous_mode: "off" | "read_only" | "read_write_named" | string;
  site_name: string;
  issuer: string | null;
  client_id: string | null;
  redirect_uri: string | null;
  groups_claim: string;
};

export type AuthUser = {
  user_id: string;
  email: string;
  username: string;
  display_name: string;
  session_expires_at: string;
};

export type AdminAuthSettings = {
  allow_local_login: boolean;
  allow_local_registration: boolean;
  allow_oidc: boolean;
  anonymous_mode: "off" | "read_only" | "read_write_named" | string;
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
  role: ProjectRole;
};

export type ResolveProjectShareLinkResponse = {
  project_id: string;
  project_name: string;
  permission: SharePermission;
  anonymous_mode: "off" | "read_only" | "read_write_named" | string;
};

export type TemporaryShareLoginResponse = {
  project_id: string;
  session_token: string;
  session_id: string;
  display_name: string;
  permission: SharePermission;
};

export function setShareAccessContext(input: {
  shareToken?: string | null;
  guestSession?: string | null;
}) {
  shareAccessToken = input.shareToken?.trim() ? input.shareToken.trim() : null;
  guestShareSession = input.guestSession?.trim() ? input.guestSession.trim() : null;
}

export function clearShareAccessContext() {
  shareAccessToken = null;
  guestShareSession = null;
}

export type ProjectOrganizationAccess = {
  project_id: string;
  organization_id: string;
  organization_name: string;
  permission: SharePermission;
  granted_by: string | null;
  granted_at: string;
};

export type ProjectTemplateOrganizationAccess = {
  project_id: string;
  organization_id: string;
  organization_name: string;
  granted_by: string | null;
  granted_at: string;
};

export type ProjectTemplateState = {
  project_id: string;
  is_template: boolean;
  updated_at: string;
};

export type ProjectAccessUser = {
  user_id: string;
  email: string;
  display_name: string;
  role: ProjectRole;
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
  if (res.status === 401) return null;
  if (!res.ok) await throwApiError(res, "Unable to load current session");
  return (await res.json()) as AuthUser;
}

export async function localLogin(email: string, password: string) {
  const res = await fetch(apiUrl("/v1/auth/local/login"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) await throwApiError(res, "Login failed");
}

export async function localRegister(input: {
  email: string;
  username: string;
  password: string;
  display_name?: string;
}) {
  const res = await fetch(apiUrl("/v1/auth/local/register"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!res.ok) await throwApiError(res, "Registration failed");
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

export async function listProjects(input?: { includeArchived?: boolean; q?: string }) {
  const params = new URLSearchParams();
  if (typeof input?.includeArchived === "boolean") {
    params.set("include_archived", input.includeArchived ? "true" : "false");
  }
  if (input?.q?.trim()) params.set("q", input.q.trim());
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(apiUrl(`/v1/projects${query}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ projects: Project[] }>(res, "Unable to load projects");
}

export async function createProject(input: { name: string }) {
  const res = await fetch(apiUrl("/v1/projects"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<Project>(res, "Unable to create project");
}

export async function copyProject(projectId: string, input: { name: string }) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/copy`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<Project>(res, "Unable to copy project");
}

export async function renameProject(projectId: string, name: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name })
  });
  if (!res.ok) await throwApiError(res, "Unable to rename project");
}

export async function setProjectArchived(projectId: string, archived: boolean) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/archive`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ archived })
  });
  if (!res.ok) await throwApiError(res, `Unable to ${archived ? "archive" : "unarchive"} project`);
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
  if (!res.ok) await throwApiError(res, "Unable to create path");
}

export async function moveProjectFile(projectId: string, fromPath: string, toPath: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/files/move`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ from_path: fromPath, to_path: toPath })
  });
  if (!res.ok) await throwApiError(res, "Unable to move path");
}

export async function deleteProjectFile(projectId: string, path: string) {
  const safePath = encodePathPreservingSlashes(path);
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/files/${safePath}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) await throwApiError(res, "Unable to delete path");
}

export async function listDocuments(
  projectId: string,
  options?: { path?: string; sinceUpdatedAt?: string | null }
) {
  const params = new URLSearchParams();
  if (options?.path) params.set("path", options.path);
  if (options?.sinceUpdatedAt) params.set("since_updated_at", options.sinceUpdatedAt);
  const query = params.size > 0 ? `?${params.toString()}` : "";
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

export async function listRevisions(projectId: string, options?: ListRevisionsOptions) {
  const params = new URLSearchParams();
  if (options?.before) params.set("before", options.before);
  if (typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0) {
    params.set("limit", String(Math.floor(options.limit)));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/revisions${query}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ revisions: Revision[] }>(res, "Unable to list revisions");
}

export async function getRevisionDocuments(
  projectId: string,
  revisionId: string,
  options?: RevisionDocumentsFetchOptions,
  onProgress?: (progress: DownloadProgress) => void
) {
  const params = new URLSearchParams();
  if (options?.currentRevisionId) params.set("current_revision_id", options.currentRevisionId);
  if (typeof options?.includeLiveAnchor === "boolean") {
    params.set("include_live_anchor", options.includeLiveAnchor ? "true" : "false");
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/revisions/${revisionId}/documents${query}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) await throwApiError(res, "Unable to load revision documents");
  const totalHeader = Number.parseInt(res.headers.get("content-length") || "", 10);
  const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  if (!res.body) {
    const payload = (await res.json()) as RevisionDocumentsResponse;
    onProgress?.({ loadedBytes: totalBytes ?? 1, totalBytes });
    return payload;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  onProgress?.({ loadedBytes: 0, totalBytes });
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (!next.value) continue;
    loadedBytes += next.value.byteLength;
    chunks.push(next.value);
    onProgress?.({ loadedBytes, totalBytes });
  }
  const fullBytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    fullBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const jsonText = new TextDecoder().decode(fullBytes);
  return JSON.parse(jsonText) as RevisionDocumentsResponse;
}

export async function listProjectAssets(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/assets`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ assets: ProjectAsset[] }>(res, "Unable to list assets");
}

const PROJECT_ASSET_CONTENT_CACHE = "typst.project.asset.content.v1";

function assetContentVersionKey(asset: {
  id: string;
  object_key: string;
  created_at: string;
  size_bytes: number;
  content_type: string;
}) {
  return `${asset.id}:${asset.object_key}:${asset.created_at}:${asset.size_bytes}:${asset.content_type}`;
}

function projectAssetRawUrl(projectId: string, asset: {
  id: string;
  object_key: string;
  created_at: string;
  size_bytes: number;
  content_type: string;
}) {
  const params = new URLSearchParams({
    v: assetContentVersionKey(asset)
  });
  return apiUrl(`/v1/projects/${projectId}/assets/${asset.id}/raw?${params.toString()}`);
}

function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    const end = Math.min(data.length, i + chunk);
    let part = "";
    for (let j = i; j < end; j += 1) {
      part += String.fromCharCode(data[j]);
    }
    binary += part;
  }
  return btoa(binary);
}

async function getCachedAssetBytes(url: string): Promise<Uint8Array | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(PROJECT_ASSET_CONTENT_CACHE);
    const cached = await cache.match(url);
    if (!cached) return null;
    const bytes = new Uint8Array(await cached.arrayBuffer());
    return bytes;
  } catch {
    return null;
  }
}

async function putCachedAssetBytes(url: string, bytes: Uint8Array, contentType: string) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(PROJECT_ASSET_CONTENT_CACHE);
    const body = new Blob([new Uint8Array(bytes).buffer], {
      type: contentType || "application/octet-stream"
    });
    await cache.put(
      url,
      new Response(body, {
        headers: {
          "content-type": contentType || "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable"
        }
      })
    );
  } catch {
    // cache storage is best-effort
  }
}

export async function getProjectAssetContentCached(projectId: string, asset: ProjectAsset) {
  const url = projectAssetRawUrl(projectId, asset);
  const cachedBytes = await getCachedAssetBytes(url);
  if (cachedBytes) {
    return {
      asset,
      content_base64: uint8ToBase64(cachedBytes)
    } satisfies ProjectAssetContent;
  }
  const res = await fetch(url, {
    credentials: authCredentials(),
    headers: authHeaders(),
    cache: "no-store"
  });
  if (!res.ok) await throwApiError(res, "Unable to load asset");
  const bytes = new Uint8Array(await res.arrayBuffer());
  await putCachedAssetBytes(url, bytes, asset.content_type);
  return {
    asset,
    content_base64: uint8ToBase64(bytes)
  } satisfies ProjectAssetContent;
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

export async function updateProjectTemplate(projectId: string, isTemplate: boolean) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/template`), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ is_template: isTemplate })
  });
  return parseJsonOrThrow<ProjectTemplateState>(res, "Unable to update template state");
}

export async function downloadProjectArchive(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/archive`), {
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!res.ok) await throwApiError(res, "Unable to download archive");
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
  if (!res.ok) await throwApiError(res, "Unable to revoke token");
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
  input: { group_name: string; role: OrganizationMembershipRole | string }
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
  if (!res.ok) await throwApiError(res, "Unable to delete mapping");
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

export async function canAccessAdminPanel() {
  const res = await fetch(apiUrl("/v1/admin/settings/auth"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) await throwApiError(res, "Unable to validate admin access");
  return true;
}

export async function upsertAdminAuthSettings(input: {
  allow_local_login: boolean;
  allow_local_registration: boolean;
  allow_oidc: boolean;
  anonymous_mode?: "off" | "read_only" | "read_write_named" | string;
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
  if (!res.ok) await throwApiError(res, "Unable to revoke share link");
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

export async function listProjectTemplateOrganizationAccess(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/template-organization-access`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectTemplateOrganizationAccess[]>(
    res,
    "Unable to list template organizations"
  );
}

export async function upsertProjectTemplateOrganizationAccess(projectId: string, organizationId: string) {
  const res = await fetch(
    apiUrl(`/v1/projects/${projectId}/template-organization-access/${organizationId}`),
    {
      method: "PUT",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  return parseJsonOrThrow<ProjectTemplateOrganizationAccess>(
    res,
    "Unable to grant template organization access"
  );
}

export async function deleteProjectTemplateOrganizationAccess(projectId: string, organizationId: string) {
  const res = await fetch(
    apiUrl(`/v1/projects/${projectId}/template-organization-access/${organizationId}`),
    {
      method: "DELETE",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  if (!res.ok) await throwApiError(res, "Unable to revoke template organization access");
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
  if (!res.ok) await throwApiError(res, "Unable to remove organization access");
}

export async function listProjectAccessUsers(projectId: string) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/access-users`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<{ users: ProjectAccessUser[] }>(res, "Unable to list access users");
}

export function projectThumbnailUrl(projectId: string, versionHint?: string) {
  const base = apiUrl(`/v1/projects/${projectId}/thumbnail`);
  if (!versionHint) return base;
  const safe = encodeURIComponent(versionHint);
  return `${base}${base.includes("?") ? "&" : "?"}v=${safe}`;
}

export async function uploadProjectThumbnail(
  projectId: string,
  input: { content_base64: string; content_type?: string }
) {
  const res = await fetch(apiUrl(`/v1/projects/${projectId}/thumbnail`), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!res.ok) await throwApiError(res, "Unable to upload project thumbnail");
}

export async function joinProjectShareLink(token: string) {
  const res = await fetch(apiUrl(`/v1/share/${encodeURIComponent(token)}/join`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<JoinProjectShareLinkResponse>(res, "Unable to join shared project");
}

export async function resolveProjectShareLink(token: string) {
  const res = await fetch(apiUrl(`/v1/share/${encodeURIComponent(token)}/resolve`), {
    credentials: authCredentials(),
    headers: authHeaders(),
    cache: "no-store"
  });
  return parseJsonOrThrow<ResolveProjectShareLinkResponse>(
    res,
    "Unable to resolve shared project"
  );
}

export async function temporaryShareLogin(token: string, displayName: string) {
  const res = await fetch(apiUrl(`/v1/share/${encodeURIComponent(token)}/temporary-login`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ display_name: displayName })
  });
  return parseJsonOrThrow<TemporaryShareLoginResponse>(
    res,
    "Unable to start temporary guest session"
  );
}
