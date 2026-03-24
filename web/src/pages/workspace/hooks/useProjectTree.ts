import { useEffect, useMemo, useState } from "react";
import type { ProjectNode } from "@/pages/workspace/types";
import { expandAncestors, projectTreeFromFlat } from "@/pages/workspace/utils";

export function useProjectTree(currentNodes: ProjectNode[], activePath: string, setActivePath: (path: string) => void) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([""]));
  const tree = useMemo(() => projectTreeFromFlat(currentNodes), [currentNodes]);

  useEffect(() => {
    setExpandedDirs((prev) => expandAncestors(activePath, prev));
  }, [activePath]);

  const openTreePath = (path: string) => {
    setActivePath(path);
    setExpandedDirs((prev) => expandAncestors(path, prev));
  };

  return {
    tree,
    expandedDirs,
    setExpandedDirs,
    openTreePath
  };
}

