import test from "node:test";
import assert from "node:assert/strict";
import { getGenerationSession } from "../src/components/canvas/state/generationSessions.ts";

function pending(id) {
  return { id, x: 100, y: 200, w: 340, h: 420, prompt: "test", aspect: "1:1", resolution: "2K", refIds: [] };
}

test("switching away and back preserves the running request and latest drag position", () => {
  const session = getGenerationSession("switch-running");
  session.setContainers([pending("job")]);
  session.setGeneratingIds(new Set(["job"]));
  session.setGenProgressMap({ job: 25 });
  let oldRenders = 0;
  const unmount = session.subscribe(() => oldRenders++);
  unmount();

  // The old request keeps publishing after its component has unmounted.
  session.setGenProgressMap({ job: 70 });
  const remounted = getGenerationSession("switch-running");
  assert.equal(remounted, session);
  assert.equal(remounted.getSnapshot().containers[0].id, "job");
  assert.equal(remounted.getSnapshot().genProgressMap.job, 70);
  assert.equal(remounted.generatingIdsRef.current.has("job"), true);
  assert.equal(oldRenders, 0);

  remounted.generatingPositionsRef.current.job = { x: 480, y: 600 };
  assert.deepEqual(session.generatingPositionsRef.current.job, { x: 480, y: 600 });
  assert.equal(getGenerationSession("switch-other").getSnapshot().containers.length, 0);
});

test("background completion and errors update only the originating canvas", () => {
  const a = getGenerationSession("background-a");
  const b = getGenerationSession("background-b");
  a.setContainers([pending("success"), pending("failed")]);
  a.setGeneratingIds(new Set(["success", "failed"]));
  b.setContainers([pending("unrelated")]);
  const beforeB = b.getSnapshot();
  let updates = 0;
  const unsubscribe = a.subscribe(() => updates++);
  a.setContainers((previous) => previous.filter((c) => c.id !== "success")
    .map((c) => ({ ...c, error: "HTTP 403", previewUrl: undefined })));
  a.setGeneratingIds(new Set());
  unsubscribe();

  const restored = getGenerationSession("background-a").getSnapshot();
  assert.equal(restored.containers.length, 1);
  assert.equal(restored.containers[0].error, "HTTP 403");
  assert.equal(restored.generatingIds.size, 0);
  assert.equal(updates, 2);
  assert.equal(b.getSnapshot(), beforeB);
});

test("concurrent jobs retain independent progress and edit placeholders after remount", () => {
  const session = getGenerationSession("concurrent-jobs");
  session.setContainers([pending("first"), pending("second")]);
  session.setGeneratingIds(new Set(["first", "second"]));
  session.setGenProgressMap({ first: 35, second: 80 });
  const firstId = ++session.processingSeqRef.current;
  session.setProcessingBoxes([{ id: firstId, x: 1, y: 2, w: 3, h: 4, label: "editing" }]);

  const remounted = getGenerationSession("concurrent-jobs");
  const nextId = ++remounted.processingSeqRef.current;
  assert.notEqual(firstId, nextId);
  remounted.setGeneratingIds((previous) => new Set([...previous].filter((id) => id !== "first")));
  remounted.setContainers((previous) => previous.filter((c) => c.id !== "first"));
  assert.deepEqual([...session.getSnapshot().generatingIds], ["second"]);
  assert.equal(session.getSnapshot().genProgressMap.second, 80);
  assert.equal(session.getSnapshot().processingBoxes[0].id, firstId);
  session.setProcessingBoxes((previous) => previous.filter((box) => box.id !== firstId));
  assert.equal(remounted.getSnapshot().processingBoxes.length, 0);
});
