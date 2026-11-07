import { expect, it } from "vitest";
import { cliEnv } from "../src/environment/engine.ts";

const base = { PATH: "/usr/bin:/bin", HOME: "/home/a", SECRET: "kept out" };

it("keeps only what the runtime's CLI needs", () => {
  expect(cliEnv("docker", base)).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/a" });
});

it("lets a CLI named by path find the helpers beside it", () => {
  const binary = "/Applications/Docker.app/Contents/Resources/bin/docker";
  expect(cliEnv(binary, base).PATH).toBe(
    "/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin",
  );
  expect(cliEnv(binary, { HOME: "/home/a" }).PATH).toBe(
    "/Applications/Docker.app/Contents/Resources/bin",
  );
});
