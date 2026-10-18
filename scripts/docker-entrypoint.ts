import { spawn } from "node:child_process";
import { ZodError } from "zod";
import { env } from "../packages/config/src/index";

try {
  env();
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("No service command was provided.");
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    process.stderr.write(
      "Cannot start service command. Check the application image.\n",
    );
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} catch (error) {
  const message =
    error instanceof ZodError
      ? error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")
      : error instanceof Error
        ? error.message
        : "Invalid configuration.";
  process.stderr.write(`Startup failed. Check root .env: ${message}\n`);
  process.exitCode = 1;
}
