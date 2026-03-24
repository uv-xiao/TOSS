import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { UiButton } from "@/components/ui";
import {
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
import { ShareJoinPage } from "@/pages/ShareJoinPage";
import { SignInPage } from "@/pages/SignInPage";
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
  const [error, setError] = useState<string | null>(null);
  const [workspaceTopbar, setWorkspaceTopbar] = useState<ReactNode | null>(null);

  const onWorkspaceRoute = location.pathname.startsWith("/project/");
  const onProjectsRoute = location.pathname === "/projects" || location.pathname === "/";
  const onProfileRoute = location.pathname.startsWith("/profile");
  const onAdminRoute = location.pathname.startsWith("/admin");
  const hasOrgAdminAccess = organizations.some((org) => org.is_admin);
  const shareTokenFromPath = location.pathname.startsWith("/share/")
    ? decodeURIComponent(location.pathname.replace("/share/", ""))
    : null;
  const t = useMemo(() => (key: string) => translate(locale, key), [locale]);

  useEffect(() => {
    if (!shareTokenFromPath) return;
    window.sessionStorage.setItem("share.token.pending", shareTokenFromPath);
  }, [shareTokenFromPath]);

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
      return;
    }
    Promise.all([listProjects({ includeArchived: true }), listMyOrganizations()])
      .then(([res, orgs]) => {
        setProjects(res.projects);
        setOrganizations(orgs.organizations);
        setError(null);
      })
      .catch((err) => {
        setProjects([]);
        setOrganizations([]);
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
    const [next, orgs] = await Promise.all([listProjects({ includeArchived: true }), listMyOrganizations()]);
    setProjects(next.projects);
    setOrganizations(orgs.organizations);
  }

  if (authLoading) return <main className="loading">Loading...</main>;

  if (!authUser) {
    return (
      <SignInPage
        config={authConfig}
        t={t}
        onSignedIn={async () => {
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
        }}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className={`topbar ${onWorkspaceRoute ? "workspace" : ""}`}>
        <strong className="topbar-brand">{siteName}</strong>
        {onWorkspaceRoute && (
          <UiButton className="tab" onClick={() => navigate("/projects")}>
            {t("nav.backToProjects")}
          </UiButton>
        )}
        <div className="topbar-workspace-slot">{onWorkspaceRoute ? workspaceTopbar : null}</div>
        <div className="meta">
          {!onWorkspaceRoute && (
            <>
              <Link className={`ui-button ui-secondary ui-md tab ${onProjectsRoute ? "active" : ""}`} to="/projects">
                {t("nav.projects")}
              </Link>
              <Link className={`ui-button ui-secondary ui-md tab ${onProfileRoute ? "active" : ""}`} to="/profile">
                {t("nav.profile")}
              </Link>
              {hasOrgAdminAccess && (
                <Link className={`ui-button ui-secondary ui-md tab ${onAdminRoute ? "active" : ""}`} to="/admin">
                  {t("nav.admin")}
                </Link>
              )}
            </>
          )}
          <span>{authUser.display_name}</span>
          <UiButton onClick={handleLogout}>{t("nav.logout")}</UiButton>
        </div>
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
                refreshProjects={refreshProjects}
                t={t}
                onTopbarChange={setWorkspaceTopbar}
              />
            }
          />
          <Route path="/share/:token" element={<ShareJoinPage t={t} onJoin={async (token) => joinProjectShareLink(token)} />} />
          <Route path="/admin" element={<AdminPage t={t} />} />
          <Route path="/profile" element={<ProfilePage t={t} />} />
        </Routes>
      </section>
    </main>
  );
}

