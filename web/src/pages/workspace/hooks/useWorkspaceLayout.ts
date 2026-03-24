import { useEffect, useState } from "react";
import type { WorkspaceLayoutPrefs } from "@/pages/workspace/types";
import {
  clampNumber,
  DEFAULT_LAYOUT_PREFS,
  MAX_EDITOR_RATIO,
  MAX_SIDE_PANEL_WIDTH,
  MIN_EDITOR_RATIO,
  MIN_SIDE_PANEL_WIDTH,
  readWorkspaceLayoutPrefs,
  WORKSPACE_LAYOUT_KEY
} from "@/pages/workspace/utils";

export function useWorkspaceLayout() {
  const [filesPanelWidth, setFilesPanelWidth] = useState(DEFAULT_LAYOUT_PREFS.filesWidth);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(DEFAULT_LAYOUT_PREFS.settingsWidth);
  const [revisionsPanelWidth, setRevisionsPanelWidth] = useState(DEFAULT_LAYOUT_PREFS.revisionsWidth);
  const [editorRatio, setEditorRatio] = useState(DEFAULT_LAYOUT_PREFS.editorRatio);

  useEffect(() => {
    const stored = readWorkspaceLayoutPrefs();
    setFilesPanelWidth(stored.filesWidth);
    setSettingsPanelWidth(stored.settingsWidth);
    setRevisionsPanelWidth(stored.revisionsWidth);
    setEditorRatio(stored.editorRatio);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload: WorkspaceLayoutPrefs = {
      filesWidth: clampNumber(filesPanelWidth, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH),
      settingsWidth: clampNumber(settingsPanelWidth, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH),
      revisionsWidth: clampNumber(revisionsPanelWidth, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH),
      editorRatio: clampNumber(editorRatio, MIN_EDITOR_RATIO, MAX_EDITOR_RATIO)
    };
    window.localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(payload));
  }, [editorRatio, filesPanelWidth, revisionsPanelWidth, settingsPanelWidth]);

  return {
    filesPanelWidth,
    setFilesPanelWidth,
    settingsPanelWidth,
    setSettingsPanelWidth,
    revisionsPanelWidth,
    setRevisionsPanelWidth,
    editorRatio,
    setEditorRatio
  };
}

