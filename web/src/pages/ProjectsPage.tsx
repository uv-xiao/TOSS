import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, ArrowRight, Copy, Plus } from "lucide-react";
import { UiBadge, UiButton, UiCard, UiDialog, UiIconButton, UiInput } from "@/components/ui";
import {
  copyProject,
  createProject,
  projectThumbnailUrl,
  setProjectArchived,
  type OrganizationMembership,
  type Project
} from "@/lib/api";
import type { ProjectCopyDialogState } from "@/types/project-ui";

function formatRelativeTime(iso: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const diffMs = Date.now() - at;
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  const rawValue =
    abs < hour
      ? Math.round(abs / minute)
      : abs < day
        ? Math.round(abs / hour)
        : abs < week
          ? Math.round(abs / day)
          : abs < month
            ? Math.round(abs / week)
            : abs < year
              ? Math.round(abs / month)
              : Math.round(abs / year);
  const value = Math.max(1, rawValue);
  const unit =
    abs < hour
      ? "minute"
      : abs < day
        ? "hour"
        : abs < week
          ? "day"
          : abs < month
            ? "week"
            : abs < year
              ? "month"
              : "year";
  const locale = window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto"
  });
  return formatter.format(diffMs >= 0 ? -value : value, unit as Intl.RelativeTimeFormatUnit);
}

export function ProjectsPage({
  projects,
  organizations,
  refreshProjects,
  t
}: {
  projects: Project[];
  organizations: OrganizationMembership[];
  refreshProjects: () => Promise<void>;
  t: (key: string) => string;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [copyDialog, setCopyDialog] = useState<ProjectCopyDialogState | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [brokenThumbnailIds, setBrokenThumbnailIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const filteredProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return projects
      .filter((project) => (view === "archived" ? project.archived : !project.archived))
      .filter((project) => {
        if (!keyword) return true;
        return (
          project.name.toLowerCase().includes(keyword) ||
          project.owner_display_name.toLowerCase().includes(keyword)
        );
      })
      .sort((a, b) => Date.parse(b.last_edited_at) - Date.parse(a.last_edited_at));
  }, [projects, search, view]);

  useEffect(() => {
    setBrokenThumbnailIds((previous) => {
      const allowed = new Set(projects.map((project) => project.id));
      const next = new Set<string>();
      for (const id of previous) {
        if (allowed.has(id)) next.add(id);
      }
      return next;
    });
  }, [projects]);

  async function createFromCopy() {
    if (!copyDialog || !copyDialog.suggestedName.trim()) return;
    try {
      setCopyBusy(true);
      setError(null);
      const created = await copyProject(copyDialog.projectId, { name: copyDialog.suggestedName.trim() });
      setCopyDialog(null);
      await refreshProjects();
      navigate(`/project/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.copyFailed"));
    } finally {
      setCopyBusy(false);
    }
  }

  function openProject(project: Project) {
    if (project.is_template) {
      setCopyDialog({
        projectId: project.id,
        sourceName: project.name,
        suggestedName: `${project.name} ${t("projects.copySuffix")}`
      });
      return;
    }
    navigate(`/project/${project.id}`);
  }

  return (
    <section className="page projects-page">
      <div className="projects-title-row">
        <h2>{t("projects.title")}</h2>
      </div>
      <UiCard className="projects-create-bar">
        <strong>{t("projects.createTitle")}</strong>
        <div className="projects-create-controls">
          <UiInput value={name} onChange={(e) => setName(e.target.value)} placeholder={t("projects.namePlaceholder")} />
          <UiButton
            variant="primary"
            onClick={async () => {
              if (!name.trim()) return;
              try {
                setError(null);
                await createProject({ name: name.trim() });
                setName("");
                await refreshProjects();
              } catch (err) {
                const message = err instanceof Error ? err.message : "Unable to create project";
                setError(message);
              }
            }}
          >
            <Plus size={16} />
            <span>{t("projects.createAction")}</span>
          </UiButton>
        </div>
      </UiCard>
      <UiCard className="projects-controls">
        <UiInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("projects.searchPlaceholder")}
          aria-label={t("projects.searchPlaceholder")}
        />
        <div className="toolbar compact-left">
          <UiButton variant={view === "active" ? "primary" : "secondary"} onClick={() => setView("active")}>
            {t("projects.active")}
          </UiButton>
          <UiButton variant={view === "archived" ? "primary" : "secondary"} onClick={() => setView("archived")}>
            {t("projects.archived")}
          </UiButton>
        </div>
      </UiCard>
      <UiCard className="projects-table-shell">
        <div className="projects-grid-header">
          <span>{t("projects.tableTitle")}</span>
          <span>{t("projects.tableOwner")}</span>
          <span>{t("projects.tableLastEdited")}</span>
          <span>{t("projects.tableActions")}</span>
        </div>
        <div className="projects-list">
          {filteredProjects.map((project) => (
            <div className="projects-row" key={project.id}>
              <button className="project-title-cell" onClick={() => openProject(project)}>
                {project.has_thumbnail && !brokenThumbnailIds.has(project.id) ? (
                  <img
                    className="project-thumb loaded"
                    src={projectThumbnailUrl(project.id)}
                    alt={project.name}
                    loading="lazy"
                    onError={() =>
                      setBrokenThumbnailIds((previous) => {
                        const next = new Set(previous);
                        next.add(project.id);
                        return next;
                      })
                    }
                  />
                ) : (
                  <div className="project-thumb placeholder" aria-hidden />
                )}
                <div className="project-main">
                  <strong>{project.name}</strong>
                  <div className="project-tags">
                    {project.is_template && <UiBadge tone="accent">{t("projects.templateBadge")}</UiBadge>}
                    {!project.can_read && <UiBadge tone="warning">{t("projects.templateUseOnly")}</UiBadge>}
                  </div>
                </div>
              </button>
              <span>{project.owner_display_name}</span>
              <span title={new Date(project.last_edited_at).toLocaleString()}>
                {formatRelativeTime(project.last_edited_at)}
              </span>
              <div className="projects-row-actions">
                <UiIconButton
                  tooltip={project.is_template ? t("projects.useTemplate") : t("projects.open")}
                  label={project.is_template ? t("projects.useTemplate") : t("projects.open")}
                  onClick={() => openProject(project)}
                >
                  {project.is_template ? <Copy size={16} /> : <ArrowRight size={16} />}
                </UiIconButton>
                <UiIconButton
                  tooltip={t("projects.copy")}
                  label={t("projects.copy")}
                  onClick={() =>
                    setCopyDialog({
                      projectId: project.id,
                      sourceName: project.name,
                      suggestedName: `${project.name} ${t("projects.copySuffix")}`
                    })
                  }
                >
                  <Copy size={16} />
                </UiIconButton>
                <UiIconButton
                  tooltip={project.archived ? t("projects.unarchive") : t("projects.archive")}
                  label={project.archived ? t("projects.unarchive") : t("projects.archive")}
                  disabled={busyProjectId === project.id}
                  onClick={async () => {
                    try {
                      setError(null);
                      setBusyProjectId(project.id);
                      await setProjectArchived(project.id, !project.archived);
                      await refreshProjects();
                    } catch (err) {
                      const message =
                        err instanceof Error
                          ? err.message
                          : project.archived
                            ? "Unable to unarchive project"
                            : "Unable to archive project";
                      setError(message);
                    } finally {
                      setBusyProjectId(null);
                    }
                  }}
                >
                  <Archive size={16} />
                </UiIconButton>
              </div>
            </div>
          ))}
          {filteredProjects.length === 0 && <div className="projects-empty">{t("projects.empty")}</div>}
        </div>
      </UiCard>
      <UiCard className="projects-org-memberships">
        <strong>{t("projects.organizations")}</strong>
        <div className="projects-org-list">
          {organizations.length > 0 ? (
            organizations.map((org) => (
              <span key={org.organization_id} className="org-pill">
                {org.organization_name}
              </span>
            ))
          ) : (
            <span className="muted">{t("projects.noOrganizations")}</span>
          )}
        </div>
      </UiCard>
      <UiDialog
        open={!!copyDialog}
        title={t("projects.copyDialogTitle")}
        description={copyDialog ? `${t("projects.copyDialogHint")} ${copyDialog.sourceName}` : undefined}
        onClose={() => setCopyDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setCopyDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton variant="primary" onClick={createFromCopy} disabled={copyBusy || !copyDialog?.suggestedName.trim()}>
              {copyBusy ? t("projects.copying") : t("projects.copyAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          value={copyDialog?.suggestedName ?? ""}
          onChange={(e) =>
            setCopyDialog((current) =>
              current
                ? {
                    ...current,
                    suggestedName: e.target.value
                  }
                : current
            )
          }
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>
      {error && <div className="error">{error}</div>}
    </section>
  );
}

