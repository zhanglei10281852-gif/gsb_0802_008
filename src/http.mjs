import { createServer } from "node:http";
import { toApiError, ApiError } from "./errors.mjs";
import { ResolutionCancelledError } from "./resolver.mjs";

const DEFAULT_BATCH_TIMEOUT_MS = 30000;

function batchTimeoutMs() {
  const value = Number(process.env.BATCH_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BATCH_TIMEOUT_MS;
}

function send(response, statusCode, body) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 128 * 1024)
      throw new ApiError(
        413,
        "payload_too_large",
        "JSON payload exceeds 128 KiB",
      );
  }
  if (!raw) throw new ApiError(400, "invalid_json", "JSON payload is required");
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(
      400,
      "invalid_json",
      "Request body must contain valid JSON",
    );
  }
}

function createBatchSignal(response) {
  const controller = new AbortController();
  let timedOut = false;
  const onClose = () => {
    if (!timedOut) controller.abort(new Error("client_disconnected"));
  };
  response.on("close", onClose);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("batch_timeout"));
  }, batchTimeoutMs());
  if (typeof timer.unref === "function") timer.unref();
  const cleanup = () => {
    clearTimeout(timer);
    response.removeListener("close", onClose);
  };
  return { signal: controller.signal, cleanup };
}

export function createApiServer({ registry, resolver }) {
  return createServer(async (request, response) => {
    let batchSignal = null;
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (request.method === "GET" && path === "/health") {
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && path === "/v1/bundles") {
        send(response, 201, registry.put(await readJson(request)));
        return;
      }
      if (request.method === "POST" && path === "/v1/lineage") {
        send(response, 200, registry.adjustLineage(await readJson(request)));
        return;
      }
      if (request.method === "POST" && path === "/v1/lineage/preview") {
        send(response, 200, registry.previewLineage(await readJson(request)));
        return;
      }
      if (request.method === "POST" && path === "/v1/lineage/rollback") {
        send(response, 200, registry.rollbackLineage(await readJson(request)));
        return;
      }
      if (request.method === "POST" && path === "/v1/resolve") {
        send(response, 200, resolver.resolve(await readJson(request)));
        return;
      }
      if (request.method === "POST" && path === "/v1/resolve/batch") {
        batchSignal = createBatchSignal(response);
        const result = await resolver.resolveBatch(await readJson(request), {
          signal: batchSignal.signal,
        });
        batchSignal.cleanup();
        send(response, 200, result);
        return;
      }
      throw new ApiError(404, "route_not_found", "Route does not exist");
    } catch (error) {
      if (batchSignal) batchSignal.cleanup();
      if (error instanceof ResolutionCancelledError) {
        if (error.reason?.message === "batch_timeout") {
          send(response, 504, {
            error: "batch_timeout",
            message: "Batch resolution exceeded the allowed time",
          });
          return;
        }
        if (response.writableEnded || response.destroyed) return;
        send(response, 499, {
          error: "client_closed_request",
          message:
            "The client closed the connection before resolution completed",
        });
        return;
      }
      const known = toApiError(error);
      send(response, known.statusCode, {
        error: known.code,
        message: known.message,
      });
    }
  });
}
