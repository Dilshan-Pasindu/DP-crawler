import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { JsonRpcResponseSchema, MAX_RPC_FRAME_BYTES } from "./protocol.js";

export class RpcClientError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Versioned newline-delimited JSON-RPC 2.0 client over stdio streams
 * with bounded frame size, per-request timeouts, cancellation, and crash handling.
 */
export class JsonRpcClient {
  private readonly stdin: Writable;
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(stdin: Writable, stdout: Readable) {
    this.stdin = stdin;
    this.rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });

    this.rl.on("line", (line) => {
      if (Buffer.byteLength(line, "utf8") > MAX_RPC_FRAME_BYTES) {
        this.failAllPending(new RpcClientError(-32600, "Helper response exceeded bounded 1 MiB frame limit"));
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }

      const parsed = JsonRpcResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return;
      }

      const msg = parsed.data;
      if (typeof msg.id !== "number") {
        return;
      }

      const entry = this.pending.get(msg.id);
      if (entry === undefined) {
        return;
      }

      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error !== undefined) {
        entry.reject(new RpcClientError(msg.error.code, msg.error.message));
      } else {
        entry.resolve(msg.result);
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new RpcClientError(-32000, "JSON-RPC transport is closed"));
    }

    const id = this.nextId;
    this.nextId += 1;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

    if (Buffer.byteLength(payload, "utf8") > MAX_RPC_FRAME_BYTES) {
      return Promise.reject(new RpcClientError(-32600, "Outgoing RPC request exceeds bounded 1 MiB frame limit"));
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("$/cancelRequest", { id });
        reject(new RpcClientError(-32001, `RPC request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.stdin.write(payload, (err) => {
        if (err !== null && err !== undefined) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new RpcClientError(-32002, `Failed writing to helper stdin: ${err.message}`));
        }
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed || !this.stdin.writable) {
      return;
    }
    const payload = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
    if (Buffer.byteLength(payload, "utf8") <= MAX_RPC_FRAME_BYTES) {
      this.stdin.write(payload);
    }
  }

  cancel(id: number): void {
    this.notify("$/cancelRequest", { id });
  }

  close(reason = "Helper process closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
    this.failAllPending(new RpcClientError(-32003, reason));
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
  }
}
