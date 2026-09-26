// Domain types come from the shared OpenAPI document (openapi/openapi.json → src/api/schema.d.ts).
import type { components } from "./schema";

export type UserPublic = components["schemas"]["UserPublic"];
export type UserMe = components["schemas"]["UserMe"];
export type TokenResponse = components["schemas"]["TokenResponse"];
export type ChannelOut = components["schemas"]["ChannelOut"];
export type MessageOut = components["schemas"]["MessageOut"];
export type HistoryOut = components["schemas"]["HistoryOut"];
export type DeltaOut = components["schemas"]["DeltaOut"];
export type BootstrapOut = components["schemas"]["BootstrapOut"];
export type MemberOut = components["schemas"]["MemberOut"];
export type ChannelType = ChannelOut["type"];
