import { existsSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import type { ConsumerOptions } from "../../runtime/consumer";
import type {
  WorkerThreadData,
  WorkerThreadMessage,
} from "../../runtime/worker-thread";

type Log = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type WorkerOptions = ConsumerOptions & {
  /**
   * Directory containing handler modules. Defaults to `handlers/` next to the
   * entry script, then `src/handlers` under the working directory.
   */
  handlersDir?: string;
  /**
   * Passed to every handler as `ctx.config`. Must be structured-cloneable.
   */
  config?: Record<string, unknown>;
  /** Restarts allowed per worker after a crash. Defaults to 5. */
  maxRestarts?: number;
  /** Time to wait for workers to drain on shutdown. Defaults to 10000ms. */
  shutdownTimeoutMs?: number;
};

export type WorkerDependency = {
  workerCount: number;
  subscriptions: string[];
  options: WorkerOptions;
};

export type WorkerState = {
  index: number;
  state: "starting" | "running" | "restarting" | "exited" | "failed";
  restarts: number;
  lastError?: string;
};

export type ServiceWorkerContext = {
  name: string;
  dependencies: Map<string, unknown>;
  log: Log;
  redisUrl?: string;
};

const HANDLER_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts"]);
const RESTART_BASE_DELAY_MS = 1000;

export function resolveHandlersDir(explicit?: string): string | null {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [
        ...(process.argv[1]
          ? [path.join(path.dirname(path.resolve(process.argv[1])), "handlers")]
          : []),
        path.resolve(process.cwd(), "src/handlers"),
      ];

  return candidates.find((dir) => existsSync(dir)) ?? null;
}

export function discoverHandlers(dir: string): Record<string, string> {
  const handlers: Record<string, string> = {};
  for (const file of readdirSync(dir)) {
    const ext = path.extname(file);
    if (!HANDLER_EXTENSIONS.has(ext) || /\.d\.m?ts$/.test(file)) {
      continue;
    }
    handlers[path.basename(file, ext)] = path.join(dir, file);
  }
  return handlers;
}

/**
 * The worker entry is emitted next to the bundled package entry as
 * `dist/runtime/worker-thread.mjs`.
 */
export function resolveWorkerEntry(): URL | null {
  const entry = new URL("./runtime/worker-thread.mjs", import.meta.url);
  return existsSync(fileURLToPath(entry)) ? entry : null;
}

export class WorkerPool {
  private readonly workers = new Map<number, Worker>();
  private readonly states = new Map<number, WorkerState>();
  private stopping = false;
  loadedHandlers: string[] = [];

  constructor(
    private readonly cfg: {
      name: string;
      redisUrl?: string;
      entry: URL;
      handlers: Record<string, string>;
      workerCount: number;
      subscriptions: string[];
      options: WorkerOptions;
      log: Log;
    },
  ) {}

  start() {
    for (let i = 0; i < this.cfg.workerCount; i++) {
      this.states.set(i, { index: i, state: "starting", restarts: 0 });
      this.spawn(i);
    }
  }

  get status(): WorkerState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  get isRunning() {
    return [...this.states.values()].some((s) => s.state === "running");
  }

  private spawn(index: number) {
    const { cfg } = this;
    const { handlersDir, config, maxRestarts, shutdownTimeoutMs, ...options } =
      cfg.options;
    const workerData: WorkerThreadData = {
      name: cfg.name,
      redisUrl: cfg.redisUrl,
      handlers: cfg.handlers,
      index,
      subscriptions: cfg.subscriptions,
      config,
      options,
    };
    const worker = new Worker(cfg.entry, { workerData });
    const state = this.states.get(index)!;
    this.workers.set(index, worker);

    worker.on("message", (msg: WorkerThreadMessage) => {
      switch (msg.level) {
        case "ready":
          state.state = "running";
          cfg.log.info(`Worker ${index} consuming ${cfg.subscriptions.join(", ")}`);
          break;
        case "create":
          this.loadedHandlers = msg.message;
          break;
        case "warn":
          cfg.log.warn(`[worker ${index}] ${msg.message}`);
          break;
        case "error":
          cfg.log.error(`[worker ${index}] ${msg.message}`);
          break;
        default:
          cfg.log.info(`[worker ${index}] ${msg.message}`);
      }
    });

    worker.on("error", (err) => {
      state.lastError = err.message;
      cfg.log.error(`Worker ${index} error: ${err.message}`);
    });

    worker.on("exit", (code) => {
      this.workers.delete(index);

      if (this.stopping || code === 0) {
        state.state = "exited";
        cfg.log.info(`Worker ${index} exited.`);
        return;
      }

      if (state.restarts >= (maxRestarts ?? 5)) {
        state.state = "failed";
        cfg.log.error(
          `Worker ${index} exited with code ${code} and reached the restart limit.`,
        );
        return;
      }

      state.restarts++;
      state.state = "restarting";
      const delay = RESTART_BASE_DELAY_MS * 2 ** (state.restarts - 1);
      cfg.log.error(
        `Worker ${index} exited with code ${code}. Restarting in ${delay}ms.`,
      );
      setTimeout(() => {
        if (!this.stopping) this.spawn(index);
      }, delay).unref();
    });
  }

  /**
   * Asks each worker to finish its in-flight message and exit, terminating
   * any that do not exit within `shutdownTimeoutMs`.
   */
  async stop() {
    this.stopping = true;
    const timeoutMs = this.cfg.options.shutdownTimeoutMs ?? 10_000;

    await Promise.all(
      [...this.workers.values()].map(
        (worker) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => void worker.terminate(), timeoutMs);
            worker.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            worker.postMessage({ type: "stop" });
          }),
      ),
    );
  }
}

export function startWorkers(ctx: ServiceWorkerContext): WorkerPool | null {
  const dep = ctx.dependencies.get("workers") as WorkerDependency | undefined;
  if (!dep) {
    return null;
  }

  if (!ctx.dependencies.has("redis")) {
    ctx.log.warn("Redis module not initialized. Skipping worker setup.");
    return null;
  }

  if (!Number.isInteger(dep.workerCount) || dep.workerCount < 1) {
    throw new Error("Worker count must be an integer greater than 0.");
  }

  const handlersDir = resolveHandlersDir(dep.options.handlersDir);
  if (!handlersDir) {
    ctx.log.warn(
      "Handlers directory not found. Set withWorkers(..., { handlersDir }). Skipping worker setup.",
    );
    return null;
  }

  // Without handlers every message would be acknowledged and dropped.
  const handlers = discoverHandlers(handlersDir);
  if (Object.keys(handlers).length === 0) {
    ctx.log.warn(`No handlers found in ${handlersDir}. Skipping worker setup.`);
    return null;
  }

  const entry = resolveWorkerEntry();
  if (!entry) {
    ctx.log.error(
      "Worker thread entry not found. Workers run from the built package (dist/runtime/worker-thread.mjs).",
    );
    return null;
  }

  ctx.log.info(
    `Loaded ${Object.keys(handlers).length} handler files from ${handlersDir}: ${Object.keys(handlers).join(", ")}`,
  );

  const pool = new WorkerPool({
    name: ctx.name,
    redisUrl: ctx.redisUrl,
    entry,
    handlers,
    workerCount: dep.workerCount,
    subscriptions: dep.subscriptions,
    options: dep.options,
    log: ctx.log,
  });
  pool.start();
  return pool;
}
