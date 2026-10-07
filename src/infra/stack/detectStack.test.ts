import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { detectStack } from "./detectStack.js";

describe("detectStack", () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function project(files: Record<string, string>, dirs: string[] = []): Promise<string> {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-stack-"));
    for (const dir of dirs) await mkdir(path.join(projectDir, dir), { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(projectDir, name)), { recursive: true });
      await writeFile(path.join(projectDir, name), contents, "utf8");
    }
    return projectDir;
  }

  it("throws E_NO_STACK when nothing identifies the project", async () => {
    const dir = await project({ "README.md": "# hi" });

    const err = await detectStack(dir).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_NO_STACK");
  });

  it("throws E_AMBIGUOUS_STACK for a polyglot repo, naming the candidates", async () => {
    const dir = await project({ "package.json": "{}", "requirements.txt": "flask\n" });

    const err = await detectStack(dir).catch((e: unknown) => e);
    expect((err as TwinError).code).toBe("E_AMBIGUOUS_STACK");
    expect((err as TwinError).details?.candidates).toEqual(["node", "python"]);
  });

  it("--stack resolves a polyglot repo instead of failing", async () => {
    const dir = await project({ "package.json": "{}", "requirements.txt": "flask\n", "app.py": "" });

    const { profile } = await detectStack(dir, "python");
    expect(profile.id).toBe("python");
  });

  it("rejects an unknown forced stack with E_CONFIG_INVALID", async () => {
    const dir = await project({ "package.json": "{}" });

    const err = await detectStack(dir, "cobol").catch((e: unknown) => e);
    expect((err as TwinError).code).toBe("E_CONFIG_INVALID");
  });

  describe("node", () => {
    it("prefers the start script", async () => {
      const dir = await project({ "package.json": JSON.stringify({ scripts: { dev: "x", start: "node server.js" } }) });
      const { profile, startCommand } = await detectStack(dir);
      expect(profile.id).toBe("node");
      expect(startCommand).toBe("npm start");
    });

    it("falls back to dev, then to a single remaining script", async () => {
      const dir = await project({ "package.json": JSON.stringify({ scripts: { test: "vitest", dev: "nodemon" } }) });
      expect((await detectStack(dir)).startCommand).toBe("npm run dev");
    });

    it("refuses to guess between several equally plausible scripts", async () => {
      const dir = await project({ "package.json": JSON.stringify({ scripts: { api: "node a.js", web: "node b.js" } }) });
      expect((await detectStack(dir)).startCommand).toBeUndefined();
    });
  });

  describe("python", () => {
    it("detects Django via manage.py and binds the port positionally", async () => {
      const dir = await project({ "manage.py": "", "requirements.txt": "django\n" });
      const { profile, startCommand } = await detectStack(dir);
      expect(profile.id).toBe("python");
      expect(startCommand).toBe("python manage.py runserver 127.0.0.1:{{port}}");
    });

    it("detects FastAPI/uvicorn from requirements plus a conventional entrypoint", async () => {
      const dir = await project({ "requirements.txt": "fastapi\nuvicorn\n", "main.py": "" });
      expect((await detectStack(dir)).startCommand).toBe("python -m uvicorn main:app --host 127.0.0.1 --port {{port}}");
    });

    it("detects Flask", async () => {
      const dir = await project({ "requirements.txt": "flask==3.0.0\n", "app.py": "" });
      expect((await detectStack(dir)).startCommand).toBe("python -m flask --app app run --port {{port}}");
    });

    it("falls back to running the script directly when the framework is unknown", async () => {
      const dir = await project({ "requirements.txt": "bottle\n", "server.py": "" });
      expect((await detectStack(dir)).startCommand).toBe("python server.py");
    });

    // The project's deps live in its virtualenv, not under whatever `python`
    // the PATH resolves to, so a bare `python` would fail with ModuleNotFoundError.
    it("uses the virtualenv's own interpreter when the project has one", async () => {
      const dir = await project({ "requirements.txt": "flask\n", "app.py": "" }, [".venv"]);
      const { startCommand } = await detectStack(dir);

      expect(startCommand).toMatch(/^\.?[\\/]?\.venv[\\/](Scripts[\\/]python\.exe|bin[\\/]python) -m flask /);
    });

    it("falls back to a bare `python` when there's no virtualenv", async () => {
      const dir = await project({ "requirements.txt": "flask\n", "app.py": "" });
      expect((await detectStack(dir)).startCommand).toBe("python -m flask --app app run --port {{port}}");
    });

    it("reads dependencies from pyproject.toml too", async () => {
      const dir = await project({ "pyproject.toml": '[project]\ndependencies = ["flask"]\n', "app.py": "" });
      expect((await detectStack(dir)).startCommand).toBe("python -m flask --app app run --port {{port}}");
    });
  });

  describe("go", () => {
    it("detects go.mod and uses go run", async () => {
      const dir = await project({ "go.mod": "module example.com/app\n", "main.go": "package main" });
      const { profile, startCommand } = await detectStack(dir);
      expect(profile.id).toBe("go");
      expect(startCommand).toBe("go run .");
      expect(profile.linkDirs).toEqual([]); // compiled: no dependency dir to share
    });
  });

  describe("ruby", () => {
    it("detects a Rack app and passes the port as a flag", async () => {
      const dir = await project({ Gemfile: 'gem "sinatra"\n', "config.ru": "run Sinatra::Application" });
      const { profile, startCommand } = await detectStack(dir);
      expect(profile.id).toBe("ruby");
      expect(startCommand).toBe("bundle exec rackup -p {{port}} -o 127.0.0.1");
    });

    it("detects Rails when the Gemfile says so and bin/ exists", async () => {
      const dir = await project({ Gemfile: 'gem "rails", "~> 7.1"\n' }, ["bin"]);
      expect((await detectStack(dir)).startCommand).toBe("bundle exec rails server -p {{port}} -b 127.0.0.1");
    });
  });

  describe("php", () => {
    it("detects Laravel via artisan", async () => {
      const dir = await project({ "composer.json": "{}", artisan: "" });
      const { profile, startCommand } = await detectStack(dir);
      expect(profile.id).toBe("php");
      expect(startCommand).toBe("php artisan serve --host=127.0.0.1 --port={{port}}");
    });

    it("serves public/ with the built-in server when there's no artisan", async () => {
      const dir = await project({ "composer.json": "{}" }, ["public"]);
      expect((await detectStack(dir)).startCommand).toBe("php -S 127.0.0.1:{{port}} -t public");
    });
  });
});
