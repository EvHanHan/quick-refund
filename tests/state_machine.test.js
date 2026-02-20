import test from "node:test";
import assert from "node:assert/strict";
import { runStateWithRetry } from "../src/shared/state_machine.js";

test("runStateWithRetry retries then succeeds", async () => {
  let tries = 0;
  const events = [];

  const output = await runStateWithRetry({
    state: "AUTH_ORANGE",
    onEvent: (event) => events.push(event.status),
    action: async () => {
      tries += 1;
      if (tries < 3) {
        throw new Error("transient");
      }
      return "ok";
    }
  });

  assert.equal(output.result, "ok");
  assert.equal(output.attempts, 2);
  assert.deepEqual(events, ["started", "retry", "retry", "success"]);
});

test("runStateWithRetry throws after max retries", async () => {
  await assert.rejects(
    () => runStateWithRetry({ state: "PARSE_BILL", action: async () => { throw new Error("fatal"); } }),
    /fatal/
  );
});
