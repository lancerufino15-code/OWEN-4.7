import type { Env } from "../../types";

let runtimeEnvValidated = false;

export function validateRuntimeEnv(env: Env): void {
  if (runtimeEnvValidated) return;
  if (!env.DEFAULT_TEXT_MODEL?.trim()) {
    throw new Error("DEFAULT_TEXT_MODEL missing from env. Check .dev.vars");
  }
  runtimeEnvValidated = true;
}
