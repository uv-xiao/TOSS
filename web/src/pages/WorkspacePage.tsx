import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { EditorPane } from "@/components/EditorPane";
import { UiButton, UiDialog, UiInput } from "@/components/ui";
import {
  getAuthMe,
  copyProject,
  createProjectFile,
  createProjectShareLink,
  deleteProjectFile,
  deleteProjectOrganizationAccess,
  deleteProjectTemplateOrganizationAccess,
  downloadProjectArchive,
  getGitRepoLink,
  getProjectAssetContentCached,
  getProjectSettings,
  getProjectTree,
  getRevisionDocuments,
  joinProjectShareLink,
  temporaryShareLogin,
  listDocuments,
  listProjectAccessUsers,
  listProjectAssets,
  listProjectOrganizationAccess,
  listProjectShareLinks,
  listProjectTemplateOrganizationAccess,
  listRevisions,
  moveProjectFile,
  revokeProjectShareLink,
  renameProject,
  type AuthUser,
  type OrganizationMembership,
  type Project,
  type ProjectAsset,
  type ProjectAccessUser,
  type ProjectOrganizationAccess,
  type ProjectShareLink,
  type ProjectTemplateOrganizationAccess,
  type Revision,
  updateProjectTemplate,
  upsertDocumentByPath,
  upsertProjectOrganizationAccess,
  upsertProjectSettings,
  upsertProjectTemplateOrganizationAccess,
  uploadProjectAsset,
  uploadProjectThumbnail,
  setShareAccessContext,
  type AuthConfig
} from "@/lib/api";
import { AuthForm } from "@/components/AuthForm";
import { loadProjectSnapshotFromCache, saveProjectSnapshotToCache } from "@/lib/projectCache";
import {
  compileTypstClientSide,
  subscribeTypstRuntimeStatus,
  type CompileOutput,
  type CompileDiagnostic,
  type TypstRuntimeStatus
} from "@/lib/typst";
import { FileTreePanel } from "@/pages/workspace/components/FileTreePanel";
import { PreviewPanel } from "@/pages/workspace/components/PreviewPanel";
import { RevisionsPanel } from "@/pages/workspace/components/RevisionsPanel";
import { SettingsPanel } from "@/pages/workspace/components/SettingsPanel";
import { UnsupportedFilePane } from "@/pages/workspace/components/UnsupportedFilePane";
import { WorkspaceToolbar } from "@/pages/workspace/components/WorkspaceToolbar";
import { usePreviewCanvas } from "@/pages/workspace/hooks/usePreviewCanvas";
import { useProjectTree } from "@/pages/workspace/hooks/useProjectTree";
import { useRealtimeDoc } from "@/pages/workspace/hooks/useRealtimeDoc";
import { useWorkspaceLayout } from "@/pages/workspace/hooks/useWorkspaceLayout";
import type { AssetMeta, ContextMenuState, PathDialogState, PreviewFitMode, ProjectNode } from "@/pages/workspace/types";
import {
  buildCompileInputKey,
  buildTopPreviewThumbnail,
  clampNumber,
  collectReferencedAssetPaths,
  editorLanguageForPath,
  expandAncestors,
  inferContentType,
  isFontFile,
  isImageAsset,
  isPdfAsset,
  isTextFile,
  joinProjectPath,
  looksLikeUuid,
  maxDocumentUpdatedAtIso,
  normalizePath,
  parentProjectPath,
  pickWorkspaceOpenPath,
  pixelPerPtForZoom,
  presenceColor,
  prependUniqueById,
  PREVIEW_MAX_ZOOM,
  PREVIEW_MIN_ZOOM
} from "@/pages/workspace/utils";
import type { ProjectCopyDialogState } from "@/types/project-ui";

type UploadCandidate = {
  relativePath: string;
  file: File;
};

type ProjectRenameDialogState = {
  projectId: string;
  sourceName: string;
  nextName: string;
};

const REVISION_PAGE_SIZE = 40;

type WorkspacePageProps = {
  projects: Project[];
  organizations: OrganizationMembership[];
  authUser: AuthUser | null;
  authConfig?: AuthConfig | null;
  refreshProjects: () => Promise<void>;
  t: (key: string) => string;
  onTopbarChange: (content: ReactNode | null) => void;
  projectIdOverride?: string;
  shareToken?: string | null;
  sharePermission?: "read" | "write" | null;
  anonymousMode?: string | null;
  onSignInFromWorkspace?: () => Promise<void>;
};

export function WorkspacePage({
  projects,
  organizations,
  authUser,
  authConfig,
  refreshProjects,
  t,
  onTopbarChange,
  projectIdOverride,
  shareToken,
  sharePermission,
  anonymousMode,
  onSignInFromWorkspace
}: WorkspacePageProps) {
  const { projectId: routeProjectId = "" } = useParams();
  const projectId = projectIdOverride || routeProjectId;
  const navigate = useNavigate();
  const guestSessionStorageKey = projectId ? `guest.share.${projectId}.session` : "guest.share.session";
  const [guestSessionToken, setGuestSessionToken] = useState<string | null>(
    () => (projectId ? window.localStorage.getItem(guestSessionStorageKey) : null)
  );
  const [guestDisplayName, setGuestDisplayName] = useState<string>(
    () => window.localStorage.getItem("guest.display_name") || ""
  );
  const [guestSessionId, setGuestSessionId] = useState<string | null>(
    () => (projectId ? window.localStorage.getItem(`${guestSessionStorageKey}.id`) : null)
  );
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [guestNameInput, setGuestNameInput] = useState("");
  const [guestAuthError, setGuestAuthError] = useState<string | null>(null);
  const isAnonymousShare = !!shareToken && !authUser;
  const effectiveUserId = authUser?.user_id || guestSessionId || `guest-${projectId || "workspace"}`;
  const effectiveUserName = authUser
    ? authUser.display_name || "User"
    : guestDisplayName
      ? `${guestDisplayName} (Unverified)`
      : "Guest";
  const centerSplitRef = useRef<HTMLDivElement | null>(null);
  const copyNoticeTimerRef = useRef<number | null>(null);
  const thumbnailUploadTimerRef = useRef<number | null>(null);
  const lastUploadedThumbnailRef = useRef<string>("");
  const lastCompileInputKeyRef = useRef<string>("");
  const lastCompileOutputRef = useRef<CompileOutput | null>(null);
  const revisionLoadSeqRef = useRef(0);
  const revisionHeadSeqRef = useRef(0);
  const revisionMoreSeqRef = useRef(0);
  const assetLoadInflightRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const assetLoadFailedRef = useRef<Set<string>>(new Set());
  const remoteSyncInflightRef = useRef(false);
  const lastDocsSyncAtRef = useRef<string | null>(null);
  const syncWorkspaceFromServerRef = useRef<() => Promise<void>>(async () => undefined);

  const [nodes, setNodes] = useState<ProjectNode[]>([]);
  const [entryFilePath, setEntryFilePath] = useState("main.typ");
  const [activePath, setActivePath] = useState("main.typ");
  const [docs, setDocs] = useState<Record<string, string>>({});
  const [assetBase64, setAssetBase64] = useState<Record<string, string>>({});
  const [assetMeta, setAssetMeta] = useState<Record<string, AssetMeta>>({});
  const [vectorData, setVectorData] = useState<Uint8Array | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compileDiagnostics, setCompileDiagnostics] = useState<CompileDiagnostic[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [workspaceSyncPending, setWorkspaceSyncPending] = useState(false);
  const [assetHydrationProgress, setAssetHydrationProgress] = useState<{
    active: boolean;
    loaded: number;
    total: number;
    loadedBytes: number;
    totalBytes: number;
  }>({
    active: false,
    loaded: 0,
    total: 0,
    loadedBytes: 0,
    totalBytes: 0
  });
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revisionsHasMore, setRevisionsHasMore] = useState(true);
  const [revisionsLoadingMore, setRevisionsLoadingMore] = useState(false);
  const [activeRevisionId, setActiveRevisionId] = useState<string | null>(null);
  const [revisionDocs, setRevisionDocs] = useState<Record<string, string>>({});
  const [revisionNodes, setRevisionNodes] = useState<ProjectNode[]>([]);
  const [revisionEntryFilePath, setRevisionEntryFilePath] = useState("main.typ");
  const [revisionAssetBase64, setRevisionAssetBase64] = useState<Record<string, string>>({});
  const [revisionAssetMeta, setRevisionAssetMeta] = useState<Record<string, AssetMeta>>({});
  const [revisionLoading, setRevisionLoading] = useState<{
    active: boolean;
    revisionId: string | null;
    loadedBytes: number;
    totalBytes: number | null;
  }>({
    active: false,
    revisionId: null,
    loadedBytes: 0,
    totalBytes: null
  });
  const [showFilesPanel, setShowFilesPanel] = useState(true);
  const [showRevisionPanel, setShowRevisionPanel] = useState(false);
  const [showProjectSettingsPanel, setShowProjectSettingsPanel] = useState(false);
  const [showPreviewPanel, setShowPreviewPanel] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(
    () => (typeof window === "undefined" ? 1440 : window.innerWidth)
  );
  const [compactPanelView, setCompactPanelView] = useState<"editor" | "files" | "preview" | "settings" | "revisions">(
    "editor"
  );
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewFitMode, setPreviewFitMode] = useState<PreviewFitMode>("page");
  const [lineWrapEnabled, setLineWrapEnabled] = useState(true);
  const [jumpTarget, setJumpTarget] = useState<{ line: number; column: number; token: number } | null>(null);
  const [queuedJump, setQueuedJump] = useState<{ path: string; line: number; column: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [filesDropActive, setFilesDropActive] = useState(false);
  const [shareLinks, setShareLinks] = useState<ProjectShareLink[]>([]);
  const [projectOrgAccess, setProjectOrgAccess] = useState<ProjectOrganizationAccess[]>([]);
  const [projectTemplateOrgAccess, setProjectTemplateOrgAccess] = useState<ProjectTemplateOrganizationAccess[]>([]);
  const [projectAccessUsers, setProjectAccessUsers] = useState<ProjectAccessUser[]>([]);
  const [templateEnabled, setTemplateEnabled] = useState(false);
  const [pathDialog, setPathDialog] = useState<PathDialogState | null>(null);
  const [copyDialog, setCopyDialog] = useState<ProjectCopyDialogState | null>(null);
  const [renameDialog, setRenameDialog] = useState<ProjectRenameDialogState | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [typstRuntimeStatus, setTypstRuntimeStatus] = useState<TypstRuntimeStatus>({ stage: "idle" });
  const [apiReachable, setApiReachable] = useState(true);
  const [copiedControl, setCopiedControl] = useState<string | null>(null);
  const assetMetaRef = useRef<Record<string, AssetMeta>>({});
  const assetBase64Ref = useRef<Record<string, string>>({});
  const activePathRef = useRef("main.typ");
  const entryFilePathRef = useRef("main.typ");

  const {
    filesPanelWidth,
    setFilesPanelWidth,
    settingsPanelWidth,
    setSettingsPanelWidth,
    revisionsPanelWidth,
    setRevisionsPanelWidth,
    editorRatio,
    setEditorRatio
  } = useWorkspaceLayout();
  const project = projects.find((p) => p.id === projectId);
  const canRequestGuestWrite =
    isAnonymousShare &&
    sharePermission === "write" &&
    anonymousMode === "read_write_named" &&
    !guestSessionToken;
  const canWrite = authUser
    ? project?.my_role !== "ReadOnly"
    : sharePermission === "write" && anonymousMode === "read_write_named" && !!guestSessionToken;
  const canManageProject = authUser
    ? project?.my_role === "Owner"
    : false;
  const collapsePanelToggles = viewportWidth <= 1320;
  const singlePanelMode = viewportWidth <= 980;
  const effectiveShowFilesPanel = singlePanelMode ? compactPanelView === "files" : showFilesPanel;
  const effectiveShowPreviewPanel = singlePanelMode ? compactPanelView === "preview" : showPreviewPanel;
  const effectiveShowSettingsPanel = singlePanelMode ? compactPanelView === "settings" : showProjectSettingsPanel;
  const effectiveShowRevisionPanel = singlePanelMode ? compactPanelView === "revisions" : showRevisionPanel;
  const effectiveShowEditorPanel = !singlePanelMode || compactPanelView === "editor";

  const isRevisionMode = !!activeRevisionId;
  const currentNodes = isRevisionMode ? revisionNodes : nodes;
  const sourceAssetBase64 = isRevisionMode ? revisionAssetBase64 : assetBase64;
  const sourceAssetMeta = isRevisionMode ? revisionAssetMeta : assetMeta;
  const sourceEntryFilePath = isRevisionMode ? revisionEntryFilePath : entryFilePath;
  const sourceDocs = isRevisionMode ? revisionDocs : docs;

  useEffect(() => {
    if (!projectId) return;
    const session = window.localStorage.getItem(`guest.share.${projectId}.session`);
    const sessionId = window.localStorage.getItem(`guest.share.${projectId}.session.id`);
    setGuestSessionToken(session);
    setGuestSessionId(sessionId);
  }, [projectId]);

  useEffect(() => {
    if (isAnonymousShare) {
      setShareAccessContext({
        shareToken: shareToken ?? null,
        guestSession: guestSessionToken
      });
      return;
    }
    setShareAccessContext({ shareToken: null, guestSession: null });
  }, [guestSessionToken, isAnonymousShare, shareToken]);

  function toProjectAssetMeta(path: string, meta: AssetMeta): ProjectAsset | null {
    if (
      !projectId ||
      !meta.id ||
      !meta.objectKey ||
      !meta.createdAt ||
      typeof meta.sizeBytes !== "number"
    ) {
      return null;
    }
    return {
      id: meta.id,
      project_id: projectId,
      path,
      object_key: meta.objectKey,
      content_type: meta.contentType || "application/octet-stream",
      size_bytes: meta.sizeBytes,
      uploaded_by: null,
      created_at: meta.createdAt
    };
  }

  async function ensureLiveAssetLoaded(path: string): Promise<string | null> {
    if (!projectId || isRevisionMode) return null;
    const existing = assetBase64Ref.current[path];
    if (existing) return existing;
    const inflight = assetLoadInflightRef.current.get(path);
    if (inflight) return inflight;
    const meta = assetMetaRef.current[path];
    if (!meta) return null;
    const asset = toProjectAssetMeta(path, meta);
    if (!asset) return null;
    const loadPromise = (async () => {
      try {
        const response = await getProjectAssetContentCached(projectId, asset);
        const b64 = response.content_base64;
        setAssetBase64((prev) => {
          if (prev[path] === b64) return prev;
          const next = { ...prev, [path]: b64 };
          assetBase64Ref.current = next;
          return next;
        });
        assetLoadFailedRef.current.delete(path);
        return b64;
      } catch {
        assetLoadFailedRef.current.add(path);
        return null;
      } finally {
        assetLoadInflightRef.current.delete(path);
      }
    })();
    assetLoadInflightRef.current.set(path, loadPromise);
    return loadPromise;
  }

  async function hydrateProjectAssetsForInitialLoad(
    nextDocs: Record<string, string>,
    nextAssetMeta: Record<string, AssetMeta>
  ) {
    if (!projectId || isRevisionMode) return;
    const assetPaths = Object.keys(nextAssetMeta);
    const docsCount = Object.keys(nextDocs).length;
    const docsBytes = Object.values(nextDocs).reduce((sum, content) => sum + content.length, 0);
    const totalAssetBytes = assetPaths.reduce(
      (sum, path) => sum + Math.max(0, nextAssetMeta[path]?.sizeBytes || 0),
      0
    );
    const totalFiles = docsCount + assetPaths.length;
    const totalBytes = docsBytes + totalAssetBytes;
    let loadedFiles = docsCount;
    let loadedBytes = docsBytes;

    const publishProgress = () => {
      setAssetHydrationProgress({
        active: loadedFiles < totalFiles,
        loaded: loadedFiles,
        total: totalFiles,
        loadedBytes,
        totalBytes
      });
    };

    publishProgress();
    if (assetPaths.length === 0) return;

    const concurrency = Math.min(6, assetPaths.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= assetPaths.length) return;
        const path = assetPaths[index];
        const loaded = await ensureLiveAssetLoaded(path);
        loadedFiles += 1;
        if (loaded) {
          loadedBytes += Math.max(0, nextAssetMeta[path]?.sizeBytes || 0);
        }
        publishProgress();
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  const {
    tree,
    expandedDirs,
    setExpandedDirs,
    openTreePath
  } = useProjectTree(currentNodes, activePath, setActivePath);

  const {
    ytextRef,
    realtimeRef,
    lastSavedDocRef,
    presence,
    realtimeStatus,
    reconnectState,
    docText,
    setDocText,
    realtimeDocReady,
    hasActiveLiveDoc,
    applyDocumentDeltas
  } = useRealtimeDoc({
    projectId,
    activePath,
    docs,
    workspaceLoaded,
    isRevisionMode,
    canWrite: !!canWrite,
    effectiveUserId,
    effectiveUserName,
    shareToken: isAnonymousShare ? shareToken : null,
    guestSession: isAnonymousShare ? guestSessionToken : null
  });
  const docTextRef = useRef(docText);
  const hasActiveLiveDocRef = useRef(hasActiveLiveDoc);

  const compileDocuments = useMemo(() => {
    const baseDocs = { ...sourceDocs };
    if (!isRevisionMode && realtimeDocReady && activePath && activePath in baseDocs) {
      baseDocs[activePath] = docText;
    }
    return Object.entries(baseDocs).map(([path, content]) => ({ path, content }));
  }, [activePath, docText, isRevisionMode, realtimeDocReady, sourceDocs]);
  const compileAssets = useMemo(
    () => Object.entries(sourceAssetBase64).map(([path, contentBase64]) => ({ path, contentBase64 })),
    [sourceAssetBase64]
  );
  const requiredAssetPaths = useMemo(() => {
    if (isRevisionMode) return [] as string[];
    return collectReferencedAssetPaths(compileDocuments, assetMeta);
  }, [assetMeta, compileDocuments, isRevisionMode]);
  const assetFontData = useMemo(
    () =>
      Object.entries(sourceAssetBase64)
        .filter(([path]) => isFontFile(path))
        .map(([, b64]) => {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return bytes;
        }),
    [sourceAssetBase64]
  );
  const fontData = useMemo(() => assetFontData, [assetFontData]);
  const compileInputKey = useMemo(
    () =>
      buildCompileInputKey({
        entryFilePath: sourceEntryFilePath,
        documents: compileDocuments,
        assets: compileAssets,
        fontData
      }),
    [compileAssets, compileDocuments, fontData, sourceEntryFilePath]
  );

  const previewPixelPerPt = pixelPerPtForZoom(previewFitMode, previewZoom);
  const {
    canvasPreviewRef,
    previewRenderTick,
    previewIsPanning,
    hasPreviewPage,
    previewPageCurrent,
    previewPageTotal,
    jumpToPreviewPage,
    beginPreviewPan
  } = usePreviewCanvas({
    showPreviewPanel: effectiveShowPreviewPanel,
    vectorData,
    previewPixelPerPt,
    previewFitMode,
    previewZoom,
    setPreviewZoom,
    reflowDeps: [editorRatio, effectiveShowFilesPanel, effectiveShowPreviewPanel, effectiveShowSettingsPanel, effectiveShowRevisionPanel],
    onRenderError: (message) => {
      setCompileErrors([message]);
      setCompileDiagnostics([]);
    }
  });

  const remoteCursors = useMemo(
    () =>
      presence
        .filter((peer) => peer.id !== effectiveUserId)
        .map((peer) => ({
          id: peer.id,
          name:
            peer.name && !looksLikeUuid(peer.name)
              ? peer.name
              : looksLikeUuid(peer.id)
                ? "Collaborator"
                : peer.id,
          color: presenceColor(peer.id),
          line: peer.line,
          column: peer.column
        })),
    [effectiveUserId, presence]
  );
  const activeAsset = sourceAssetMeta[activePath];
  const activeAssetBase64 = sourceAssetBase64[activePath];
  const activeAssetType = inferContentType(activePath, activeAsset?.contentType);
  const assetDataUrl = activeAssetBase64 ? `data:${activeAssetType};base64,${activeAssetBase64}` : "";
  const activeReadShare = shareLinks.find((link) => link.permission === "read" && !link.revoked_at) ?? null;
  const activeWriteShare = shareLinks.find((link) => link.permission === "write" && !link.revoked_at) ?? null;
  const myOrganizations = organizations;
  const typEntryOptions = useMemo(() => {
    const values = new Set<string>();
    for (const path of Object.keys(docs)) {
      if (path.endsWith(".typ")) values.add(path);
    }
    for (const node of nodes) {
      if (node.kind === "file" && node.path.endsWith(".typ")) values.add(node.path);
    }
    if (entryFilePath.endsWith(".typ")) values.add(entryFilePath);
    if (values.size === 0) values.add("main.typ");
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [docs, entryFilePath, nodes]);
  const activePathExistsInTree = currentNodes.some((node) => node.kind === "file" && node.path === activePath);
  const activePathIsTextFile = isTextFile(activePath);
  const isActiveTextDoc = isRevisionMode
    ? Object.prototype.hasOwnProperty.call(revisionDocs, activePath)
    : hasActiveLiveDoc;
  const isActiveEditableTextDoc = isActiveTextDoc && activePathIsTextFile;
  const currentEditorLanguage = editorLanguageForPath(activePath);
  const previewPercent = Math.round(previewZoom * 100);
  const activeFileName = activePath.split("/").filter(Boolean).at(-1) || activePath;
  const realtimeRequired = isActiveEditableTextDoc && !isRevisionMode;
  const reconnectNoticeActive = reconnectState.attempt >= 2;
  const connectionOnline =
    apiReachable && (!realtimeRequired || realtimeStatus === "connected" || !reconnectNoticeActive);
  const showConnectionWarning = realtimeRequired && reconnectNoticeActive && !connectionOnline;
  const reconnectCountdownText = t("workspace.connectionLostReconnecting").replace(
    "{seconds}",
    String(Math.max(0, reconnectState.secondsRemaining))
  );

  const formatAccessType = (accessType: string, role: string) => {
    if (accessType === "manage") return "Manage";
    if (accessType === "write") return "Read + write";
    if (accessType === "read") return "Read only";
    return role;
  };
  const formatRoleLabel = (role: string) => {
    if (role === "ReadWrite") return "Read write";
    if (role === "ReadOnly") return "Read only";
    return role;
  };
  const formatAccessSource = (source: string) => {
    if (source === "share_link_invite") return "Accepted share link";
    if (source === "direct_role") return "Direct assignment";
    if (source.startsWith("organization:")) {
      return `Organization (${source.slice("organization:".length)})`;
    }
    return source;
  };

  useEffect(() => {
    assetMetaRef.current = assetMeta;
  }, [assetMeta]);

  useEffect(() => {
    assetBase64Ref.current = assetBase64;
  }, [assetBase64]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    entryFilePathRef.current = entryFilePath;
  }, [entryFilePath]);

  useEffect(() => {
    docTextRef.current = docText;
  }, [docText]);

  useEffect(() => {
    hasActiveLiveDocRef.current = hasActiveLiveDoc;
  }, [hasActiveLiveDoc]);

  useEffect(() => {
    const unsub = subscribeTypstRuntimeStatus((status) => setTypstRuntimeStatus(status));
    return () => unsub();
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!project?.is_template) return;
    setCopyDialog((current) => {
      if (current && current.projectId === project.id) return current;
      return {
        projectId: project.id,
        sourceName: project.name,
        suggestedName: `${project.name} ${t("projects.copySuffix")}`
      };
    });
  }, [project?.id, project?.is_template, project?.name, t]);

  useEffect(() => {
    setTemplateEnabled(!!project?.is_template);
  }, [project?.id, project?.is_template]);

  useEffect(() => {
    return () => {
      if (copyNoticeTimerRef.current) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
      if (thumbnailUploadTimerRef.current) {
        window.clearTimeout(thumbnailUploadTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    revisionHeadSeqRef.current += 1;
    revisionMoreSeqRef.current += 1;
    assetLoadInflightRef.current.clear();
    assetLoadFailedRef.current.clear();
    setWorkspaceLoaded(false);
    setWorkspaceError(null);
    setRevisions([]);
    setRevisionsHasMore(true);
    setRevisionsLoadingMore(false);
    setActiveRevisionId(null);
    setRevisionDocs({});
    setRevisionNodes([]);
    setRevisionAssetBase64({});
    setRevisionAssetMeta({});
    setRevisionEntryFilePath("main.typ");
    setRevisionLoading({
      active: false,
      revisionId: null,
      loadedBytes: 0,
      totalBytes: null
    });
    setAssetHydrationProgress({
      active: false,
      loaded: 0,
      total: 0,
      loadedBytes: 0,
      totalBytes: 0
    });
    setCompileErrors([]);
    setCompileDiagnostics([]);
    setVectorData(null);
    setPdfData(null);
    setDocText("");
    setContextMenu(null);
    setProjectTemplateOrgAccess([]);
    lastDocsSyncAtRef.current = null;
    refreshProjectData().catch((err) => {
      const message = err instanceof Error ? err.message : "Unable to load workspace";
      setWorkspaceError(message);
      setApiReachable(false);
      setWorkspaceLoaded(true);
      setWorkspaceSyncPending(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || isRevisionMode) return;
    const nextDocs = { ...docs };
    if (activePath && Object.prototype.hasOwnProperty.call(nextDocs, activePath)) {
      nextDocs[activePath] = docText;
    }
    saveProjectSnapshotToCache({
      projectId,
      entryFilePath,
      nodes,
      docs: nextDocs
    });
  }, [activePath, docText, docs, entryFilePath, isRevisionMode, nodes, projectId, workspaceLoaded]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const response = await fetch("/health", { cache: "no-store", credentials: "include" });
        if (cancelled) return;
        setApiReachable(response.ok);
      } catch {
        if (cancelled) return;
        setApiReachable(false);
      }
    };
    run().catch(() => undefined);
    const timer = window.setInterval(() => {
      run().catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (effectiveShowRevisionPanel) return;
    if (!activeRevisionId) return;
    setActiveRevisionId(null);
    setRevisionDocs({});
    setRevisionNodes([]);
    setRevisionAssetBase64({});
    setRevisionAssetMeta({});
    setRevisionEntryFilePath("main.typ");
    setRevisionLoading({
      active: false,
      revisionId: null,
      loadedBytes: 0,
      totalBytes: null
    });
  }, [activeRevisionId, effectiveShowRevisionPanel]);

  useEffect(() => {
    if (!queuedJump) return;
    if (queuedJump.path !== activePath) return;
    setJumpTarget({
      line: queuedJump.line,
      column: queuedJump.column,
      token: Date.now()
    });
    setQueuedJump(null);
  }, [activePath, queuedJump]);

  useEffect(() => {
    if (!isRevisionMode) return;
    setDocText(revisionDocs[activePath] ?? "");
  }, [activePath, isRevisionMode, revisionDocs, setDocText]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded) return;
    const timer = window.setInterval(() => {
      const requestSeq = revisionHeadSeqRef.current + 1;
      revisionHeadSeqRef.current = requestSeq;
      listRevisions(projectId, { limit: REVISION_PAGE_SIZE })
        .then((res) => {
          if (revisionHeadSeqRef.current !== requestSeq) return;
          setApiReachable(true);
          const latest = res.revisions || [];
          setRevisions((previous) => prependUniqueById(latest, previous));
        })
        .catch(() => setApiReachable(false));
    }, 8000);
    return () => window.clearInterval(timer);
  }, [projectId, workspaceLoaded]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || isRevisionMode || workspaceSyncPending) return;
    const timer = window.setInterval(() => {
      syncWorkspaceFromServerRef.current().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [isRevisionMode, projectId, workspaceLoaded, workspaceSyncPending]);

  useEffect(() => {
    if (!projectId || !activePath || isRevisionMode || !workspaceLoaded || !realtimeDocReady) return;
    if (!hasActiveLiveDoc) return;
    if (docText === lastSavedDocRef.current) return;
    const timer = window.setTimeout(() => {
      upsertDocumentByPath(projectId, activePath, docText)
        .then((saved) => {
          setApiReachable(true);
          lastSavedDocRef.current = saved.content;
          setDocs((prev) => ({ ...prev, [saved.path]: saved.content }));
        })
        .catch(() => {
          setApiReachable(false);
        });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [
    activePath,
    docText,
    hasActiveLiveDoc,
    isRevisionMode,
    lastSavedDocRef,
    projectId,
    realtimeDocReady,
    workspaceLoaded
  ]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || isRevisionMode || !activePath) return;
    if (isTextFile(activePath)) return;
    if (assetBase64Ref.current[activePath]) return;
    let cancelled = false;
    (async () => {
      await syncWorkspaceFromServerRef.current().catch(() => undefined);
      if (cancelled) return;
      if (assetBase64Ref.current[activePath]) return;
      await ensureLiveAssetLoaded(activePath);
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, assetBase64, isRevisionMode, projectId, workspaceLoaded]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || isRevisionMode || workspaceSyncPending) return;
    const total = requiredAssetPaths.length;
    const loaded = requiredAssetPaths.filter((path) => !!assetBase64[path]).length;
    const totalBytes = requiredAssetPaths.reduce(
      (sum, path) => sum + Math.max(0, assetMeta[path]?.sizeBytes || 0),
      0
    );
    const loadedBytes = requiredAssetPaths.reduce(
      (sum, path) => sum + (assetBase64[path] ? Math.max(0, assetMeta[path]?.sizeBytes || 0) : 0),
      0
    );
    const missing = requiredAssetPaths.filter(
      (path) => !assetBase64[path] && !assetLoadFailedRef.current.has(path)
    );
    setAssetHydrationProgress({
      active: missing.length > 0,
      loaded,
      total,
      loadedBytes,
      totalBytes
    });
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const path of missing) {
        if (cancelled) return;
        await ensureLiveAssetLoaded(path);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    assetBase64,
    assetMeta,
    isRevisionMode,
    projectId,
    requiredAssetPaths,
    workspaceLoaded,
    workspaceSyncPending
  ]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded) return;
    if (!isRevisionMode && workspaceSyncPending) return;
    const applyCompileOutput = (output: CompileOutput) => {
      setVectorData(output.vectorData);
      setPdfData(output.pdfData);
      setCompileErrors(output.errors);
      setCompileDiagnostics(output.diagnostics);
    };
    let cancelled = false;
    if (compileDocuments.length === 0) {
      lastCompileInputKeyRef.current = "";
      lastCompileOutputRef.current = null;
      setVectorData(null);
      setPdfData(null);
      setCompileErrors(["Project has no source documents"]);
      setCompileDiagnostics([]);
      return;
    }
    if (!isRevisionMode) {
      const hasPendingAssets = requiredAssetPaths.some(
        (path) => !assetBase64[path] && !assetLoadFailedRef.current.has(path)
      );
      if (hasPendingAssets) return;
    }
    if (compileInputKey === lastCompileInputKeyRef.current && lastCompileOutputRef.current) {
      applyCompileOutput(lastCompileOutputRef.current);
      return;
    }
    startTransition(() => {
      compileTypstClientSide({
        entryFilePath: sourceEntryFilePath,
        documents: compileDocuments,
        assets: compileAssets,
        coreApiUrl: "",
        fontData,
        appOrigin: window.location.origin
      }).then((output) => {
        if (cancelled) return;
        lastCompileInputKeyRef.current = compileInputKey;
        lastCompileOutputRef.current = output;
        applyCompileOutput(output);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    assetBase64,
    assetMeta,
    compileAssets,
    compileDocuments,
    compileInputKey,
    fontData,
    isRevisionMode,
    projectId,
    requiredAssetPaths,
    sourceEntryFilePath,
    workspaceLoaded,
    workspaceSyncPending
  ]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || isRevisionMode || !effectiveShowPreviewPanel) return;
    if (!authUser) return;
    if (!vectorData || compileDiagnostics.length > 0 || compileErrors.length > 0) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const firstCanvas = frame.querySelector(".pdf-pages canvas") as HTMLCanvasElement | null;
    if (!firstCanvas) return;
    if (thumbnailUploadTimerRef.current) {
      window.clearTimeout(thumbnailUploadTimerRef.current);
    }
    thumbnailUploadTimerRef.current = window.setTimeout(() => {
      const latestCanvas = (canvasPreviewRef.current?.querySelector(".pdf-pages canvas") ||
        firstCanvas) as HTMLCanvasElement | null;
      if (!latestCanvas) return;
      const dataUrl = buildTopPreviewThumbnail(latestCanvas);
      const base64 = dataUrl.split(",")[1] || "";
      if (!base64) return;
      const digest = `${base64.length}:${base64.slice(0, 128)}`;
      if (digest === lastUploadedThumbnailRef.current) return;
      uploadProjectThumbnail(projectId, {
        content_base64: base64,
        content_type: "image/png"
      })
        .then(() => {
          lastUploadedThumbnailRef.current = digest;
        })
        .catch(() => undefined);
    }, 1200);
    return () => {
      if (thumbnailUploadTimerRef.current) {
        window.clearTimeout(thumbnailUploadTimerRef.current);
        thumbnailUploadTimerRef.current = null;
      }
    };
  }, [
    canvasPreviewRef,
    compileDiagnostics.length,
    compileErrors.length,
    isRevisionMode,
    previewRenderTick,
    projectId,
    effectiveShowPreviewPanel,
    vectorData,
    workspaceLoaded,
    authUser
  ]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".context-menu")) return;
      setContextMenu(null);
    };
    const closeOnScroll = () => setContextMenu(null);
    window.addEventListener("click", closeMenu, true);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      window.removeEventListener("click", closeMenu, true);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [contextMenu]);

  const refreshProjectData = async () => {
    if (!projectId) return;
    if (project?.is_template && !project.can_read) {
      setWorkspaceLoaded(true);
      setWorkspaceSyncPending(false);
      return;
    }
    setWorkspaceSyncPending(true);
    setWorkspaceLoaded(false);
    const anyCached = loadProjectSnapshotFromCache(projectId);
    const parsedServerLastEditedMs = project?.last_edited_at ? Date.parse(project.last_edited_at) : Number.NaN;
    const serverLastEditedMs = Number.isFinite(parsedServerLastEditedMs) ? parsedServerLastEditedMs : null;
    const minFreshCacheMs =
      serverLastEditedMs === null ? undefined : Math.max(0, serverLastEditedMs - 3000);
    const freshCached = loadProjectSnapshotFromCache(projectId, { minCachedAtMs: minFreshCacheMs });
    if (freshCached) {
      setNodes(freshCached.nodes);
      setEntryFilePath(freshCached.entryFilePath || "main.typ");
      setDocs(freshCached.docs || {});
      const fallbackPath = pickWorkspaceOpenPath(
        freshCached.nodes,
        freshCached.entryFilePath || "main.typ",
        activePath
      );
      setActivePath(fallbackPath);
      setExpandedDirs((prev) => expandAncestors(fallbackPath, prev));
      setWorkspaceLoaded(true);
    }
    const sharePromise = canManageProject ? listProjectShareLinks(projectId).catch(() => []) : Promise.resolve([]);
    const orgAccessPromise = canManageProject ? listProjectOrganizationAccess(projectId).catch(() => []) : Promise.resolve([]);
    const templateOrgAccessPromise = canManageProject
      ? listProjectTemplateOrganizationAccess(projectId).catch(() => [])
      : Promise.resolve([]);
    const accessUsersPromise = canManageProject
      ? listProjectAccessUsers(projectId).then((res) => res.users).catch(() => [])
      : Promise.resolve([]);
    const responseTuple = await Promise.all([
      getProjectTree(projectId),
      getProjectSettings(projectId).catch(() => ({ entry_file_path: "main.typ" })),
      getGitRepoLink(projectId).catch(() => ({ repo_url: "" })),
      listDocuments(projectId),
      listRevisions(projectId, { limit: REVISION_PAGE_SIZE }).catch(() => ({ revisions: [] })),
      listProjectAssets(projectId).catch(() => ({ assets: [] })),
      sharePromise,
      orgAccessPromise,
      templateOrgAccessPromise,
      accessUsersPromise
    ]).catch((err) => {
      if (anyCached) {
        if (!freshCached) {
          setNodes(anyCached.nodes);
          setEntryFilePath(anyCached.entryFilePath || "main.typ");
          setDocs(anyCached.docs || {});
          const fallbackPath = pickWorkspaceOpenPath(
            anyCached.nodes,
            anyCached.entryFilePath || "main.typ",
            activePath
          );
          setActivePath(fallbackPath);
          setExpandedDirs((prev) => expandAncestors(fallbackPath, prev));
          setWorkspaceLoaded(true);
        }
        setWorkspaceError("Working from cached project data (offline mode).");
        setApiReachable(false);
        setWorkspaceSyncPending(false);
        return null;
      }
      throw err;
    });
    if (!responseTuple) return;
    let [
      treeRes,
      settings,
      git,
      docsRes,
      revisionsRes,
      assetsRes,
      shareRes,
      orgAccessRes,
      templateOrgAccessRes,
      accessUsersRes
    ] = responseTuple;
    if (!treeRes.nodes.some((node) => node.kind === "file")) {
      await createProjectFile(projectId, {
        path: "main.typ",
        kind: "file",
        content: ""
      }).catch(() => undefined);
      const [nextTree, nextDocs] = await Promise.all([getProjectTree(projectId), listDocuments(projectId)]);
      treeRes = nextTree;
      docsRes = nextDocs;
    }
    setNodes(treeRes.nodes);
    setEntryFilePath(settings.entry_file_path || treeRes.entry_file_path || "main.typ");
    setGitRepoUrl(git.repo_url || "");
    const initialRevisions = revisionsRes.revisions || [];
    setRevisions(initialRevisions);
    setRevisionsHasMore(initialRevisions.length >= REVISION_PAGE_SIZE);
    setRevisionsLoadingMore(false);
    setShareLinks(shareRes);
    setProjectOrgAccess(orgAccessRes);
    setProjectTemplateOrgAccess(templateOrgAccessRes);
    setProjectAccessUsers(accessUsersRes);

    const nextDocs: Record<string, string> = {};
    for (const doc of docsRes.documents) nextDocs[doc.path] = doc.content;
    lastDocsSyncAtRef.current = maxDocumentUpdatedAtIso(docsRes.documents, new Date().toISOString());
    setDocs(nextDocs);
    saveProjectSnapshotToCache({
      projectId,
      entryFilePath: settings.entry_file_path || treeRes.entry_file_path || "main.typ",
      nodes: treeRes.nodes,
      docs: nextDocs
    });

    const nextAssetMeta: Record<string, AssetMeta> = {};
    for (const asset of assetsRes.assets) {
      nextAssetMeta[asset.path] = {
        id: asset.id,
        objectKey: asset.object_key,
        contentType: asset.content_type,
        sizeBytes: asset.size_bytes,
        createdAt: asset.created_at
      };
    }
    assetMetaRef.current = nextAssetMeta;
    setAssetMeta(nextAssetMeta);
    assetLoadFailedRef.current.clear();
    setAssetBase64((prev) => {
      const next: Record<string, string> = {};
      for (const [path, value] of Object.entries(prev)) {
        if (nextAssetMeta[path]) next[path] = value;
      }
      assetBase64Ref.current = next;
      return next;
    });

    if (!activePath || !treeRes.nodes.some((node) => node.path === activePath)) {
      const target = pickWorkspaceOpenPath(
        treeRes.nodes,
        settings.entry_file_path || treeRes.entry_file_path || "main.typ",
        activePath
      );
      setActivePath(target);
      setExpandedDirs((prev) => expandAncestors(target, prev));
    }
    setApiReachable(true);
    setWorkspaceError(null);
    setWorkspaceLoaded(true);
    await hydrateProjectAssetsForInitialLoad(nextDocs, nextAssetMeta);
    setWorkspaceSyncPending(false);
  };

  const syncWorkspaceFromServer = async () => {
    if (!projectId || isRevisionMode || remoteSyncInflightRef.current) return;
    remoteSyncInflightRef.current = true;
    try {
      const [treeRes, settings, docsRes, assetsRes] = await Promise.all([
        getProjectTree(projectId),
        getProjectSettings(projectId).catch(() => ({
          entry_file_path: entryFilePathRef.current || "main.typ"
        })),
        listDocuments(projectId, { sinceUpdatedAt: lastDocsSyncAtRef.current }),
        listProjectAssets(projectId)
      ]);
      setApiReachable(true);

      const nextEntry =
        settings.entry_file_path || treeRes.entry_file_path || entryFilePathRef.current || "main.typ";
      const nextNodes = treeRes.nodes;
      setNodes(nextNodes);
      setEntryFilePath(nextEntry);

      const incomingDocs: Record<string, string> = {};
      for (const doc of docsRes.documents) incomingDocs[doc.path] = doc.content;
      if (docsRes.documents.length > 0) {
        lastDocsSyncAtRef.current = maxDocumentUpdatedAtIso(
          docsRes.documents,
          lastDocsSyncAtRef.current
        );
      }
      const currentActivePath = activePathRef.current;
      const localDirty =
        !!currentActivePath &&
        hasActiveLiveDocRef.current &&
        docTextRef.current !== lastSavedDocRef.current;
      const activeIncoming = currentActivePath ? incomingDocs[currentActivePath] : undefined;
      if (
        currentActivePath &&
        typeof activeIncoming === "string" &&
        activeIncoming !== lastSavedDocRef.current &&
        !localDirty
      ) {
        const ytext = ytextRef.current;
        if (ytext) {
          const current = ytext.toString();
          if (current !== activeIncoming) {
            ytext.doc?.transact(() => {
              ytext.delete(0, ytext.length);
              ytext.insert(0, activeIncoming);
            }, "remote");
          }
        } else if (docTextRef.current !== activeIncoming) {
          setDocText(activeIncoming);
        }
        lastSavedDocRef.current = activeIncoming;
      }
      const textFilePaths = new Set(
        nextNodes.filter((node) => node.kind === "file" && isTextFile(node.path)).map((node) => node.path)
      );
      let docsForCache: Record<string, string> = {};
      setDocs((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const [path, content] of Object.entries(incomingDocs)) {
          if (!isTextFile(path)) continue;
          if (path === currentActivePath && localDirty) continue;
          if (next[path] !== content) {
            next[path] = content;
            changed = true;
          }
        }
        for (const path of Object.keys(next)) {
          if (!textFilePaths.has(path)) {
            if (path === currentActivePath && localDirty) {
              next[path] = docTextRef.current;
              continue;
            }
            delete next[path];
            changed = true;
          }
        }
        docsForCache = changed ? next : previous;
        return changed ? next : previous;
      });
      saveProjectSnapshotToCache({
        projectId,
        entryFilePath: nextEntry,
        nodes: nextNodes,
        docs: docsForCache
      });

      const nextAssetMeta: Record<string, AssetMeta> = {};
      for (const asset of assetsRes.assets) {
        nextAssetMeta[asset.path] = {
          id: asset.id,
          objectKey: asset.object_key,
          contentType: asset.content_type,
          sizeBytes: asset.size_bytes,
          createdAt: asset.created_at
        };
      }
      const previousMeta = assetMetaRef.current;
      assetMetaRef.current = nextAssetMeta;
      setAssetMeta(nextAssetMeta);
      setAssetBase64((previous) => {
        const next: Record<string, string> = {};
        for (const [path, value] of Object.entries(previous)) {
          const latest = nextAssetMeta[path];
          const old = previousMeta[path];
          if (!latest || !old) continue;
          const sameVersion =
            latest.id === old.id &&
            latest.objectKey === old.objectKey &&
            latest.createdAt === old.createdAt &&
            latest.sizeBytes === old.sizeBytes &&
            latest.contentType === old.contentType;
          if (sameVersion) next[path] = value;
        }
        assetBase64Ref.current = next;
        return next;
      });

      const filePaths = new Set(nextNodes.filter((node) => node.kind === "file").map((node) => node.path));
      const currentPath = activePathRef.current;
      if (!currentPath || !filePaths.has(currentPath)) {
        const fallbackPath = pickWorkspaceOpenPath(nextNodes, nextEntry, currentPath);
        setActivePath(fallbackPath);
        setExpandedDirs((prev) => expandAncestors(fallbackPath, prev));
      }
    } catch {
      setApiReachable(false);
    } finally {
      remoteSyncInflightRef.current = false;
    }
  };
  syncWorkspaceFromServerRef.current = syncWorkspaceFromServer;

  function addPath(kind: "file" | "directory", parentPath = "") {
    if (!projectId || !canWrite || isRevisionMode) return;
    const placeholder = kind === "file" ? "untitled.typ" : "folder";
    setPathDialog({
      mode: "create",
      kind,
      parentPath,
      value: joinProjectPath(parentPath, placeholder)
    });
  }

  function renamePath(path: string) {
    if (!projectId || !canWrite || isRevisionMode) return;
    setPathDialog({
      mode: "rename",
      path,
      value: path
    });
  }

  function removePath(path: string) {
    if (!projectId || !canWrite || isRevisionMode) return;
    setPathDialog({
      mode: "delete",
      path
    });
  }

  async function submitPathDialog() {
    if (!projectId || !pathDialog || !canWrite || isRevisionMode) return;
    try {
      setContextMenu(null);
      if (pathDialog.mode === "create") {
        let normalized = normalizePath(pathDialog.value);
        if (pathDialog.parentPath && !normalized.includes("/")) {
          normalized = joinProjectPath(pathDialog.parentPath, normalized);
        }
        if (!normalized) return;
        await createProjectFile(projectId, {
          path: normalized,
          kind: pathDialog.kind,
          content: pathDialog.kind === "file" ? "" : undefined
        });
        await refreshProjectData();
        if (pathDialog.kind === "file") setActivePath(normalized);
      } else if (pathDialog.mode === "rename") {
        let normalizedTo = normalizePath(pathDialog.value);
        const parentPath = parentProjectPath(pathDialog.path);
        if (parentPath && !normalizedTo.includes("/")) {
          normalizedTo = joinProjectPath(parentPath, normalizedTo);
        }
        if (!normalizedTo || normalizedTo === pathDialog.path) {
          setPathDialog(null);
          return;
        }
        await moveProjectFile(projectId, pathDialog.path, normalizedTo);
        await refreshProjectData();
        if (activePath === pathDialog.path) setActivePath(normalizedTo);
      } else {
        await deleteProjectFile(projectId, pathDialog.path);
        if (activePath === pathDialog.path) setActivePath(entryFilePath);
        await refreshProjectData();
      }
      setPathDialog(null);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update path";
      setWorkspaceError(message);
    }
  }

  async function commitUploads(items: UploadCandidate[], parentPath = "") {
    if (!projectId || items.length === 0 || !canWrite || isRevisionMode) return;
    try {
      setContextMenu(null);
      for (const item of items) {
        const path = normalizePath(joinProjectPath(parentPath, item.relativePath || item.file.name));
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        if (isTextFile(path) || item.file.type.startsWith("text/")) {
          const text = new TextDecoder().decode(bytes);
          await upsertDocumentByPath(projectId, path, text);
          setDocs((prev) => ({ ...prev, [path]: text }));
        } else {
          const binary = Array.from(bytes, (value) => String.fromCharCode(value)).join("");
          await uploadProjectAsset(projectId, {
            path,
            content_base64: btoa(binary),
            content_type: item.file.type || "application/octet-stream"
          });
        }
      }
      await refreshProjectData();
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to upload";
      setWorkspaceError(message);
    }
  }

  function uploadFromPicker(parentPath = "") {
    if (!canWrite || isRevisionMode) return;
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.onchange = async () => {
      const files = Array.from(picker.files || []).map((file) => ({
        relativePath: file.name,
        file
      }));
      await commitUploads(files, parentPath);
    };
    picker.click();
  }

  async function collectDragFiles(dataTransfer: DataTransfer): Promise<UploadCandidate[]> {
    const output: UploadCandidate[] = [];
    const pending: Array<Promise<void>> = [];
    const itemList = Array.from(dataTransfer.items || []);

    const walkEntry = async (entry: any, prefix: string) => {
      if (!entry) return;
      if (entry.isFile) {
        await new Promise<void>((resolve) => {
          entry.file(
            (file: File) => {
              const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
              output.push({ relativePath, file });
              resolve();
            },
            () => resolve()
          );
        });
        return;
      }
      if (!entry.isDirectory) return;
      const currentPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      const readAll = async (): Promise<any[]> => {
        const all: any[] = [];
        while (true) {
          const batch = await new Promise<any[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
          if (!batch.length) break;
          all.push(...batch);
        }
        return all;
      };
      const entries = await readAll();
      for (const child of entries) {
        await walkEntry(child, currentPrefix);
      }
    };

    for (const item of itemList) {
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry) {
        pending.push(walkEntry(entry, ""));
      } else {
        const file = item.getAsFile();
        if (!file) continue;
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        output.push({ relativePath, file });
      }
    }
    if (pending.length > 0) {
      await Promise.all(pending);
      return output;
    }
    for (const file of Array.from(dataTransfer.files || [])) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      output.push({ relativePath, file });
    }
    return output;
  }

  async function onTreeDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setFilesDropActive(false);
    if (!canWrite || isRevisionMode) return;
    const items = await collectDragFiles(event.dataTransfer);
    await commitUploads(items, "");
  }

  async function downloadArchive() {
    if (!projectId) return;
    try {
      const blob = await downloadProjectArchive(projectId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project?.name || "project"}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to download archive";
      setWorkspaceError(message);
    }
  }

  async function createShare(permission: "read" | "write") {
    if (!projectId) return;
    try {
      await createProjectShareLink(projectId, { permission });
      const latest = await listProjectShareLinks(projectId);
      setShareLinks(latest);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create share link";
      setWorkspaceError(message);
    }
  }

  async function revokeShare(shareLinkId: string) {
    if (!projectId) return;
    try {
      await revokeProjectShareLink(projectId, shareLinkId);
      const latest = await listProjectShareLinks(projectId);
      setShareLinks(latest);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to revoke share link";
      setWorkspaceError(message);
    }
  }

  async function copyToClipboard(controlKey: string, value: string) {
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedControl(controlKey);
      if (copyNoticeTimerRef.current) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
      copyNoticeTimerRef.current = window.setTimeout(() => {
        setCopiedControl((current) => (current === controlKey ? null : current));
      }, 1600);
      setWorkspaceError(null);
    } catch {
      setWorkspaceError("Unable to copy to clipboard");
    }
  }

  async function createProjectFromTemplate() {
    if (!copyDialog || !copyDialog.suggestedName.trim()) return;
    try {
      setCopyBusy(true);
      const created = await copyProject(copyDialog.projectId, {
        name: copyDialog.suggestedName.trim()
      });
      setCopyDialog(null);
      await refreshProjects().catch(() => undefined);
      navigate(`/project/${created.id}`, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t("projects.copyFailed");
      setWorkspaceError(message);
    } finally {
      setCopyBusy(false);
    }
  }

  async function submitProjectRename() {
    if (!renameDialog || !renameDialog.nextName.trim()) return;
    try {
      setRenameBusy(true);
      await renameProject(renameDialog.projectId, renameDialog.nextName.trim());
      await refreshProjects();
      setRenameDialog(null);
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : t("projects.renameFailed"));
    } finally {
      setRenameBusy(false);
    }
  }

  async function upsertOrgAccessGrant(organizationId: string, permission: "read" | "write") {
    if (!projectId) return;
    try {
      await upsertProjectOrganizationAccess(projectId, organizationId, permission);
      const [grants, users] = await Promise.all([
        listProjectOrganizationAccess(projectId).catch(() => []),
        listProjectAccessUsers(projectId).then((res) => res.users).catch(() => [])
      ]);
      setProjectOrgAccess(grants);
      setProjectAccessUsers(users);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update organization access";
      setWorkspaceError(message);
    }
  }

  async function setTemplateState(next: boolean) {
    if (!projectId) return;
    try {
      await updateProjectTemplate(projectId, next);
      setTemplateEnabled(next);
      await refreshProjects().catch(() => undefined);
      if (next) {
        const grants = await listProjectTemplateOrganizationAccess(projectId).catch(() => []);
        setProjectTemplateOrgAccess(grants);
      } else {
        setProjectTemplateOrgAccess([]);
      }
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update template settings";
      setWorkspaceError(message);
    }
  }

  async function removeOrgAccessGrant(organizationId: string) {
    if (!projectId) return;
    try {
      await deleteProjectOrganizationAccess(projectId, organizationId);
      const [grants, users] = await Promise.all([
        listProjectOrganizationAccess(projectId).catch(() => []),
        listProjectAccessUsers(projectId).then((res) => res.users).catch(() => [])
      ]);
      setProjectOrgAccess(grants);
      setProjectAccessUsers(users);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to remove organization access";
      setWorkspaceError(message);
    }
  }

  async function upsertTemplateOrgAccessGrant(organizationId: string) {
    if (!projectId) return;
    try {
      await upsertProjectTemplateOrganizationAccess(projectId, organizationId);
      const grants = await listProjectTemplateOrganizationAccess(projectId).catch(() => []);
      setProjectTemplateOrgAccess(grants);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update template access";
      setWorkspaceError(message);
    }
  }

  async function removeTemplateOrgAccessGrant(organizationId: string) {
    if (!projectId) return;
    try {
      await deleteProjectTemplateOrganizationAccess(projectId, organizationId);
      const grants = await listProjectTemplateOrganizationAccess(projectId).catch(() => []);
      setProjectTemplateOrgAccess(grants);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update template access";
      setWorkspaceError(message);
    }
  }

  async function loadMoreRevisions() {
    if (!projectId || revisionsLoadingMore || !revisionsHasMore) return;
    const beforeRevisionId = revisions.length > 0 ? revisions[revisions.length - 1].id : null;
    if (!beforeRevisionId) {
      setRevisionsHasMore(false);
      return;
    }
    const requestSeq = revisionMoreSeqRef.current + 1;
    revisionMoreSeqRef.current = requestSeq;
    setRevisionsLoadingMore(true);
    try {
      const response = await listRevisions(projectId, {
        before: beforeRevisionId,
        limit: REVISION_PAGE_SIZE
      });
      if (revisionMoreSeqRef.current !== requestSeq) return;
      setApiReachable(true);
      const page = response.revisions || [];
      if (page.length === 0) {
        setRevisionsHasMore(false);
        return;
      }
      let appendedCount = 0;
      setRevisions((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        const additions = page.filter((item) => !seen.has(item.id));
        appendedCount = additions.length;
        return additions.length > 0 ? [...previous, ...additions] : previous;
      });
      if (page.length < REVISION_PAGE_SIZE || appendedCount === 0) {
        setRevisionsHasMore(false);
      }
    } catch {
      setApiReachable(false);
    } finally {
      if (revisionMoreSeqRef.current === requestSeq) {
        setRevisionsLoadingMore(false);
      }
    }
  }

  async function openRevision(revisionId: string) {
    if (!projectId) return;
    if (activeRevisionId === revisionId) {
      revisionLoadSeqRef.current += 1;
      setActiveRevisionId(null);
      setRevisionDocs({});
      setRevisionNodes([]);
      setRevisionAssetBase64({});
      setRevisionAssetMeta({});
      setRevisionEntryFilePath("main.typ");
      setRevisionLoading({
        active: false,
        revisionId: null,
        loadedBytes: 0,
        totalBytes: null
      });
      return;
    }
    const requestSeq = revisionLoadSeqRef.current + 1;
    revisionLoadSeqRef.current = requestSeq;
    setRevisionLoading({
      active: true,
      revisionId,
      loadedBytes: 0,
      totalBytes: null
    });
    const currentRevisionAnchorId = activeRevisionId;
    const progressHandler = (progress: { loadedBytes: number; totalBytes: number | null }) => {
      if (revisionLoadSeqRef.current !== requestSeq) return;
      setRevisionLoading({
        active: true,
        revisionId,
        loadedBytes: progress.loadedBytes,
        totalBytes: progress.totalBytes
      });
    };

    const applyRevisionTransfer = (
      response: Awaited<ReturnType<typeof getRevisionDocuments>>,
      forceFull = false
    ): boolean => {
      const transferMode =
        !forceFull && response.transfer_mode === "delta" ? "delta" : "full";
      const baseAnchor = response.base_anchor ?? "none";
      const baseRevisionId = response.base_revision_id ?? null;

      let map: Record<string, string> = {};
      let revisionAssets: Record<string, string> = {};
      let revisionAssetMetaMap: Record<string, AssetMeta> = {};

      if (transferMode === "delta") {
        if (
          baseAnchor === "revision" &&
          baseRevisionId &&
          currentRevisionAnchorId &&
          baseRevisionId === currentRevisionAnchorId
        ) {
          map = { ...revisionDocs };
          revisionAssets = { ...revisionAssetBase64 };
          revisionAssetMetaMap = { ...revisionAssetMeta };
        } else if (baseAnchor === "live") {
          map = { ...docs };
          revisionAssets = { ...assetBase64 };
          revisionAssetMetaMap = { ...assetMeta };
        } else if (baseAnchor === "none") {
          map = {};
          revisionAssets = {};
          revisionAssetMetaMap = {};
        } else {
          return false;
        }
      }

      for (const path of response.deleted_documents || []) {
        delete map[path];
      }
      for (const doc of response.documents || []) {
        map[doc.path] = doc.content;
      }

      for (const path of response.deleted_assets || []) {
        delete revisionAssets[path];
        delete revisionAssetMetaMap[path];
      }
      for (const asset of response.assets || []) {
        revisionAssets[asset.path] = asset.content_base64;
        revisionAssetMetaMap[asset.path] = {
          contentType: asset.content_type
        };
      }

      setRevisionDocs(map);
      setRevisionNodes(response.nodes || []);
      setRevisionAssetBase64(revisionAssets);
      setRevisionAssetMeta(revisionAssetMetaMap);
      setRevisionEntryFilePath(response.entry_file_path || "main.typ");
      setActiveRevisionId(revisionId);
      return true;
    };

    try {
      const response = await getRevisionDocuments(
        projectId,
        revisionId,
        {
          currentRevisionId: currentRevisionAnchorId,
          includeLiveAnchor: true
        },
        progressHandler
      );
      if (revisionLoadSeqRef.current !== requestSeq) return;
      let applied = applyRevisionTransfer(response);
      if (!applied && response.transfer_mode === "delta") {
        const fallback = await getRevisionDocuments(
          projectId,
          revisionId,
          { includeLiveAnchor: false },
          progressHandler
        );
        if (revisionLoadSeqRef.current !== requestSeq) return;
        applied = applyRevisionTransfer(fallback, true);
      }
      if (!applied) {
        throw new Error("Unable to apply revision delta; please retry.");
      }
      setWorkspaceError(null);
    } catch (err) {
      if (revisionLoadSeqRef.current !== requestSeq) return;
      const message = err instanceof Error ? err.message : "Unable to load revision snapshot";
      setWorkspaceError(message);
    } finally {
      if (revisionLoadSeqRef.current === requestSeq) {
        setRevisionLoading((prev) => ({
          ...prev,
          active: false
        }));
      }
    }
  }

  function downloadCompiledPdf() {
    if (!pdfData) return;
    const safeBytes = new Uint8Array(Array.from(pdfData));
    const blob = new Blob([safeBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sourceEntryFilePath.replace(/\.typ$/i, "") + ".pdf";
    a.click();
    URL.revokeObjectURL(url);
  }

  function jumpToDiagnostic(diagnostic: CompileDiagnostic) {
    const path = normalizePath(diagnostic.path || activePath);
    const line = Math.max(1, diagnostic.line ?? 1);
    const column = Math.max(1, diagnostic.column ?? 1);
    if (!path) {
      setJumpTarget({
        line,
        column,
        token: Date.now()
      });
      return;
    }
    setExpandedDirs((prev) => expandAncestors(path, prev));
    if (path !== activePath) {
      setQueuedJump({ path, line, column });
      setActivePath(path);
      return;
    }
    setJumpTarget({
      line,
      column,
      token: Date.now()
    });
  }

  function requestContextMenu(next: ContextMenuState) {
    setContextMenu(next);
  }

  function beginHorizontalResize(onDelta: (deltaX: number) => void) {
    return (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      let lastX = event.clientX;
      const onMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - lastX;
        lastX = moveEvent.clientX;
        if (deltaX !== 0) onDelta(deltaX);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  function increasePreviewZoom() {
    setPreviewFitMode("manual");
    setPreviewZoom((value) => clampNumber(value + 0.1, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM));
  }

  function decreasePreviewZoom() {
    setPreviewFitMode("manual");
    setPreviewZoom((value) => clampNumber(value - 0.1, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM));
  }

  function toggleRevisionPanel() {
    if (singlePanelMode) {
      setCompactPanelView("revisions");
      return;
    }
    setShowRevisionPanel((shown) => {
      if (shown) {
        revisionLoadSeqRef.current += 1;
        setActiveRevisionId(null);
        setRevisionDocs({});
        setRevisionNodes([]);
        setRevisionAssetBase64({});
        setRevisionAssetMeta({});
        setRevisionEntryFilePath("main.typ");
        setRevisionLoading({
          active: false,
          revisionId: null,
          loadedBytes: 0,
          totalBytes: null
        });
      }
      return !shown;
    });
  }

  function setPreviewFitWholePage() {
    setPreviewFitMode("page");
  }

  function setPreviewFitPageWidth() {
    setPreviewFitMode("width");
  }

  function openTreePathAndFocusEditor(path: string) {
    openTreePath(path);
    if (singlePanelMode) {
      setCompactPanelView("editor");
    }
  }

  const workspaceTopbarControls = useMemo(
    () => (
      <WorkspaceToolbar
        projectId={projectId}
        projects={projects}
        showFilesPanel={effectiveShowFilesPanel}
        showPreviewPanel={effectiveShowPreviewPanel}
        showProjectSettingsPanel={effectiveShowSettingsPanel}
        showRevisionPanel={effectiveShowRevisionPanel}
        collapsePanelsIntoMenu={collapsePanelToggles}
        singlePanelMode={singlePanelMode}
        activePanel={compactPanelView}
        onProjectChange={(nextProjectId) => navigate(`/project/${nextProjectId}`)}
        onRenameProject={() => {
          if (!project) return;
          setRenameDialog({
            projectId: project.id,
            sourceName: project.name,
            nextName: project.name
          });
        }}
        onToggleFiles={() => {
          if (singlePanelMode) {
            setCompactPanelView("files");
            return;
          }
          setShowFilesPanel((v) => !v);
        }}
        onTogglePreview={() => {
          if (singlePanelMode) {
            setCompactPanelView("preview");
            return;
          }
          setShowPreviewPanel((v) => !v);
        }}
        onToggleSettings={() => {
          if (singlePanelMode) {
            setCompactPanelView("settings");
            return;
          }
          setShowProjectSettingsPanel((v) => !v);
        }}
        onToggleRevisions={toggleRevisionPanel}
        onSelectPanel={setCompactPanelView}
        t={t}
      />
    ),
    [
      collapsePanelToggles,
      compactPanelView,
      effectiveShowPreviewPanel,
      effectiveShowSettingsPanel,
      effectiveShowRevisionPanel,
      navigate,
      projectId,
      projects,
      showFilesPanel,
      singlePanelMode,
      t
    ]
  );

  useEffect(() => {
    onTopbarChange(workspaceTopbarControls);
    return () => onTopbarChange(null);
  }, [onTopbarChange, workspaceTopbarControls]);

  function handleEditorDelta(changes: Array<{ from: number; to: number; insert: string }>) {
    if (canRequestGuestWrite && !guestSessionToken) {
      setAuthModalOpen(true);
      return;
    }
    applyDocumentDeltas(changes);
  }

  async function beginTemporaryGuestEditing() {
    if (!shareToken || !projectId) return;
    const chosenName = guestNameInput.trim();
    if (!chosenName) {
      setGuestAuthError(t("auth.username"));
      return;
    }
    try {
      setGuestAuthError(null);
      const session = await temporaryShareLogin(shareToken, chosenName);
      window.localStorage.setItem("guest.display_name", session.display_name);
      window.localStorage.setItem(`guest.share.${projectId}.session`, session.session_token);
      window.localStorage.setItem(`guest.share.${projectId}.session.id`, session.session_id);
      setGuestDisplayName(session.display_name);
      setGuestSessionToken(session.session_token);
      setGuestSessionId(session.session_id);
      setAuthModalOpen(false);
      realtimeRef.current?.reconnectNow();
    } catch (err) {
      setGuestAuthError(err instanceof Error ? err.message : "Unable to start guest session");
    }
  }

  if (!projectId) return <Navigate to="/projects" replace />;
  if (!project && projects.length > 0 && !projectIdOverride) {
    return <Navigate to={`/project/${projects[0].id}`} replace />;
  }
  if (!project) {
    return (
      <section className="workspace-shell">
        <div className="workspace-access-banner">{t("common.loading")}</div>
      </section>
    );
  }

  return (
    <section className="workspace-shell">
      {isAnonymousShare && (
        <div className="workspace-access-banner" role="status">
          <span>{t("share.savePrompt")}</span>
          <UiButton
            size="sm"
            onClick={() => {
              setGuestAuthError(null);
              setAuthModalOpen(true);
            }}
          >
            {t("share.logIn")}
          </UiButton>
        </div>
      )}
      {!canWrite && !canRequestGuestWrite && (
        <div className="workspace-access-banner" role="status">
          {t("workspace.readOnlyProject")}
        </div>
      )}
      {project?.is_template && (
        <div className="workspace-access-banner template-banner" role="status">
          <span>{`${t("settings.templateEnabled")} · ${t("projects.copyDialogHint")} ${project.name}`}</span>
          <UiButton
            size="sm"
            onClick={() =>
              setCopyDialog({
                projectId: project.id,
                sourceName: project.name,
                suggestedName: `${project.name} ${t("projects.copySuffix")}`
              })
            }
          >
            {t("projects.copyAction")}
          </UiButton>
        </div>
      )}
      <section className="workspace-stage">
        {effectiveShowFilesPanel && (
          <>
            <FileTreePanel
              width={filesPanelWidth}
              filesDropActive={filesDropActive}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setFilesDropActive(true);
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget as Node | null;
                if (!(event.currentTarget as HTMLElement).contains(nextTarget)) {
                  setFilesDropActive(false);
                }
              }}
              onDrop={onTreeDrop}
              canWrite={!!canWrite}
              isRevisionMode={isRevisionMode}
              onAddFile={() => addPath("file")}
              onAddDirectory={() => addPath("directory")}
              onUpload={() => uploadFromPicker()}
              onDownloadArchive={downloadArchive}
              tree={tree}
              activePath={activePath}
              expandedDirs={expandedDirs}
              setExpandedDirs={setExpandedDirs}
              onOpenTreePath={openTreePathAndFocusEditor}
              onRequestContextMenu={requestContextMenu}
              t={t}
            />
            {!singlePanelMode && (
              <div
                className="panel-resizer"
                onMouseDown={beginHorizontalResize((dx) => setFilesPanelWidth((v) => clampNumber(v + dx, 220, 520)))}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize files panel"
              />
            )}
          </>
        )}

        <div className="center-split" ref={centerSplitRef}>
          {effectiveShowEditorPanel && (
            <article
              className="panel panel-editor"
              style={
                effectiveShowPreviewPanel
                  ? { flex: `${editorRatio} 1 0`, minWidth: 320 }
                  : { flex: "1 1 auto", minWidth: 320 }
              }
            >
            <div className="panel-header workspace-main-header">
              <h2 title={activePath}>{activeFileName}</h2>
              <div className="panel-status compact">
                <button className="inline-toggle" onClick={() => setLineWrapEnabled((value) => !value)}>
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
                    editorInstanceKey={`${activePath}:${activeRevisionId ?? "live"}:${currentEditorLanguage}`}
                    value={docText}
                    onDelta={handleEditorDelta}
                    onCursorChange={(cursor) => realtimeRef.current?.sendCursor(cursor)}
                    readOnly={
                      isRevisionMode ||
                      (!canWrite && !canRequestGuestWrite) ||
                      (!isRevisionMode && !realtimeDocReady)
                    }
                    lineWrap={lineWrapEnabled}
                    language={currentEditorLanguage}
                    remoteCursors={remoteCursors}
                    jumpTo={jumpTarget}
                    onJumpHandled={() => setJumpTarget(null)}
                  />
                </div>
              ) : (
                <UnsupportedFilePane
                  path={activePath}
                  hasData={!!activeAssetBase64}
                  isImage={isImageAsset(activePath, activeAssetType)}
                  isPdf={isPdfAsset(activePath, activeAssetType)}
                  dataUrl={assetDataUrl}
                  t={t}
                />
              )}
              {!isActiveEditableTextDoc && <div className="error panel-inline-error">{t("workspace.notEditable")}</div>}
              {isRevisionMode && !activePathExistsInTree && (
                <div className="error panel-inline-error">This file did not exist in this revision snapshot.</div>
              )}
              {showConnectionWarning && realtimeStatus === "disconnected" && (
                <div className="error panel-inline-error connection-warning connection-warning-row">
                  <span>{reconnectState.active ? reconnectCountdownText : t("workspace.connectionLost")}</span>
                  <UiButton size="sm" onClick={() => realtimeRef.current?.reconnectNow()}>
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
          )}

          {!singlePanelMode && effectiveShowEditorPanel && effectiveShowPreviewPanel && (
            <div
              className="panel-resizer"
              onMouseDown={beginHorizontalResize((dx) => {
                const totalWidth = centerSplitRef.current?.getBoundingClientRect().width ?? 1;
                setEditorRatio((current) =>
                  clampNumber(current + dx / Math.max(totalWidth, 1), 0.28, 0.72)
                );
              })}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize editor and preview"
            />
          )}

          {effectiveShowPreviewPanel && (
            <PreviewPanel
              editorRatio={editorRatio}
              previewFitMode={previewFitMode}
              previewPercent={previewPercent}
              previewPageCurrent={previewPageCurrent}
              previewPageTotal={previewPageTotal}
              pdfData={pdfData}
              typstRuntimeStatus={typstRuntimeStatus}
              workspaceSyncPending={workspaceSyncPending}
              assetHydrationProgress={assetHydrationProgress}
              vectorData={vectorData}
              previewIsPanning={previewIsPanning}
              compileDiagnostics={compileDiagnostics}
              compileErrors={compileErrors}
              hasPreviewPage={hasPreviewPage}
              canvasPreviewRef={canvasPreviewRef}
              onBeginPreviewPan={beginPreviewPan}
              onSetFitWholePage={setPreviewFitWholePage}
              onSetFitPageWidth={setPreviewFitPageWidth}
              onDecreaseZoom={decreasePreviewZoom}
              onIncreaseZoom={increasePreviewZoom}
              onJumpToPage={jumpToPreviewPage}
              onDownloadPdf={downloadCompiledPdf}
              onJumpToDiagnostic={jumpToDiagnostic}
              t={t}
            />
          )}
        </div>

        {effectiveShowSettingsPanel && (
          <>
            {!singlePanelMode && (
              <div
                className="panel-resizer"
                onMouseDown={beginHorizontalResize((dx) =>
                  setSettingsPanelWidth((value) => clampNumber(value - dx, 220, 520))
                )}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize project settings panel"
              />
            )}
            {isAnonymousShare ? (
              <aside className="panel panel-right settings-panel" style={{ width: settingsPanelWidth }}>
                <div className="panel-header">
                  <h2>{t("workspace.settings")}</h2>
                </div>
                <div className="panel-content settings-body">
                  <div className="settings-card">
                    <p>{t("share.settingsLoginRequired")}</p>
                    <UiButton
                      onClick={() => {
                        setGuestAuthError(null);
                        setAuthModalOpen(true);
                      }}
                    >
                      {t("share.logIn")}
                    </UiButton>
                  </div>
                </div>
              </aside>
            ) : (
              <SettingsPanel
                width={settingsPanelWidth}
                projectId={projectId}
                entryFilePath={entryFilePath}
                typEntryOptions={typEntryOptions}
                canManageProject={!!canManageProject}
                gitRepoUrl={gitRepoUrl}
                copiedControl={copiedControl}
                templateEnabled={templateEnabled}
                myOrganizations={myOrganizations}
                projectOrgAccess={projectOrgAccess}
                projectTemplateOrgAccess={projectTemplateOrgAccess}
                projectAccessUsers={projectAccessUsers}
                onEntryFileChange={async (path) => {
                  const updated = await upsertProjectSettings(projectId, path);
                  setEntryFilePath(updated.entry_file_path);
                }}
                onCopyToClipboard={copyToClipboard}
                onToggleTemplate={async () => setTemplateState(!templateEnabled)}
                onRevokeTemplateOrgAccess={removeTemplateOrgAccessGrant}
                onGrantTemplateOrgAccess={upsertTemplateOrgAccessGrant}
                activeReadShare={activeReadShare}
                activeWriteShare={activeWriteShare}
                onCreateShare={createShare}
                onRevokeShare={revokeShare}
                onGrantOrgAccess={upsertOrgAccessGrant}
                onRevokeOrgAccess={removeOrgAccessGrant}
                formatAccessType={formatAccessType}
                formatRoleLabel={formatRoleLabel}
                formatAccessSource={formatAccessSource}
                t={t}
              />
            )}
          </>
        )}

        {effectiveShowRevisionPanel && (
          <>
            {!singlePanelMode && (
              <div
                className="panel-resizer"
                onMouseDown={beginHorizontalResize((dx) =>
                  setRevisionsPanelWidth((value) => clampNumber(value - dx, 220, 520))
                )}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize revisions panel"
              />
            )}
            <RevisionsPanel
              width={revisionsPanelWidth}
              revisions={revisions}
              activeRevisionId={activeRevisionId}
              loading={revisionLoading.active}
              loadingRevisionId={revisionLoading.revisionId}
              loadingBytes={revisionLoading.loadedBytes}
              loadingTotalBytes={revisionLoading.totalBytes}
              hasMore={revisionsHasMore}
              loadingMore={revisionsLoadingMore}
              onOpenRevision={openRevision}
              onLoadMore={loadMoreRevisions}
              t={t}
            />
          </>
        )}
      </section>

      {contextMenu && canWrite && (
        <div className="context-menu context-menu-floating" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => addPath("file", contextMenu.path)}>
              {t("workspace.newFile")}
            </UiButton>
          )}
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => addPath("directory", contextMenu.path)}>
              {t("workspace.newFolder")}
            </UiButton>
          )}
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => uploadFromPicker(contextMenu.path)}>
              {t("workspace.upload")}
            </UiButton>
          )}
          <UiButton className="mini" size="sm" onClick={() => renamePath(contextMenu.path)}>
            {t("common.rename")}
          </UiButton>
          <UiButton className="mini" size="sm" variant="danger" onClick={() => removePath(contextMenu.path)}>
            {t("common.delete")}
          </UiButton>
        </div>
      )}
      <UiDialog
        open={!!copyDialog}
        title={t("projects.copyDialogTitle")}
        description={copyDialog ? `${t("projects.copyDialogHint")} ${copyDialog.sourceName}` : undefined}
        onClose={() => setCopyDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setCopyDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              onClick={createProjectFromTemplate}
              disabled={copyBusy || !copyDialog?.suggestedName.trim()}
            >
              {copyBusy ? t("projects.copying") : t("projects.copyAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          value={copyDialog?.suggestedName ?? ""}
          onChange={(e) =>
            setCopyDialog((current) =>
              current
                ? {
                    ...current,
                    suggestedName: e.target.value
                  }
                : current
            )
          }
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>
      <UiDialog
        open={!!renameDialog}
        title={t("projects.renameDialogTitle")}
        description={renameDialog ? `${t("projects.renameDialogHint")} ${renameDialog.sourceName}` : undefined}
        onClose={() => setRenameDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setRenameDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              onClick={submitProjectRename}
              disabled={renameBusy || !renameDialog?.nextName.trim()}
            >
              {renameBusy ? t("common.loading") : t("projects.renameAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          value={renameDialog?.nextName ?? ""}
          onChange={(event) =>
            setRenameDialog((current) => (current ? { ...current, nextName: event.target.value } : current))
          }
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
        onClose={() => setPathDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setPathDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant={pathDialog?.mode === "delete" ? "danger" : "primary"}
              onClick={submitPathDialog}
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
            onChange={(event) =>
              setPathDialog((current) => {
                if (!current || current.mode === "delete") return current;
                return {
                  ...current,
                  value: event.target.value
                };
              })
            }
            placeholder={t("workspace.pathPlaceholder")}
          />
        )}
      </UiDialog>
      <UiDialog
        open={authModalOpen}
        title={canRequestGuestWrite ? t("share.guestEditTitle") : t("auth.signIn")}
        description={
          canRequestGuestWrite
            ? `${t("share.guestEditDescription")} ${project?.name || ""}.`
            : t("share.savePrompt")
        }
        onClose={() => setAuthModalOpen(false)}
      >
        {canRequestGuestWrite && (
          <div className="auth-fields">
            <UiInput
              value={guestNameInput}
              onChange={(event) => setGuestNameInput(event.target.value)}
              placeholder={t("share.yourName")}
            />
            <UiButton variant="primary" onClick={beginTemporaryGuestEditing}>
              {t("share.startGuestEdit")}
            </UiButton>
            <div className="auth-divider">
              <span>{t("share.orLogin")}</span>
            </div>
          </div>
        )}
        <AuthForm
          config={authConfig ?? null}
          t={t}
          compact
          onSignedIn={async () => {
            if (shareToken) {
              await joinProjectShareLink(shareToken).catch(() => undefined);
            }
            if (onSignInFromWorkspace) {
              await onSignInFromWorkspace();
            } else {
              await getAuthMe();
            }
            await refreshProjects();
            setAuthModalOpen(false);
            navigate(`/project/${projectId}`, { replace: true });
          }}
        />
        {guestAuthError && <div className="error">{guestAuthError}</div>}
      </UiDialog>
    </section>
  );
}
