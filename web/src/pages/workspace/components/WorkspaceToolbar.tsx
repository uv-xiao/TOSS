import { UiButton, UiSelect } from "@/components/ui";

type ToolbarProject = {
  id: string;
  name: string;
};

export function WorkspaceToolbar({
  projectId,
  projects,
  showFilesPanel,
  showPreviewPanel,
  showProjectSettingsPanel,
  showRevisionPanel,
  onProjectChange,
  onToggleFiles,
  onTogglePreview,
  onToggleSettings,
  onToggleRevisions,
  t
}: {
  projectId: string;
  projects: ToolbarProject[];
  showFilesPanel: boolean;
  showPreviewPanel: boolean;
  showProjectSettingsPanel: boolean;
  showRevisionPanel: boolean;
  onProjectChange: (projectId: string) => void;
  onToggleFiles: () => void;
  onTogglePreview: () => void;
  onToggleSettings: () => void;
  onToggleRevisions: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="workspace-topbar-controls">
      <label className="workspace-project-picker workspace-topbar-project" aria-label={t("nav.projects")}>
        <UiSelect value={projectId} onChange={(e) => onProjectChange(e.target.value)}>
          {projects.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </UiSelect>
      </label>
      <div className="workspace-icon-toggles">
        <UiButton
          className={`icon-toggle ${showFilesPanel ? "active" : ""}`}
          aria-label={t("workspace.files")}
          title={t("workspace.files")}
          onClick={onToggleFiles}
        >
          <span aria-hidden>☰</span>
          <span>{t("workspace.files")}</span>
        </UiButton>
        <UiButton
          className={`icon-toggle ${showPreviewPanel ? "active" : ""}`}
          aria-label={t("workspace.preview")}
          title={t("workspace.preview")}
          onClick={onTogglePreview}
        >
          <span aria-hidden>▭</span>
          <span>{t("workspace.preview")}</span>
        </UiButton>
        <UiButton
          className={`icon-toggle ${showProjectSettingsPanel ? "active" : ""}`}
          aria-label={t("workspace.settings")}
          title={t("workspace.settings")}
          onClick={onToggleSettings}
        >
          <span aria-hidden>⚙</span>
          <span>{t("workspace.settings")}</span>
        </UiButton>
        <UiButton
          className={`icon-toggle ${showRevisionPanel ? "active" : ""}`}
          aria-label={t("workspace.revisions")}
          title={t("workspace.revisions")}
          onClick={onToggleRevisions}
        >
          <span aria-hidden>↺</span>
          <span>{t("workspace.revisions")}</span>
        </UiButton>
      </div>
    </div>
  );
}

