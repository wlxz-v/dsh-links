import assert from "node:assert/strict";
import test from "node:test";
import { runIsolatedSessionModelSwitch } from "../src/session-model.js";

test("restores agent-default-model when host session.selectModel mutates it", async () => {
  const state = { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "medium", revision: 3 };
  const updates = [];
  const rpcCall = async (method, payload) => {
    if (method === "settings.describe") {
      return {
        namespaces: [{
          ns: "agent-default-model",
          revision: state.revision,
          value: { provider: state.provider, model: state.model, reasoningEffort: state.reasoningEffort },
        }],
      };
    }
    if (method === "settings.update") {
      updates.push(payload);
      assert.equal(payload.expectedRevision, state.revision);
      state.provider = payload.patch.provider;
      state.model = payload.patch.model;
      state.reasoningEffort = payload.patch.reasoningEffort;
      state.revision += 1;
      return { ok: true, revision: state.revision };
    }
    throw new Error("unexpected rpc: " + method);
  };

  const res = await runIsolatedSessionModelSwitch({
    rpcCall,
    executeSelect: async () => {
      state.provider = "anthropic";
      state.model = "claude-sonnet";
      state.reasoningEffort = "high";
      state.revision += 1;
      return { selected: { provider: "anthropic", model: "claude-sonnet" } };
    },
  });

  assert.deepEqual(res, { selected: { provider: "anthropic", model: "claude-sonnet" } });
  assert.equal(updates.length, 1);
  assert.equal(state.provider, "deepseek");
  assert.equal(state.model, "deepseek-chat");
  assert.equal(state.reasoningEffort, "medium");
});

test("never calls settings.update when host keeps agent-default-model unchanged", async () => {
  const updates = [];
  const rpcCall = async (method, payload) => {
    if (method === "settings.describe") {
      return { namespaces: [{ ns: "agent-default-model", revision: 1, value: { provider: "deepseek", model: "deepseek-chat" } }] };
    }
    if (method === "settings.update") { updates.push(payload); return { ok: true }; }
    throw new Error("unexpected rpc: " + method);
  };

  const res = await runIsolatedSessionModelSwitch({
    rpcCall,
    executeSelect: async () => ({ selected: { provider: "openai", model: "gpt-5" } }),
  });
  assert.deepEqual(res, { selected: { provider: "openai", model: "gpt-5" } });
  assert.equal(updates.length, 0);
});

test("serializes concurrent switches and ignores restore errors without failing select", async () => {
  const state = { provider: "deepseek", model: "deepseek-chat", revision: 1 };
  const order = [];
  const warns = [];
  const rpcCall = async (method, payload) => {
    if (method === "settings.describe") {
      return { namespaces: [{ ns: "agent-default-model", revision: state.revision, value: { provider: state.provider, model: state.model } }] };
    }
    if (method === "settings.update") {
      if (order.length >= 2) throw new Error("restore error");
      state.provider = payload.patch.provider;
      state.model = payload.patch.model;
      state.revision += 1;
      return { ok: true };
    }
  };

  const p1 = runIsolatedSessionModelSwitch({
    rpcCall,
    onWarn: (e) => warns.push(e.message),
    executeSelect: async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("first");
      state.provider = "p1"; state.model = "m1"; state.revision += 1;
      return { selected: { model: "m1" } };
    },
  });
  const p2 = runIsolatedSessionModelSwitch({
    rpcCall,
    onWarn: (e) => warns.push(e.message),
    executeSelect: async () => {
      order.push("second");
      state.provider = "p2"; state.model = "m2"; state.revision += 1;
      return { selected: { model: "m2" } };
    },
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(r1.selected.model, "m1");
  assert.equal(r2.selected.model, "m2");
  assert.deepEqual(warns, ["restore error"]);
});
