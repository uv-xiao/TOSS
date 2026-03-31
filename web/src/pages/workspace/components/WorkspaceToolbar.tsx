import { UiButton } from "@/components/ui";
import { useEffect, useMemo, useRef, useState } from "react";

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
  onRenameProject,
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
  onRenameProject: () => void;
  onToggleFiles: () => void;
  onTogglePreview: () => void;
  onToggleSettings: () => void;
  onToggleRevisions: () => void;
  t: (key: string) => string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const currentProject = useMemo(() => projects.find((item) => item.id === projectId) ?? null, [projectId, projects]);
  const otherProjects = useMemo(() => projects.filter((item) => item.id !== projectId), [projectId, projects]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  return (
    <div className="workspace-topbar-controls">
      <div className="workspace-topbar-left-spacer" aria-hidden />
      <div className="workspace-project-menu-wrap" ref={menuRef}>
        <button
          type="button"
          className="workspace-project-title-button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={t("nav.projects")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span className="workspace-project-title">{currentProject?.name ?? t("common.loading")}</span>
          <span className="workspace-project-chevron" aria-hidden>
            v
          </span>
        </button>
        {menuOpen && (
          <div className="workspace-project-menu" role="menu">
            <button
              type="button"
              className="workspace-project-menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onRenameProject();
              }}
            >
              {t("common.rename")}
            </button>
            {otherProjects.map((item) => (
              <button
                key={item.id}
                type="button"
                className="workspace-project-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onProjectChange(item.id);
                }}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
      </div>
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
