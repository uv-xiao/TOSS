export type ProjectRole = "Owner" | "Teacher" | "Student" | "TA";

export type Organization = {
  id: string;
  name: string;
  created_at: string;
};

export type Project = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  created_at: string;
};

export type Document = {
  id: string;
  project_id: string;
  path: string;
  content: string;
  updated_at: string;
};

export type Revision = {
  id: string;
  project_id: string;
  actor_user_id: string | null;
  summary: string;
  created_at: string;
};

export type Comment = {
  id: string;
  project_id: string;
  actor_user_id: string | null;
  body: string;
  anchor: string | null;
  created_at: string;
};

export type GitSyncState = {
  project_id: string;
  branch: string;
  last_pull_at: string | null;
  last_push_at: string | null;
  has_conflicts: boolean;
  status: "clean" | "pulled" | "pushed" | "conflict" | string;
};

export type AuditEvent = {
  id: string;
  actor_user_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

