import type { Env } from "../../types";

/**
 * Compatibility Durable Object export retained to satisfy prior production migrations.
 * This class is intentionally inert and can be removed only after a delete-class migration.
 */
export class ActiveUsersRoom {
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(): Promise<Response> {
    return new Response("ActiveUsersRoom has been retired.", { status: 410 });
  }
}
