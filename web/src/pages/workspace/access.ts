import type { Project, SharePermission } from "@/lib/api";

type DeriveWorkspacePermissionsInput = {
  isAnonymousShare: boolean;
  sharePermission: SharePermission | null;
  anonymousMode?: string | null;
  project: Project | undefined;
  hasGuestSessionToken: boolean;
  hasAuthUser: boolean;
};

type WorkspacePermissions = {
  canRequestGuestWrite: boolean;
  canWrite: boolean;
  canManageProject: boolean;
  canViewWriteShareLink: boolean;
  canViewShareLinks: boolean;
};

export function deriveWorkspacePermissions(input: DeriveWorkspacePermissionsInput): WorkspacePermissions {
  const {
    isAnonymousShare,
    sharePermission,
    anonymousMode,
    project,
    hasGuestSessionToken,
    hasAuthUser
  } = input;
  const canRequestGuestWrite =
    isAnonymousShare &&
    !project?.is_template &&
    sharePermission === "write" &&
    anonymousMode === "read_write_named" &&
    !hasGuestSessionToken;
  const canWrite = hasAuthUser
    ? project?.my_role !== "ReadOnly"
    : !project?.is_template &&
      sharePermission === "write" &&
      anonymousMode === "read_write_named" &&
      hasGuestSessionToken;
  const canManageProject = hasAuthUser ? project?.my_role === "Owner" : false;
  const canViewWriteShareLink = hasAuthUser
    ? project?.my_role === "Owner" || project?.my_role === "ReadWrite"
    : false;
  const canViewShareLinks = hasAuthUser && !isAnonymousShare;
  return {
    canRequestGuestWrite,
    canWrite: !!canWrite,
    canManageProject: !!canManageProject,
    canViewWriteShareLink: !!canViewWriteShareLink,
    canViewShareLinks
  };
}

export function formatAccessType(accessType: string, role: string) {
  if (accessType === "manage") return "Manage";
  if (accessType === "write") return "Read + write";
  if (accessType === "read") return "Read only";
  return role;
}

export function formatRoleLabel(role: string) {
  if (role === "ReadWrite") return "Read write";
  if (role === "ReadOnly") return "Read only";
  return role;
}

export function formatAccessSource(source: string) {
  if (source === "share_link_invite") return "Accepted share link";
  if (source === "direct_role") return "Direct assignment";
  if (source.startsWith("organization:")) {
    return `Organization (${source.slice("organization:".length)})`;
  }
  return source;
}
