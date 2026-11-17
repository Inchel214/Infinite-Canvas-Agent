import test from "node:test";
import assert from "node:assert/strict";
import { duplicateGenerationRecipe } from "../src/components/canvas/utils/generationRecipe.ts";

test("a running job can be reused without carrying its progress, error or preview", () => {
  const source = {
    id: "running", x: 100, y: 200, w: 340, h: 420,
    prompt: "Use @图片2 before @图片1", aspect: "3:4", resolution: "4K", count: 4,
    refIds: ["first", "second"], experienceIds: ["style-a", "style-b"],
    error: "previous error", previewUrl: "preview-url", exiting: true,
  };
  const original = structuredClone(source);
  const duplicate = duplicateGenerationRecipe(source, "editable", 550, 200);
  assert.equal(duplicate.prompt, source.prompt);
  assert.equal(duplicate.aspect, "3:4");
  assert.equal(duplicate.resolution, "4K");
  assert.deepEqual(duplicate.refIds, source.refIds);
  assert.deepEqual(duplicate.experienceIds, source.experienceIds);
  assert.equal(duplicate.count, 1);
  assert.equal(duplicate.id, "editable");
  assert.equal(duplicate.x, 550);
  for (const key of ["previewUrl", "error", "exiting"]) assert.equal(key in duplicate, false);
  duplicate.refIds.reverse();
  duplicate.experienceIds.pop();
  duplicate.prompt = "Changed prompt";
  assert.deepEqual(source, original);
});

test("text generation stays text generation without fabricating a reference to an unfinished image", () => {
  const source = {
    id: "running-text", x: 0, y: 0, w: 340, h: 420,
    prompt: "A blue circle", aspect: "1:1", resolution: "2K", refIds: [],
  };
  const duplicate = duplicateGenerationRecipe(source, "editable-text", 450, 0);
  assert.deepEqual(duplicate.refIds, []);
  assert.equal(duplicate.experienceIds, undefined);
  assert.equal(duplicate.prompt, "A blue circle");
});
