import { EditorPane } from "@/components/EditorPane";
import { UiButton } from "@/components/ui";
import { UnsupportedFilePane } from "@/pages/workspace/components/UnsupportedFilePane";
import type { CSSProperties } from "react";

type RemoteCursor = {
  id: string;
  name: string;
  color: string;
  line?: number;
  column?: number;
};

export function EditorPanel({
  activePath,
  activeFileName,
  lineWrapEnabled,
  onToggleLineWrap,
  remoteCursors,
  connectionOnline,
  isActiveEditableTextDoc,
  docText,
  onEditorDelta,
  onCursorChange,
  readOnly,
  currentEditorLanguage,
  jumpTarget,
  onJumpHandled,
  isRevisionMode,
  canWrite,
  canRequestGuestWrite,
  realtimeDocReady,
  activeAssetBase64,
  activeAssetIsImage,
  activeAssetIsPdf,
  assetDataUrl,
  workspaceError,
  showConnectionWarning,
  realtimeStatus,
  reconnectState,
  reconnectCountdownText,
  onReconnectNow,
  activePathExistsInTree,
  panelStyle,
  t
}: {
  activePath: string;
  activeFileName: string;
  lineWrapEnabled: boolean;
  onToggleLineWrap: () => void;
  remoteCursors: RemoteCursor[];
  connectionOnline: boolean;
  isActiveEditableTextDoc: boolean;
  docText: string;
  onEditorDelta: (changes: Array<{ from: number; to: number; insert: string }>) => boolean;
  onCursorChange: (cursor: { line: number; column: number }) => void;
  readOnly: boolean;
  currentEditorLanguage: "typst" | "latex" | "markdown" | "plain";
  jumpTarget: { line: number; column: number; token: number } | null;
  onJumpHandled: () => void;
  isRevisionMode: boolean;
  canWrite: boolean;
  canRequestGuestWrite: boolean;
  realtimeDocReady: boolean;
  activeAssetBase64?: string;
  activeAssetIsImage: boolean;
  activeAssetIsPdf: boolean;
  assetDataUrl: string;
  workspaceError: string | null;
  showConnectionWarning: boolean;
  realtimeStatus: string;
  reconnectState: { active: boolean };
  reconnectCountdownText: string;
  onReconnectNow: () => void;
  activePathExistsInTree: boolean;
  panelStyle: CSSProperties;
  t: (key: string) => string;
}) {
  return (
    <article className="panel panel-editor" style={panelStyle}>
      <div className="panel-header workspace-main-header">
        <h2 title={activePath}>{activeFileName}</h2>
        <div className="panel-status compact">
          <button className="inline-toggle" onClick={onToggleLineWrap}>
            {lineWrapEnabled ? t("status.wrapOn") : t("status.wrapOff")}
          </button>
          <span className="status-pill" title={remoteCursors.map((user) => user.name).join(", ")}>{`👥 ${remoteCursors.length}`}</span>
          <span className={`status-pill ${connectionOnline ? "ok" : "warn"}`}>
            {connectionOnline ? t("status.online") : t("status.offline")}
          </span>
        </div>
      </div>
      <div className="panel-content flush editor-panel-content">
        {isActiveEditableTextDoc ? (
          <div className="editor-surface">
            <EditorPane
              editorInstanceKey={`${activePath}:${isRevisionMode ? "revision" : "live"}:${currentEditorLanguage}`}
              value={docText}
              onDelta={onEditorDelta}
              onCursorChange={onCursorChange}
              readOnly={readOnly}
              lineWrap={lineWrapEnabled}
              language={currentEditorLanguage}
              remoteCursors={remoteCursors}
              jumpTo={jumpTarget}
              onJumpHandled={onJumpHandled}
            />
          </div>
        ) : (
          <UnsupportedFilePane
            path={activePath}
            hasData={!!activeAssetBase64}
            isImage={activeAssetIsImage}
            isPdf={activeAssetIsPdf}
            dataUrl={assetDataUrl}
            t={t}
          />
        )}
        {!isActiveEditableTextDoc && <div className="error panel-inline-error">{t("workspace.notEditable")}</div>}
        {isRevisionMode && !activePathExistsInTree && (
          <div className="error panel-inline-error">This file did not exist in this revision snapshot.</div>
        )}
        {showConnectionWarning && realtimeStatus === "disconnected" && (
          <div className="error panel-inline-error connection-warning connection-warning-row ui-message-with-action">
            <span className="message-text">
              {reconnectState.active ? reconnectCountdownText : t("workspace.connectionLost")}
            </span>
            <UiButton size="sm" onClick={onReconnectNow}>
              {t("workspace.reconnectNow")}
            </UiButton>
          </div>
        )}
        {showConnectionWarning && realtimeStatus === "connecting" && !reconnectState.active && (
          <div className="error panel-inline-error connection-warning">{t("workspace.connectionReconnecting")}</div>
        )}
        {workspaceError && <div className="error panel-inline-error">{workspaceError}</div>}
      </div>
    </article>
  );
}
