import "@testing-library/jest-dom";

const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };

if (runtime.process?.env) {
  runtime.process.env.TZ = "Asia/Shanghai";
}
