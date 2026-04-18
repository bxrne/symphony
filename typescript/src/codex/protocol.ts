export type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type ProtocolMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isResponse(msg: ProtocolMessage): msg is JsonRpcResponse {
  return typeof (msg as JsonRpcResponse).id !== "undefined" && !(msg as JsonRpcRequest).method;
}

export function isRequest(msg: ProtocolMessage): msg is JsonRpcRequest {
  return typeof (msg as JsonRpcRequest).id !== "undefined" && typeof (msg as JsonRpcRequest).method === "string";
}

export function isNotification(msg: ProtocolMessage): msg is JsonRpcNotification {
  return (
    typeof (msg as JsonRpcNotification).method === "string" &&
    typeof (msg as JsonRpcRequest).id === "undefined"
  );
}
