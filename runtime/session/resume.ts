import type { Env } from "../../../types";
import { buildConversationRecordFromSession, loadLatestRuntimeSession, loadRuntimeSession, saveRuntimeSession } from "./persistence";
import type { SessionV2 } from "./types";

function touchResume(session: SessionV2): SessionV2 {
  const nextResumeCount = (session.resume?.resumeCount || 0) + 1;
  const lastMessage = session.messages[session.messages.length - 1];
  return {
    ...session,
    updatedAt: Date.now(),
    metadata: {
      ...(session.metadata || {}),
      source: "resume_update",
    },
    resume: {
      resumeCount: nextResumeCount,
      lastResumedAt: new Date().toISOString(),
      lastMessageCount: session.messages.length,
      lastMessageId: lastMessage?.id,
    },
  };
}

export async function resumeRuntimeSession(env: Env, scope: string, sessionId: string) {
  const session = await loadRuntimeSession(env, scope, sessionId);
  if (!session) return null;
  const resumed = touchResume(session);
  await saveRuntimeSession(env, resumed);
  return {
    session: resumed,
    conversation: buildConversationRecordFromSession(resumed),
  };
}

export async function inspectRuntimeSession(env: Env, scope: string, sessionId: string) {
  const session = await loadRuntimeSession(env, scope, sessionId);
  if (!session) return null;
  return {
    session,
    conversation: buildConversationRecordFromSession(session),
  };
}

export async function inspectLatestRuntimeSession(env: Env, scope: string) {
  const session = await loadLatestRuntimeSession(env, scope);
  if (!session) return null;
  return {
    session,
    conversation: buildConversationRecordFromSession(session),
  };
}
