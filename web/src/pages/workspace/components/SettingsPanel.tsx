import { UiButton, UiSelect } from "@/components/ui";
import type {
  OrganizationMembership,
  ProjectAccessUser,
  ProjectOrganizationAccess,
  ProjectShareLink
} from "@/lib/api";

type ShareLinkCardProps = {
  title: string;
  activeShare: ProjectShareLink | null;
  canManageProject: boolean;
  copiedControl: string | null;
  copyControlKey: string;
  windowOrigin: string;
  onCreate: () => Promise<void>;
  onRevoke: (shareLinkId: string) => Promise<void>;
  onCopyToClipboard: (controlKey: string, value: string) => Promise<void>;
  t: (key: string) => string;
};

function ShareLinkCard({
  title,
  activeShare,
  canManageProject,
  copiedControl,
  copyControlKey,
  windowOrigin,
  onCreate,
  onRevoke,
  onCopyToClipboard,
  t
}: ShareLinkCardProps) {
  const linkValue = activeShare?.token_value ? `${windowOrigin}/share/${activeShare.token_value}` : "";
  return (
    <div className="card">
      <strong>{title}</strong>
      {canManageProject && (
        <div className="toolbar compact-left">
          {activeShare ? (
            <UiButton onClick={() => onRevoke(activeShare.id)}>{t("common.disable")}</UiButton>
          ) : (
            <UiButton onClick={onCreate}>{t("common.enable")}</UiButton>
          )}
        </div>
      )}
      {linkValue ? (
        <>
          <code>{linkValue}</code>
          <UiButton onClick={() => onCopyToClipboard(copyControlKey, linkValue)}>
            {copiedControl === copyControlKey ? t("share.copied") : t("share.copy")}
          </UiButton>
        </>
      ) : (
        <small>{t("share.none")}</small>
      )}
    </div>
  );
}

export function SettingsPanel({
  width,
  projectId,
  projectType,
  latexEngine,
  entryFilePath,
  typEntryOptions,
  canManageProject,
  canViewWriteShareLink,
  gitRepoUrl,
  copiedControl,
  templateEnabled,
  myOrganizations,
  projectOrgAccess,
  projectAccessUsers,
  onEntryFileChange,
  onLatexEngineChange,
  onCopyToClipboard,
  onToggleTemplate,
  activeReadShare,
  activeWriteShare,
  onCreateShare,
  onRevokeShare,
  onGrantOrgAccess,
  onRevokeOrgAccess,
  formatAccessType,
  formatRoleLabel,
  formatAccessSource,
  t
}: {
  width: number;
  projectId: string;
  projectType: "typst" | "latex";
  latexEngine: "pdftex" | "xetex";
  entryFilePath: string;
  typEntryOptions: string[];
  canManageProject: boolean;
  canViewWriteShareLink: boolean;
  gitRepoUrl: string;
  copiedControl: string | null;
  templateEnabled: boolean;
  myOrganizations: OrganizationMembership[];
  projectOrgAccess: ProjectOrganizationAccess[];
  projectAccessUsers: ProjectAccessUser[];
  onEntryFileChange: (path: string) => Promise<void>;
  onLatexEngineChange: (engine: "pdftex" | "xetex") => Promise<void>;
  onCopyToClipboard: (controlKey: string, value: string) => Promise<void>;
  onToggleTemplate: () => Promise<void>;
  activeReadShare: ProjectShareLink | null;
  activeWriteShare: ProjectShareLink | null;
  onCreateShare: (permission: "read" | "write") => Promise<void>;
  onRevokeShare: (shareLinkId: string) => Promise<void>;
  onGrantOrgAccess: (organizationId: string, permission: "read" | "write") => Promise<void>;
  onRevokeOrgAccess: (organizationId: string) => Promise<void>;
  formatAccessType: (accessType: string, role: string) => string;
  formatRoleLabel: (role: string) => string;
  formatAccessSource: (source: string) => string;
  t: (key: string) => string;
}) {
  const windowOrigin = window.location.origin;
  return (
    <aside className="panel panel-settings" style={{ width }}>
      <div className="panel-header">
        <h2>{t("workspace.settings")}</h2>
      </div>
      <div className="panel-content">
        <div className="settings-section">
          <strong>{t("settings.compilation")}</strong>
          <label>
            {t("settings.projectType")}
            <UiSelect value={projectType} disabled>
              <option value="typst">{t("settings.projectTypeTypst")}</option>
              <option value="latex">{t("settings.projectTypeLatex")}</option>
            </UiSelect>
          </label>
          {projectType === "latex" && (
            <label>
              {t("settings.latexEngine")}
              <UiSelect
                value={latexEngine}
                onChange={async (e) => {
                  const value = e.target.value === "pdftex" ? "pdftex" : "xetex";
                  await onLatexEngineChange(value);
                }}
                disabled={!canManageProject}
              >
                <option value="xetex">XeTeX</option>
                <option value="pdftex">pdfTeX</option>
              </UiSelect>
            </label>
          )}
          <label>
            {t("settings.entryFile")}
            <UiSelect
              value={entryFilePath}
              onChange={async (e) => {
                const next = e.target.value.trim();
                if (!next) return;
                await onEntryFileChange(next);
              }}
              disabled={!canManageProject}
            >
              {typEntryOptions.map((path) => (
                <option value={path} key={path}>
                  {path}
                </option>
              ))}
            </UiSelect>
          </label>
          <small>{t("settings.entryFileHint")}</small>
        </div>
        <div className="settings-section">
          <strong>{t("settings.gitAccess")}</strong>
          <code>{gitRepoUrl || t("common.loading")}</code>
          <div className="toolbar compact-left">
            <UiButton
              size="sm"
              onClick={() => onCopyToClipboard("git-access-url", gitRepoUrl)}
              disabled={!gitRepoUrl}
            >
              {copiedControl === "git-access-url" ? t("share.copied") : t("share.copy")}
            </UiButton>
          </div>
          <small>{t("settings.gitHint")}</small>
        </div>
        <div className="settings-section">
          <strong>{t("settings.templateTitle")}</strong>
          <div className="toolbar compact-left">
            <UiButton variant={templateEnabled ? "primary" : "secondary"} onClick={onToggleTemplate} disabled={!canManageProject}>
              {templateEnabled ? t("settings.templateEnabled") : t("settings.templateDisabled")}
            </UiButton>
          </div>
          <small>{t("settings.templateHint")}</small>
        </div>
        <div className="settings-section">
          <strong>{t("share.title")}</strong>
          <div className="settings-share-grid">
            <ShareLinkCard
              title={t("share.readLink")}
              activeShare={activeReadShare}
              canManageProject={canManageProject}
              copiedControl={copiedControl}
              copyControlKey="share-read-link"
              windowOrigin={windowOrigin}
              onCreate={() => onCreateShare("read")}
              onRevoke={onRevokeShare}
              onCopyToClipboard={onCopyToClipboard}
              t={t}
            />
            {canViewWriteShareLink && (
              <ShareLinkCard
                title={t("share.writeLink")}
                activeShare={activeWriteShare}
                canManageProject={canManageProject}
                copiedControl={copiedControl}
                copyControlKey="share-write-link"
                windowOrigin={windowOrigin}
                onCreate={() => onCreateShare("write")}
                onRevoke={onRevokeShare}
                onCopyToClipboard={onCopyToClipboard}
                t={t}
              />
            )}
          </div>
        </div>
        <div className="settings-section">
          <strong>{t("settings.organizationAccess")}</strong>
          {myOrganizations.length > 0 ? (
            <div className="card-list">
              {myOrganizations.map((org) => {
                const existing = projectOrgAccess.find((item) => item.organization_id === org.organization_id);
                return (
                  <div className="card" key={org.organization_id}>
                    <strong>{org.organization_name}</strong>
                    <UiSelect
                      value={existing?.permission ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === "read" || value === "write") {
                          onGrantOrgAccess(org.organization_id, value);
                        } else {
                          onRevokeOrgAccess(org.organization_id);
                        }
                      }}
                      disabled={!canManageProject}
                    >
                      <option value="">{t("settings.noAccess")}</option>
                      <option value="read">{t("settings.readOnly")}</option>
                      <option value="write">{t("settings.readWrite")}</option>
                    </UiSelect>
                  </div>
                );
              })}
            </div>
          ) : (
            <small>{t("projects.noOrganizations")}</small>
          )}
        </div>
        <div className="settings-section">
          <strong>{t("settings.projectUsers")}</strong>
          {projectAccessUsers.length > 0 ? (
            <div className="card-list">
              {projectAccessUsers.map((user) => (
                <div className="card" key={`${projectId}-${user.user_id}`}>
                  <strong>{user.display_name || user.email}</strong>
                  <span>{user.email}</span>
                  <span>{`${t("settings.accessType")}: ${formatAccessType(user.access_type, user.role)}`}</span>
                  <span>{`${t("settings.role")}: ${formatRoleLabel(user.role)}`}</span>
                  <span>{`${t("settings.source")}: ${user.sources.map((source) => formatAccessSource(source)).join(", ")}`}</span>
                </div>
              ))}
            </div>
          ) : (
            <small>{t("settings.noUsers")}</small>
          )}
        </div>
      </div>
    </aside>
  );
}
