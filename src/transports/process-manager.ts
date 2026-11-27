import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { redactText } from "../brain/redact.js";
import {
  HELPER_PROTOCOL_VERSION,
  InitializeResultSchema,
  type InitializeResult,
} from "./protocol.js";
import { JsonRpcClient } from "./rpc-client.js";

export interface HelperSpawnOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

/**
 * Manages the lifecycle of an isolated native helper process over stdio JSON-RPC:
 * startup handshake, version compatibility, health checks, crash reporting, and graceful shutdown.
 */
export class HelperProcessManager {
  readonly client: JsonRpcClient;
  readonly initializeResult: InitializeResult;
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly stderrTail: string[] = [];
  private exited = false;
  private exitInfo: string | null = null;

  private constructor(
    proc: ChildProcessWithoutNullStreams,
    client: JsonRpcClient,
    initializeResult: InitializeResult,
  ) {
    this.proc = proc;
    this.client = client;
    this.initializeResult = initializeResult;

    proc.stderr.on("data", (chunk: Buffer) => {
      const sanitized = redactText(chunk.toString("utf8")).trim();
      if (sanitized.length > 0) {
        this.stderrTail.push(sanitized);
        if (this.stderrTail.length > 20) {
          this.stderrTail.shift();
        }
      }
    });

    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = `code=${String(code)}, signal=${String(signal)}`;
      const tail = this.stderrTail.length > 0 ? ` (${this.stderrTail.join(" | ")})` : "";
      this.client.close(`Helper process exited (${this.exitInfo})${tail}`);
    });
  }

  static async spawn(options: HelperSpawnOptions): Promise<HelperProcessManager> {
    const proc = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const client = new JsonRpcClient(proc.stdin, proc.stdout);

    const earlyExitPromise = new Promise<never>((_resolve, reject) => {
      proc.once("error", (err) => {
        reject(new Error(`Failed to start helper "${options.command}": ${err.message}`));
      });
      proc.once("exit", (code, signal) => {
        reject(
          new Error(
            `Helper "${options.command}" exited before handshake completed (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      });
    });

    const handshakePromise = (async () => {
      const rawInit = await client.request(
        "initialize",
        { clientProtocolVersion: HELPER_PROTOCOL_VERSION },
        options.startupTimeoutMs ?? 10_000,
      );
      const parsed = InitializeResultSchema.parse(rawInit);
      const clientMajor = HELPER_PROTOCOL_VERSION.split(".")[0];
      const serverMajor = parsed.protocolVersion.split(".")[0];
      if (clientMajor !== serverMajor) {
        throw new Error(
          `Incompatible helper protocol version: expected ${HELPER_PROTOCOL_VERSION}, got ${parsed.protocolVersion}`,
        );
      }
      return parsed;
    })();

    try {
      const initRes = await Promise.race([handshakePromise, earlyExitPromise]);
      return new HelperProcessManager(proc, client, initRes);
    } catch (err) {
      client.close("Initialization failed");
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
      throw err;
    }
  }

  isAlive(): boolean {
    return !this.exited;
  }

  getExitInfo(): string | null {
    return this.exitInfo;
  }

  getStderrSummary(): string {
    return this.stderrTail.join(" | ");
  }

  async healthCheck(timeoutMs = 2000): Promise<boolean> {
    if (this.exited) {
      return false;
    }
    try {
      await this.client.request("ping", {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.exited) {
      this.client.close();
      return;
    }

    try {
      await this.client.request("shutdown", {}, 1500);
    } catch {
      // Proceed to forced termination if graceful shutdown times out
    }

    if (!this.exited) {
      this.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!this.exited) {
            this.proc.kill("SIGKILL");
          }
          resolve();
        }, 1000);
        this.proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.client.close("Helper shut down");
  }
}
