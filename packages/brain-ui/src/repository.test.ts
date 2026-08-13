import assert from "node:assert/strict";
import test from "node:test";
import type {
  BrainRepository,
  BrainTaskDto,
  OwnerStatePollResult,
} from "./repository";

const task: BrainTaskDto = {
  id: "task-1",
  title: "shared task",
  status: "todo",
  taskDate: "2026-08-11",
  priority: "normal",
  projectId: null,
  projectName: null,
  rank: "00000000",
  sourcePath: null,
  sourceHeading: null,
  completedAt: null,
  schemaVersion: 3,
  ownerEmail: "owner@example.test",
  version: 1,
  pendingSync: false,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

test("a non-Web fake adapter satisfies the shared repository contract", async () => {
  const state: OwnerStatePollResult = {
    kind: "modified",
    etag: "memory-1",
    state: { revision: 1, pendingCount: 1, lastSyncAt: null },
  };
  const fake: BrainRepository = {
    async listTasks() {
      return [task];
    },
    async listProjects() {
      return [];
    },
    async getOwnerState() {
      return state;
    },
    async updateTaskDate(input) {
      return { ...task, taskDate: input.taskDate, version: input.expectedVersion + 1 };
    },
  };

  assert.deepEqual(await fake.listTasks(), [task]);
  assert.equal((await fake.getOwnerState(null)).kind, "modified");
  assert.equal(
    (await fake.updateTaskDate({ taskId: task.id, expectedVersion: 1, taskDate: null })).taskDate,
    null,
  );
});
