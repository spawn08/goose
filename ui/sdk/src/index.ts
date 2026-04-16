export * from "./generated/types.gen.js";
export * from "./generated/zod.gen.js";
export { GooseClient } from "./goose-client.js";
export { createHttpStream } from "./http-stream.js";
export { resolveGooseBinary } from "./resolve-binary.js";

export {
  ClientSideConnection,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk";
