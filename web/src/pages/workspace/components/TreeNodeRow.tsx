import { File, FileCode2, FileImage, FileText, Folder } from "lucide-react";
import type { ContextMenuState, ProjectTreeNodeView } from "@/pages/workspace/types";

export function TreeNodeRow({
  node,
  activePath,
  expanded,
  setExpanded,
  onOpen,
  canManage,
  onRequestContextMenu
}: {
  node: ProjectTreeNodeView;
  activePath: string;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  onOpen: (path: string) => void;
  canManage: boolean;
  onRequestContextMenu: (menu: ContextMenuState) => void;
}) {
  const isExpanded = expanded.has(node.path);
  const isActive = activePath === node.path;
  const isTypstFile = node.kind === "file" && /\.typ$/i.test(node.path);
  const isImageFile = node.kind === "file" && /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(node.path);
  const isTextLikeFile = node.kind === "file" && /\.(txt|md|json|toml|yaml|yml|csv|xml|html|css|js|ts|tsx|jsx)$/i.test(node.path);

  const toggleDirectory = () => {
    if (node.kind !== "directory") return;
    const next = new Set(expanded);
    if (isExpanded) next.delete(node.path);
    else next.add(node.path);
    setExpanded(next);
  };

  return (
    <div className="tree-branch">
      <div
        className={`tree-node ${isActive ? "active" : ""}`}
        onContextMenu={(event) => {
          if (!canManage) return;
          event.preventDefault();
          onRequestContextMenu({
            path: node.path,
            kind: node.kind,
            x: event.clientX,
            y: event.clientY
          });
        }}
      >
        {node.kind === "directory" ? (
          <button className="tree-toggle" onClick={toggleDirectory}>
            {isExpanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle tree-placeholder" />
        )}
        <button className="tree-label" onClick={() => (node.kind === "file" ? onOpen(node.path) : toggleDirectory())}>
          <span className={`tree-icon ${node.kind}`} aria-hidden>
            {node.kind === "directory" ? (
              <Folder size={14} />
            ) : isTypstFile ? (
              <FileCode2 size={14} />
            ) : isImageFile ? (
              <FileImage size={14} />
            ) : isTextLikeFile ? (
              <FileText size={14} />
            ) : (
              <File size={14} />
            )}
          </span>
          <span className="tree-name">{node.name}</span>
        </button>
        {canManage && (
          <button
            className="mini"
            onClick={(event) => {
              event.stopPropagation();
              const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
              onRequestContextMenu({
                path: node.path,
                kind: node.kind,
                x: Math.round(rect.left),
                y: Math.round(rect.bottom + 4)
              });
            }}
          >
            ⋮
          </button>
        )}
      </div>
      {node.kind === "directory" && isExpanded && node.children.length > 0 && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              activePath={activePath}
              expanded={expanded}
              setExpanded={setExpanded}
              onOpen={onOpen}
              canManage={canManage}
              onRequestContextMenu={onRequestContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}
