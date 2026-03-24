import type { DragEvent as ReactDragEvent } from "react";
import { FilePlus2, FolderPlus, Upload } from "lucide-react";
import { UiButton, UiIconButton } from "@/components/ui";
import { TreeNodeRow } from "@/pages/workspace/components/TreeNodeRow";
import type { ContextMenuState, ProjectTreeNodeView } from "@/pages/workspace/types";

export function FileTreePanel({
  width,
  filesDropActive,
  onDragOver,
  onDragLeave,
  onDrop,
  canWrite,
  isRevisionMode,
  onAddFile,
  onAddDirectory,
  onUpload,
  tree,
  activePath,
  expandedDirs,
  setExpandedDirs,
  onOpenTreePath,
  onRequestContextMenu,
  t
}: {
  width: number;
  filesDropActive: boolean;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  canWrite: boolean;
  isRevisionMode: boolean;
  onAddFile: () => void;
  onAddDirectory: () => void;
  onUpload: () => void;
  tree: ProjectTreeNodeView[];
  activePath: string;
  expandedDirs: Set<string>;
  setExpandedDirs: (next: Set<string>) => void;
  onOpenTreePath: (path: string) => void;
  onRequestContextMenu: (menu: ContextMenuState) => void;
  t: (key: string) => string;
}) {
  return (
    <aside className="panel panel-files" style={{ width }}>
      <div className="panel-header">
        <h2>{t("workspace.files")}</h2>
      </div>
      <div
        className={`panel-content ${filesDropActive ? "drop-active" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="toolbar compact-left">
          <UiButton onClick={onAddFile} disabled={!canWrite || isRevisionMode}>
            <FilePlus2 size={16} />
            {t("workspace.newFile")}
          </UiButton>
          <UiButton onClick={onAddDirectory} disabled={!canWrite || isRevisionMode}>
            <FolderPlus size={16} />
            {t("workspace.newFolder")}
          </UiButton>
          <UiIconButton
            tooltip={t("workspace.upload")}
            label={t("workspace.upload")}
            onClick={onUpload}
            disabled={!canWrite || isRevisionMode}
          >
            <Upload size={16} />
          </UiIconButton>
        </div>
        <div className="tree">
          {tree.map((node) => (
            <TreeNodeRow
              key={node.path}
              node={node}
              activePath={activePath}
              expanded={expandedDirs}
              setExpanded={setExpandedDirs}
              onOpen={onOpenTreePath}
              canManage={canWrite && !isRevisionMode}
              onRequestContextMenu={onRequestContextMenu}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

