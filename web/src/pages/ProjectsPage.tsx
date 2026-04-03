import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, ArrowRight, Copy, Pencil, Plus } from "lucide-react";
import { UiBadge, UiButton, UiCard, UiDialog, UiIconButton, UiInput, UiSelect } from "@/components/ui";
import {
  copyProject,
  createProject,
  projectThumbnailUrl,
  renameProject,
  setProjectArchived,
  type OrganizationMembership,
  type Project
} from "@/lib/api";
import type { ProjectCopyDialogState, ProjectRenameDialogState } from "@/types/project-ui";

function ProjectThumbnail({
  project,
  t
}: {
  project: Project;
  t: (key: string) => string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    if (!project.has_thumbnail) {
      setSrc(null);
      return () => undefined;
    }
    const url = projectThumbnailUrl(project.id, project.last_edited_at);
    fetch(url, { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      })
      .then((next) => {
        if (cancelled) {
          if (next) URL.revokeObjectURL(next);
          return;
        }
        objectUrl = next || "";
        setSrc(next);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [project.has_thumbnail, project.id, project.last_edited_at]);

  if (!src) {
    return (
      <div className="project-thumb placeholder" aria-label={t("workspace.preview")}>
        PDF
      </div>
    );
  }

  return <img className="project-thumb loaded" src={src} alt={project.name} loading="lazy" />;
}

type ProjectRowProps = {
  project: Project;
  busyProjectId: string | null;
  onOpenProject: (project: Project) => void;
  onOpenRenameDialog: (project: Project) => void;
  onOpenCopyDialog: (project: Project) => void;
  onToggleProjectArchived: (project: Project) => Promise<void>;
  t: (key: string) => string;
};

function ProjectRow({
  project,
  busyProjectId,
  onOpenProject,
  onOpenRenameDialog,
  onOpenCopyDialog,
  onToggleProjectArchived,
  t
}: ProjectRowProps) {
  return (
    <div className="projects-row" key={project.id}>
      <button className="project-title-cell" onClick={() => onOpenProject(project)}>
        <ProjectThumbnail project={project} t={t} />
        <div className="project-main">
          <strong>{project.name}</strong>
          <div className="project-tags">
            <UiBadge tone={project.project_type === "latex" ? "accent" : "neutral"}>
              {project.project_type === "latex" ? t("settings.projectTypeLatex") : t("settings.projectTypeTypst")}
            </UiBadge>
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
          tooltip={t("projects.open")}
          label={t("projects.open")}
          onClick={() => onOpenProject(project)}
        >
          <ArrowRight size={16} />
        </UiIconButton>
        <UiIconButton
          tooltip={t("projects.rename")}
          label={t("projects.rename")}
          onClick={() => onOpenRenameDialog(project)}
        >
          <Pencil size={16} />
        </UiIconButton>
        <UiIconButton
          tooltip={t("projects.copy")}
          label={t("projects.copy")}
          onClick={() => onOpenCopyDialog(project)}
        >
          <Copy size={16} />
        </UiIconButton>
        <UiIconButton
          tooltip={project.archived ? t("projects.unarchive") : t("projects.archive")}
          label={project.archived ? t("projects.unarchive") : t("projects.archive")}
          disabled={busyProjectId === project.id}
          onClick={() => onToggleProjectArchived(project)}
        >
          <Archive size={16} />
        </UiIconButton>
      </div>
    </div>
  );
}

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

function updateRenameDialogName(
  value: string,
  setRenameDialog: Dispatch<SetStateAction<ProjectRenameDialogState | null>>
) {
  setRenameDialog((current) =>
    current
      ? {
          ...current,
          nextName: value
        }
      : current
  );
}

function updateCopyDialogName(
  value: string,
  setCopyDialog: Dispatch<SetStateAction<ProjectCopyDialogState | null>>
) {
  setCopyDialog((current) =>
    current
      ? {
          ...current,
          suggestedName: value
        }
      : current
  );
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
  const [newProjectType, setNewProjectType] = useState<"typst" | "latex">("typst");
  const [newLatexEngine, setNewLatexEngine] = useState<"pdftex" | "xetex">("xetex");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [copyDialog, setCopyDialog] = useState<ProjectCopyDialogState | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [renameDialog, setRenameDialog] = useState<ProjectRenameDialogState | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
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

  async function submitRename() {
    if (!renameDialog || !renameDialog.nextName.trim()) return;
    try {
      setRenameBusy(true);
      setError(null);
      await renameProject(renameDialog.projectId, renameDialog.nextName.trim());
      setRenameDialog(null);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.renameFailed"));
    } finally {
      setRenameBusy(false);
    }
  }

  function openProject(project: Project) {
    navigate(`/project/${project.id}`);
  }

  function openRenameDialog(project: Project) {
    setRenameDialog({
      projectId: project.id,
      sourceName: project.name,
      nextName: project.name
    });
  }

  function openCopyDialog(project: Project) {
    setCopyDialog({
      projectId: project.id,
      sourceName: project.name,
      suggestedName: `${project.name} ${t("projects.copySuffix")}`
    });
  }

  async function toggleProjectArchived(project: Project) {
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
  }

  async function createNamedProject() {
    if (!name.trim()) return;
    try {
      setError(null);
      await createProject({
        name: name.trim(),
        project_type: newProjectType,
        latex_engine: newProjectType === "latex" ? newLatexEngine : undefined
      });
      setName("");
      await refreshProjects();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create project";
      setError(message);
    }
  }

  return (
    <section className="page projects-page">
      <div className="projects-title-row">
        <h2>{t("projects.title")}</h2>
      </div>
      <UiCard className="projects-create-bar">
        <strong>{t("projects.createTitle")}</strong>
        <div className="projects-create-controls">
          <UiInput
            className="project-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("projects.namePlaceholder")}
          />
          <UiSelect
            className="project-type-select"
            value={newProjectType}
            onChange={(e) => setNewProjectType(e.target.value === "latex" ? "latex" : "typst")}
          >
            <option value="typst">{t("settings.projectTypeTypst")}</option>
            <option value="latex">{t("settings.projectTypeLatex")}</option>
          </UiSelect>
          {newProjectType === "latex" && (
            <UiSelect
              className="project-engine-select"
              value={newLatexEngine}
              onChange={(e) => setNewLatexEngine(e.target.value === "pdftex" ? "pdftex" : "xetex")}
            >
              <option value="xetex">XeTeX</option>
              <option value="pdftex">pdfTeX</option>
            </UiSelect>
          )}
          <UiButton
            variant="primary"
            onClick={createNamedProject}
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
            <ProjectRow
              key={project.id}
              project={project}
              busyProjectId={busyProjectId}
              onOpenProject={openProject}
              onOpenRenameDialog={openRenameDialog}
              onOpenCopyDialog={openCopyDialog}
              onToggleProjectArchived={toggleProjectArchived}
              t={t}
            />
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
        open={!!renameDialog}
        title={t("projects.renameDialogTitle")}
        description={renameDialog ? `${t("projects.renameDialogHint")} ${renameDialog.sourceName}` : undefined}
        onClose={() => setRenameDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setRenameDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton variant="primary" onClick={submitRename} disabled={renameBusy || !renameDialog?.nextName.trim()}>
              {renameBusy ? t("projects.renaming") : t("projects.renameAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          value={renameDialog?.nextName ?? ""}
          onChange={(e) => updateRenameDialogName(e.target.value, setRenameDialog)}
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>
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
          onChange={(e) => updateCopyDialogName(e.target.value, setCopyDialog)}
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
