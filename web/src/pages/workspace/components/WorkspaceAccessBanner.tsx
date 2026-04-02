import { UiButton } from "@/components/ui";
import type { Project } from "@/lib/api";

export function WorkspaceAccessBanner({
  project,
  isAnonymousShare,
  onRequestSignIn,
  onCopyTemplate,
  t
}: {
  project: Project | undefined;
  isAnonymousShare: boolean;
  onRequestSignIn: () => void;
  onCopyTemplate: () => void;
  t: (key: string) => string;
}) {
  if (isAnonymousShare) {
    return (
      <div className="workspace-access-banner with-action ui-message-with-action" role="status">
        <span className="message-text">
          {project?.is_template
            ? t("share.templateSavePrompt").replace("{name}", project.name)
            : t("share.savePrompt")}
        </span>
        <UiButton size="sm" onClick={onRequestSignIn}>
          {t("share.logIn")}
        </UiButton>
      </div>
    );
  }

  if (project?.is_template) {
    return (
      <div className="workspace-access-banner with-action template-banner ui-message-with-action" role="status">
        <span className="message-text">{`${t("settings.templateEnabled")} · ${t("projects.copyDialogHint")} ${project.name}`}</span>
        <UiButton size="sm" onClick={onCopyTemplate}>
          {t("projects.copyAction")}
        </UiButton>
      </div>
    );
  }

  return null;
}
