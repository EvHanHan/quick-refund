import { MAX_RETRIES } from "./contracts.js";

export async function runStateWithRetry({ state, action, onEvent, sleepMs = 1 }) {
  let attempt = 0;
  onEvent?.({ state, status: "started" });

  while (attempt <= MAX_RETRIES) {
    try {
      const result = await action();
      onEvent?.({ state, status: "success", attempt });
      return { result, attempts: attempt };
    } catch (error) {
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        onEvent?.({ state, status: "failed", attempt, error });
        throw error;
      }
      onEvent?.({ state, status: "retry", attempt, error });
      await sleep(sleepMs * attempt);
    }
  }

  throw new Error("Unreachable state machine branch");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
