import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { resolveProjectShareLink, type AuthConfig, type AuthUser, type OrganizationMembership, type Project } from "@/lib/api";
import { SignInPage } from "@/pages/SignInPage";
import { WorkspacePage } from "@/pages/WorkspacePage";

type ShareWorkspacePageProps = {
  authUser: AuthUser | null;
  authConfig: AuthConfig | null;
  organizations: OrganizationMembership[];
  refreshProjects: () => Promise<void>;
  t: (key: string) => string;
  onTopbarChange: (content: ReactNode | null) => void;
  onSignedIn: () => Promise<void>;
};

export function ShareWorkspacePage({
  authUser,
  authConfig,
  organizations,
  refreshProjects,
  t,
  onTopbarChange,
  onSignedIn
}: ShareWorkspacePageProps) {
  const { token = "" } = useParams();
  const [resolved, setResolved] = useState<{
    projectId: string;
    projectName: string;
    permission: "read" | "write";
    isTemplate: boolean;
    anonymousMode: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveProjectShareLink(token)
      .then((value) => {
        if (cancelled) return;
        setResolved({
          projectId: value.project_id,
          projectName: value.project_name,
          permission: value.permission,
          isTemplate: value.is_template,
          anonymousMode: value.anonymous_mode
        });
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("share.joinFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [t, token]);

  const pseudoProject = useMemo<Project[]>(
    () =>
      resolved
        ? [
            {
              id: resolved.projectId,
              name: resolved.projectName,
              owner_user_id: null,
              owner_display_name: "",
              my_role: resolved.permission === "write" ? "ReadWrite" : "ReadOnly",
              can_read: true,
              is_template: resolved.isTemplate,
              has_thumbnail: false,
              created_at: new Date(0).toISOString(),
              last_edited_at: new Date().toISOString(),
              archived: false,
              archived_at: null
            }
          ]
        : [],
    [resolved]
  );

  if (!resolved && !error) {
    return (
      <section className="page">
        <div className="card">{t("common.loading")}</div>
      </section>
    );
  }
  if (error || !resolved) {
    return (
      <section className="page">
        <div className="card">
          <strong>{t("share.joinFailed")}</strong>
          {error && <div className="error">{error}</div>}
        </div>
      </section>
    );
  }

  if (!authUser && resolved.anonymousMode === "off") {
    return <SignInPage config={authConfig} t={t} onSignedIn={onSignedIn} />;
  }

  return (
    <WorkspacePage
      projects={pseudoProject}
      organizations={organizations}
      authUser={authUser}
      authConfig={authConfig}
      refreshProjects={refreshProjects}
      t={t}
      onTopbarChange={onTopbarChange}
      projectIdOverride={resolved.projectId}
      shareToken={token}
      sharePermission={resolved.permission}
      anonymousMode={resolved.anonymousMode}
      onSignInFromWorkspace={onSignedIn}
    />
  );
}
