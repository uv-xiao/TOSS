type RevisionLoadingState = {
  active: boolean;
  revisionId: string | null;
  loadedBytes: number;
  totalBytes: number | null;
};

type AssetHydrationProgressState = {
  active: boolean;
  loaded: number;
  total: number;
  loadedBytes: number;
  totalBytes: number;
};

export function createRevisionLoadingState(
  input?: Partial<RevisionLoadingState>
): RevisionLoadingState {
  return {
    active: false,
    revisionId: null,
    loadedBytes: 0,
    totalBytes: null,
    ...(input ?? {})
  };
}

export function createAssetHydrationProgressState(
  input?: Partial<AssetHydrationProgressState>
): AssetHydrationProgressState {
  return {
    active: false,
    loaded: 0,
    total: 0,
    loadedBytes: 0,
    totalBytes: 0,
    ...(input ?? {})
  };
}
