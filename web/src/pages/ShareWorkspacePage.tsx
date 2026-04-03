import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  joinProjectShareLink,
  resolveProjectShareLink,
  type AuthConfig,
  type AuthUser,
  type OrganizationMembership,
  type Project
} from "@/lib/api";
import { SignInPage } from "@/pages/SignInPage";
import { WorkspacePage } from "@/pages/WorkspacePage";

type ShareWorkspacePageProps = {
  authUser: AuthUser | null;
  authConfig: AuthConfig | null;
  projects: Project[];
  organizations: OrganizationMembership[];
  refreshProjects: () => Promise<void>;
  t: (key: string) => string;
  onTopbarChange: (content: ReactNode | null) => void;
  onSignedIn: () => Promise<void>;
  onLogoutFromWorkspace: () => Promise<void>;
};

export function ShareWorkspacePage({
  authUser,
  authConfig,
  projects,
  organizations,
  refreshProjects,
  t,
  onTopbarChange,
  onSignedIn,
  onLogoutFromWorkspace
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
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const alreadySavedToProjects = useMemo(
    () => !!resolved && projects.some((project) => project.id === resolved.projectId),
    [projects, resolved]
  );

  useEffect(() => {
    if (!authUser || !resolved) return;
    if (alreadySavedToProjects) {
      setSaveStatus("saved");
      setSaveError(null);
      return;
    }
    setSaveStatus((current) => (current === "saved" ? "saved" : "idle"));
  }, [alreadySavedToProjects, authUser, resolved]);

  useEffect(() => {
    if (!authUser || !resolved) return;
    if (alreadySavedToProjects) return;
    if (saveStatus !== "idle") return;
    saveSharedProjectToList().catch(() => undefined);
  }, [alreadySavedToProjects, authUser, resolved, saveStatus]);

  async function saveSharedProjectToList() {
    if (!resolved) return;
    if (saveStatus === "saving") return;
    try {
      setSaveStatus("saving");
      setSaveError(null);
      await joinProjectShareLink(token);
      await refreshProjects();
      setSaveStatus("saved");
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : t("share.joinFailed"));
    }
  }

  const pseudoProject = useMemo<Project[]>(
    () =>
      resolved
        ? [
            {
              id: resolved.projectId,
              name: resolved.projectName,
              project_type: "typst",
              latex_engine: null,
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

  if (authUser && resolved && !alreadySavedToProjects && saveStatus !== "saved") {
    return (
      <section className="page">
        <div className="card">
          <strong>{saveStatus === "saving" ? t("share.joining") : t("share.saveToProjectsPrompt")}</strong>
          {saveError && <div className="error">{saveError}</div>}
          {saveStatus !== "saving" && (
            <button
              className="ui-button ui-primary"
              onClick={() => {
                saveSharedProjectToList().catch(() => undefined);
              }}
            >
              {t("share.saveToProjects")}
            </button>
          )}
        </div>
      </section>
    );
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
      shareSaveStatus={saveStatus}
      shareSaveError={saveError}
      onSaveSharedProject={saveSharedProjectToList}
      onSignInFromWorkspace={onSignedIn}
      onLogoutFromWorkspace={onLogoutFromWorkspace}
    />
  );
}
