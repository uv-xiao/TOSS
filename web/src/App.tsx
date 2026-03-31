import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { UiButton } from "@/components/ui";
import {
  canAccessAdminPanel,
  clearShareAccessContext,
  getAuthConfig,
  getAuthMe,
  joinProjectShareLink,
  listMyOrganizations,
  listProjects,
  logout,
  type AuthConfig,
  type AuthUser,
  type OrganizationMembership,
  type Project
} from "@/lib/api";
import { readStoredLocale, translate, type UiLocale } from "@/lib/i18n";
import { AdminPage } from "@/pages/AdminPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { SignInPage } from "@/pages/SignInPage";
import { ShareWorkspacePage } from "@/pages/ShareWorkspacePage";
import { WorkspacePage } from "@/pages/WorkspacePage";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [authLoading, setAuthLoading] = useState(true);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const locale: UiLocale = useMemo(() => readStoredLocale(), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationMembership[]>([]);
  const [hasAdminAccess, setHasAdminAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceTopbar, setWorkspaceTopbar] = useState<ReactNode | null>(null);

  const onWorkspaceRoute =
    location.pathname.startsWith("/project/") || location.pathname.startsWith("/share/");
  const onShareRoute = location.pathname.startsWith("/share/");
  const onProjectsRoute = location.pathname === "/projects" || location.pathname === "/";
  const onProfileRoute = location.pathname.startsWith("/profile");
  const onAdminRoute = location.pathname.startsWith("/admin");
  const shareTokenFromPath = location.pathname.startsWith("/share/")
    ? decodeURIComponent(location.pathname.replace("/share/", ""))
    : null;
  const t = useMemo(() => (key: string) => translate(locale, key), [locale]);

  useEffect(() => {
    if (!shareTokenFromPath) return;
    window.sessionStorage.setItem("share.token.pending", shareTokenFromPath);
  }, [shareTokenFromPath]);

  useEffect(() => {
    if (!onShareRoute) {
      clearShareAccessContext();
    }
  }, [onShareRoute]);

  useEffect(() => {
    Promise.all([getAuthConfig(), getAuthMe()])
      .then(([cfg, me]) => {
        setAuthConfig(cfg);
        setAuthUser(me);
      })
      .catch(() => {
        setAuthConfig(null);
        setAuthUser(null);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!authUser) {
      setProjects([]);
      setOrganizations([]);
      setHasAdminAccess(false);
      return;
    }
    Promise.all([
      listProjects({ includeArchived: true }),
      listMyOrganizations(),
      canAccessAdminPanel().catch(() => false)
    ])
      .then(([res, orgs, adminAccess]) => {
        setProjects(res.projects);
        setOrganizations(orgs.organizations);
        setHasAdminAccess(adminAccess);
        setError(null);
      })
      .catch((err) => {
        setProjects([]);
        setOrganizations([]);
        setHasAdminAccess(false);
        setError(err instanceof Error ? err.message : "Unable to load projects");
      });
  }, [authUser?.user_id]);

  useEffect(() => {
    if (!onWorkspaceRoute && workspaceTopbar) {
      setWorkspaceTopbar(null);
    }
  }, [onWorkspaceRoute, workspaceTopbar]);

  const firstProject = projects.find((project) => !project.archived)?.id ?? projects[0]?.id;
  const siteName = authConfig?.site_name?.trim() || t("brand.name");

  async function handleLogout() {
    await logout();
    setAuthUser(null);
    setProjects([]);
    setOrganizations([]);
  }

  async function refreshProjects() {
    if (!authUser) return;
    const [next, orgs, adminAccess] = await Promise.all([
      listProjects({ includeArchived: true }),
      listMyOrganizations(),
      canAccessAdminPanel().catch(() => false)
    ]);
    setProjects(next.projects);
    setOrganizations(orgs.organizations);
    setHasAdminAccess(adminAccess);
  }

  if (authLoading) return <main className="loading">Loading...</main>;

  const completeSignIn = async () => {
    const me = await getAuthMe();
    setAuthUser(me);
    await refreshProjects();
    const pendingShare = shareTokenFromPath || window.sessionStorage.getItem("share.token.pending");
    if (pendingShare) {
      window.sessionStorage.removeItem("share.token.pending");
      try {
        const joined = await joinProjectShareLink(pendingShare);
        await refreshProjects();
        navigate(`/project/${joined.project_id}`, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : t("share.joinFailed"));
      }
    }
  };

  if (!authUser && !onShareRoute) {
    return (
      <SignInPage
        config={authConfig}
        t={t}
        onSignedIn={completeSignIn}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className={`topbar ${onWorkspaceRoute ? "workspace" : ""}`}>
        <strong className="topbar-brand">{siteName}</strong>
        {onWorkspaceRoute && (
          <UiButton className="tab topbar-back-btn" onClick={() => navigate("/projects")} aria-label={t("nav.backToProjects")}>
            <ArrowLeft className="topbar-back-icon" size={14} aria-hidden />
            <span className="topbar-back-label">{t("nav.backToProjects")}</span>
          </UiButton>
        )}
        {onWorkspaceRoute ? (
          <div className="topbar-workspace-slot workspace-slot-layout">
            <div className="workspace-slot-center">{workspaceTopbar}</div>
            <div className="meta workspace-meta">
              {authUser ? (
                <>
                  <span>{authUser.display_name}</span>
                  <UiButton onClick={handleLogout}>{t("nav.logout")}</UiButton>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="meta">
            {!!authUser && (
              <>
                <Link className={`ui-button ui-secondary ui-md tab ${onProjectsRoute ? "active" : ""}`} to="/projects">
                  {t("nav.projects")}
                </Link>
                <Link className={`ui-button ui-secondary ui-md tab ${onProfileRoute ? "active" : ""}`} to="/profile">
                  {t("nav.profile")}
                </Link>
                {hasAdminAccess && (
                  <Link className={`ui-button ui-secondary ui-md tab ${onAdminRoute ? "active" : ""}`} to="/admin">
                    {t("nav.admin")}
                  </Link>
                )}
              </>
            )}
            {authUser ? (
              <>
                <span>{authUser.display_name}</span>
                <UiButton onClick={handleLogout}>{t("nav.logout")}</UiButton>
              </>
            ) : null}
          </div>
        )}
      </header>
      {error && <div className="error-banner">{error}</div>}
      <section className="app-content">
        <Routes>
          <Route path="/" element={<Navigate to={firstProject ? `/project/${firstProject}` : "/projects"} replace />} />
          <Route
            path="/projects"
            element={
              <ProjectsPage
                projects={projects}
                organizations={organizations}
                refreshProjects={refreshProjects}
                t={t}
              />
            }
          />
          <Route
            path="/project/:projectId"
            element={
              <WorkspacePage
                projects={projects}
                organizations={organizations}
                authUser={authUser}
                authConfig={authConfig}
                refreshProjects={refreshProjects}
                t={t}
                onTopbarChange={setWorkspaceTopbar}
                onSignInFromWorkspace={completeSignIn}
              />
            }
          />
          <Route
            path="/share/:token"
            element={
              <ShareWorkspacePage
                authUser={authUser}
                authConfig={authConfig}
                organizations={organizations}
                refreshProjects={refreshProjects}
                t={t}
                onTopbarChange={setWorkspaceTopbar}
                onSignedIn={completeSignIn}
              />
            }
          />
          <Route path="/admin" element={<AdminPage t={t} />} />
          <Route path="/profile" element={<ProfilePage t={t} />} />
        </Routes>
      </section>
    </main>
  );
}
