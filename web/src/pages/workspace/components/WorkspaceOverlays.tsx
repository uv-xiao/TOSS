import { AuthForm } from "@/components/AuthForm";
import { UiButton, UiDialog, UiInput } from "@/components/ui";
import type { AuthConfig } from "@/lib/api";
import type { ContextMenuState, PathDialogState } from "@/pages/workspace/types";
import type { ProjectCopyDialogState, ProjectRenameDialogState } from "@/types/project-ui";

export function WorkspaceOverlays({
  contextMenu,
  canWrite,
  onAddPath,
  onUploadFromPicker,
  onRenamePath,
  onRemovePath,
  copyDialog,
  copyBusy,
  onCloseCopyDialog,
  onCreateProjectFromTemplate,
  onChangeCopyName,
  renameDialog,
  renameBusy,
  onCloseRenameDialog,
  onSubmitProjectRename,
  onChangeRenameName,
  pathDialog,
  onClosePathDialog,
  onSubmitPathDialog,
  onChangePathDialogValue,
  authModalOpen,
  canRequestGuestWrite,
  projectName,
  isAnonymousShareTemplate,
  guestNameInput,
  onChangeGuestNameInput,
  onBeginTemporaryGuestEditing,
  authConfig,
  onSignedIn,
  guestAuthError,
  onCloseAuthModal,
  t
}: {
  contextMenu: ContextMenuState | null;
  canWrite: boolean;
  onAddPath: (kind: "file" | "directory", parentPath?: string) => void;
  onUploadFromPicker: (parentPath?: string) => void;
  onRenamePath: (path: string) => void;
  onRemovePath: (path: string) => void;
  copyDialog: ProjectCopyDialogState | null;
  copyBusy: boolean;
  onCloseCopyDialog: () => void;
  onCreateProjectFromTemplate: () => void;
  onChangeCopyName: (name: string) => void;
  renameDialog: ProjectRenameDialogState | null;
  renameBusy: boolean;
  onCloseRenameDialog: () => void;
  onSubmitProjectRename: () => void;
  onChangeRenameName: (name: string) => void;
  pathDialog: PathDialogState | null;
  onClosePathDialog: () => void;
  onSubmitPathDialog: () => void;
  onChangePathDialogValue: (value: string) => void;
  authModalOpen: boolean;
  canRequestGuestWrite: boolean;
  projectName: string;
  isAnonymousShareTemplate: boolean;
  guestNameInput: string;
  onChangeGuestNameInput: (value: string) => void;
  onBeginTemporaryGuestEditing: () => void;
  authConfig: AuthConfig | null;
  onSignedIn: () => Promise<void>;
  guestAuthError: string | null;
  onCloseAuthModal: () => void;
  t: (key: string) => string;
}) {
  return (
    <>
      {contextMenu && canWrite && (
        <div className="context-menu context-menu-floating" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => onAddPath("file", contextMenu.path)}>
              {t("workspace.newFile")}
            </UiButton>
          )}
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => onAddPath("directory", contextMenu.path)}>
              {t("workspace.newFolder")}
            </UiButton>
          )}
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => onUploadFromPicker(contextMenu.path)}>
              {t("workspace.upload")}
            </UiButton>
          )}
          <UiButton className="mini" size="sm" onClick={() => onRenamePath(contextMenu.path)}>
            {t("common.rename")}
          </UiButton>
          <UiButton className="mini" size="sm" variant="danger" onClick={() => onRemovePath(contextMenu.path)}>
            {t("common.delete")}
          </UiButton>
        </div>
      )}

      <UiDialog
        open={!!copyDialog}
        title={t("projects.copyDialogTitle")}
        description={copyDialog ? `${t("projects.copyDialogHint")} ${copyDialog.sourceName}` : undefined}
        onClose={onCloseCopyDialog}
        actions={
          <>
            <UiButton onClick={onCloseCopyDialog}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              onClick={onCreateProjectFromTemplate}
              disabled={copyBusy || !copyDialog?.suggestedName.trim()}
            >
              {copyBusy ? t("projects.copying") : t("projects.copyAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          value={copyDialog?.suggestedName ?? ""}
          onChange={(event) => onChangeCopyName(event.target.value)}
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>

      <UiDialog
        open={!!renameDialog}
        title={t("projects.renameDialogTitle")}
        description={renameDialog ? `${t("projects.renameDialogHint")} ${renameDialog.sourceName}` : undefined}
        onClose={onCloseRenameDialog}
        actions={
          <>
            <UiButton onClick={onCloseRenameDialog}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              onClick={onSubmitProjectRename}
              disabled={renameBusy || !renameDialog?.nextName.trim()}
            >
              {renameBusy ? t("common.loading") : t("projects.renameAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          value={renameDialog?.nextName ?? ""}
          onChange={(event) => onChangeRenameName(event.target.value)}
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>

      <UiDialog
        open={!!pathDialog}
        title={
          pathDialog?.mode === "create"
            ? pathDialog.kind === "file"
              ? t("workspace.newFile")
              : t("workspace.newFolder")
            : pathDialog?.mode === "rename"
              ? t("common.rename")
              : t("common.delete")
        }
        description={pathDialog?.mode === "delete" ? `${t("settings.deletePathConfirm")} ${pathDialog.path}` : undefined}
        onClose={onClosePathDialog}
        actions={
          <>
            <UiButton onClick={onClosePathDialog}>{t("common.cancel")}</UiButton>
            <UiButton
              variant={pathDialog?.mode === "delete" ? "danger" : "primary"}
              onClick={onSubmitPathDialog}
              disabled={!!pathDialog && pathDialog.mode !== "delete" && !pathDialog.value.trim()}
            >
              {pathDialog?.mode === "delete" ? t("common.delete") : t("common.save")}
            </UiButton>
          </>
        }
      >
        {pathDialog && pathDialog.mode !== "delete" && (
          <UiInput
            value={pathDialog.value}
            onChange={(event) => onChangePathDialogValue(event.target.value)}
            placeholder={t("workspace.pathPlaceholder")}
          />
        )}
      </UiDialog>

      <UiDialog
        open={authModalOpen}
        title={canRequestGuestWrite ? t("share.guestEditTitle") : t("auth.signIn")}
        description={
          canRequestGuestWrite
            ? `${t("share.guestEditDescription")} ${projectName}.`
            : isAnonymousShareTemplate
              ? t("share.templateSavePrompt").replace("{name}", projectName)
              : t("share.savePrompt")
        }
        onClose={onCloseAuthModal}
      >
        {canRequestGuestWrite && (
          <div className="auth-fields">
            <UiInput
              value={guestNameInput}
              onChange={(event) => onChangeGuestNameInput(event.target.value)}
              placeholder={t("share.yourName")}
            />
            <UiButton variant="primary" onClick={onBeginTemporaryGuestEditing}>
              {t("share.startGuestEdit")}
            </UiButton>
            <div className="auth-divider">
              <span>{t("share.orLogin")}</span>
            </div>
          </div>
        )}
        <AuthForm config={authConfig} t={t} compact onSignedIn={onSignedIn} />
        {guestAuthError && <div className="error">{guestAuthError}</div>}
      </UiDialog>
    </>
  );
}
