#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { Command } from "commander";
import { pino } from "pino";
import { createDefaultRegistry, type AdapterRegistry } from "./adapters/registry.js";
import { TOOL_VERSION } from "./brain/crawler.js";
import { runAcceptCommand } from "./commands/accept.js";
import { runAuthCommand } from "./commands/auth.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runInspectCommand } from "./commands/inspect.js";
import { runCrawlCommand } from "./commands/run.js";

const logger = pino({
  name: "dpcrawl",
  redact: {
    paths: ["*.password", "*.token", "*.authorization", "*.cookie", "*.cookies"],
    censor: "[REDACTED]",
  },
});

/**
 * Builds the `dpcrawl` CLI program with an injectable AdapterRegistry for testability.
 */
export function createCli(registry: AdapterRegistry = createDefaultRegistry()): Command {
  const program = new Command();

  program
    .name("dpcrawl")
    .description(
      "A safety-first, cross-platform UI crawler that discovers interactive elements, explores application behaviour, and produces evidence-backed diagnostic reports.",
    )
    .version(TOOL_VERSION);

  program
    .command("doctor")
    .description("Validate configuration, runtime dependencies, permissions, and safety capabilities")
    .requiredOption("--config <file>", "Path to configuration file")
    .requiredOption("--profile <name>", "Profile name")
    .action(async (opts: { config: string; profile: string }) => {
      const res = await runDoctorCommand({
        configPath: opts.config,
        profileName: opts.profile,
        registry,
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      if (!res.ok) process.exitCode = 1;
    });

  program
    .command("inspect")
    .description("Perform discovery-only inspection without clicking elements")
    .requiredOption("--config <file>", "Path to configuration file")
    .requiredOption("--profile <name>", "Profile name")
    .option("--out <file>", "Output discovery.json path")
    .action(async (opts: { config: string; profile: string; out?: string }) => {
      const res = await runInspectCommand({
        configPath: opts.config,
        profileName: opts.profile,
        registry,
        ...(opts.out !== undefined ? { outputFile: opts.out } : {}),
      });
      process.stdout.write(`${JSON.stringify({ targetId: res.targetId, nodes: res.snapshot.nodes.length }, null, 2)}\n`);
    });

  program
    .command("run")
    .description("Execute a controlled, safety-gated UI crawl")
    .requiredOption("--config <file>", "Path to configuration file")
    .requiredOption("--profile <name>", "Profile name")
    .action(async (opts: { config: string; profile: string }) => {
      const { report, outputDir } = await runCrawlCommand({
        configPath: opts.config,
        profileName: opts.profile,
        registry,
      });
      process.stdout.write(
        `${JSON.stringify({ status: report.completionStatus, findings: report.findings.length, outputDir }, null, 2)}\n`,
      );
      if (report.completionStatus === "RUN_BLOCKED") process.exitCode = 2;
    });

  program
    .command("auth")
    .description("Manage supported authentication workflows")
    .requiredOption("--config <file>", "Path to configuration file")
    .requiredOption("--profile <name>", "Profile name")
    .action(async (opts: { config: string; profile: string }) => {
      const res = await runAuthCommand({
        configPath: opts.config,
        profileName: opts.profile,
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    });

  program
    .command("accept")
    .description("Print suggested baseline acceptance block for human review")
    .requiredOption("--from-report <report.json>", "Path to authoritative report.json")
    .action(async (opts: { fromReport: string }) => {
      const suggestion = await runAcceptCommand(opts.fromReport);
      process.stdout.write(`${JSON.stringify(suggestion, null, 2)}\n`);
    });

  program
    .command("enrich")
    .description("Optional post-crawl AI enrichment (Phase 8)")
    .argument("<report.json>", "Path to authoritative report.json")
    .action(() => {
      process.stderr.write("Post-crawl AI enrichment is scheduled for Phase 8 and is not enabled yet.\n");
      process.exitCode = 1;
    });

  return program;
}

const resolvedArgv1 = (() => {
  if (process.argv[1] === undefined) return undefined;
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
})();

const isMain =
  resolvedArgv1 !== undefined &&
  (resolvedArgv1.endsWith("/cli.mjs") ||
    resolvedArgv1.endsWith("/cli.js") ||
    resolvedArgv1.endsWith("/cli.ts") ||
    resolvedArgv1.endsWith("\\cli.js") ||
    resolvedArgv1.endsWith("\\cli.ts"));

if (isMain) {
  createCli()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "Command failed");
      process.exitCode = 1;
    });
}
