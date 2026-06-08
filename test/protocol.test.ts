import test from "node:test";
import assert from "node:assert/strict";
import {
  GroupColorSchema,
  GroupTabsInput,
  UpdateGroupInput,
} from "../src/bridge/protocol.js";

test("color 'gray' is normalized to British 'grey'", () => {
  assert.equal(GroupColorSchema.parse("gray"), "grey");
  assert.equal(GroupColorSchema.parse("grey"), "grey");
  assert.equal(GroupColorSchema.parse("blue"), "blue");
});

test("an invalid color is rejected", () => {
  assert.throws(() => GroupColorSchema.parse("chartreuse"));
});

test("group_tabs requires at least one tab id", () => {
  assert.throws(() => GroupTabsInput.parse({ tabIds: [] }));
  assert.doesNotThrow(() => GroupTabsInput.parse({ tabIds: [1] }));
});

test("group_tabs normalizes gray -> grey inside the input", () => {
  const parsed = GroupTabsInput.parse({ tabIds: [1], color: "gray" });
  assert.equal(parsed.color, "grey");
});

test("update_group requires at least one mutable field", () => {
  assert.throws(() => UpdateGroupInput.parse({ groupId: 1 }));
  assert.doesNotThrow(() => UpdateGroupInput.parse({ groupId: 1, collapsed: true }));
});
