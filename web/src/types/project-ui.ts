export type ProjectCopyDialogState = {
  projectId: string;
  suggestedName: string;
  sourceName: string;
};

export type ProjectRenameDialogState = {
  projectId: string;
  sourceName: string;
  nextName: string;
};
