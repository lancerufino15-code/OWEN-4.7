import { handleChatContinueRoute, handleChatModelsRoute, handleChatRoute } from "../services/chat/agent-chat";
import { handleConversationCollectionRoute, handleConversationItemRoute, handleMetaTagsRoute } from "../services/chat/conversations";
import { defineRoute, type RouteDef } from "./base";

export const chatRoutes: RouteDef[] = [
  defineRoute({ method: "GET", path: "/api/models", domain: "chat", handler: (request, context) => handleChatModelsRoute(request, context.env), auth: "public", tags: ["chat", "models"] }),
  defineRoute({ method: "GET", path: "/api/meta-tags", domain: "chat", handler: (request, context) => handleMetaTagsRoute(request, context.env), auth: "public", tags: ["chat", "meta"] }),
  defineRoute({ method: "GET", path: "/api/conversations", domain: "chat", handler: (request, context) => handleConversationCollectionRoute(request, context.env), auth: "public", tags: ["chat", "conversations"] }),
  defineRoute({ method: "POST", path: "/api/conversations", domain: "chat", handler: (request, context) => handleConversationCollectionRoute(request, context.env), auth: "public", tags: ["chat", "conversations", "write"] }),
  defineRoute({ method: "DELETE", path: "/api/conversations", domain: "chat", handler: (request, context) => handleConversationCollectionRoute(request, context.env), auth: "public", tags: ["chat", "conversations", "delete"] }),
  defineRoute({ method: "GET", path: "/api/conversations/:id", domain: "chat", handler: (request, context) => handleConversationItemRoute(request, context.env), auth: "public", tags: ["chat", "conversations"] }),
  defineRoute({ method: "DELETE", path: "/api/conversations/:id", domain: "chat", handler: (request, context) => handleConversationItemRoute(request, context.env), auth: "public", tags: ["chat", "conversations", "delete"] }),
  defineRoute({ method: "POST", path: "/api/chat/continue", domain: "chat", handler: (request, context) => handleChatContinueRoute(request, context.env), auth: "public", tags: ["chat", "continue"] }),
  defineRoute({ method: "POST", path: "/api/chat", domain: "chat", handler: (request, context) => handleChatRoute(request, context.env), auth: "public", tags: ["chat"] }),
];
