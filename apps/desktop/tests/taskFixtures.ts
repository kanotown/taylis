/** M55: tasks for the tests, shaped like the server's TaskOut. */
import type { TaskOut } from "../src/api/types";

let n = 0;

export function task(title: string, extra: Partial<TaskOut> = {}): TaskOut {
  n += 1;
  return {
    id: `t${String(n).padStart(3, "0")}`,
    channel_id: "c-lab",
    channel_name: "lab",
    owner_id: "u-me",
    title,
    notes: null,
    status: "todo",
    position: n,
    due_on: null,
    assignee_ids: [],
    source: null,
    completed_at: null,
    completed_by: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    can_delete: true,
    ...extra,
  };
}
