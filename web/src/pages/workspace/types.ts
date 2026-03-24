export type ProjectNode = {
  path: string;
  kind: "file" | "directory";
};

export type ProjectTreeNodeView = {
  name: string;
  path: string;
  kind: "file" | "directory";
  children: ProjectTreeNodeView[];
};

export type AssetMeta = {
  id?: string;
  contentType: string;
};

export type ContextMenuState = {
  path: string;
  kind: "file" | "directory";
  x: number;
  y: number;
};

export type PathDialogState =
  | {
      mode: "create";
      kind: "file" | "directory";
      parentPath: string;
      value: string;
    }
  | {
      mode: "rename";
      path: string;
      value: string;
    }
  | {
      mode: "delete";
      path: string;
    };

export type WorkspaceLayoutPrefs = {
  filesWidth: number;
  settingsWidth: number;
  revisionsWidth: number;
  editorRatio: number;
};

export type PreviewFitMode = "manual" | "page" | "width";

