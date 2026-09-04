import * as path from "node:path";
import {
  githubCopilotBinarySearchDirs,
  resolveGitHubCopilotBinary,
} from "./githubCopilotBinaryResolver";

const ISSUE = "https://github.com/logancyang/obsidian-copilot/issues/3096";

function fsWith(paths: string[]) {
  const existing = new Set(paths);
  return {
    existsSync: (candidate: string): boolean => existing.has(candidate),
    readFileSync: (): string => "",
    readdirSync: (): string[] => [],
  };
}

describe("githubCopilotBinaryResolver", () => {
  describe("resolveGitHubCopilotBinary()", () => {
    it(`${ISSUE} prefers a valid user-configured executable`, () => {
      expect(
        resolveGitHubCopilotBinary({
          override: "C:\\tools\\copilot.exe",
          homeDir: "C:\\Users\\me",
          platform: "win32",
          env: {},
          fs: fsWith(["C:\\tools\\copilot.exe"]),
        })
      ).toBe("C:\\tools\\copilot.exe");
    });

    it(`${ISSUE} finds the npm package entry point when no native executable exists`, () => {
      const entry = path.win32.join(
        "C:\\Users\\me",
        "AppData",
        "Roaming",
        "npm",
        "node_modules",
        "@github",
        "copilot",
        "npm-loader.js"
      );
      expect(
        resolveGitHubCopilotBinary({
          homeDir: "C:\\Users\\me",
          platform: "win32",
          env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
          fs: fsWith([entry]),
        })
      ).toBe(entry);
    });

    it(`${ISSUE} maps a configured Windows npm shim to its spawnable package entry`, () => {
      const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd";
      const entry =
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\npm-loader.js";
      expect(
        resolveGitHubCopilotBinary({
          override: shim,
          homeDir: "C:\\Users\\me",
          platform: "win32",
          env: {},
          fs: fsWith([shim, entry]),
        })
      ).toBe(entry);
    });

    it(`${ISSUE} finds the POSIX npm package entry point when its bin shim is unavailable`, () => {
      const entry = "/Users/me/.npm-global/lib/node_modules/@github/copilot/npm-loader.js";
      expect(
        resolveGitHubCopilotBinary({
          homeDir: "/Users/me",
          platform: "darwin",
          env: {},
          fs: fsWith([entry]),
        })
      ).toBe(entry);
    });

    it(`${ISSUE} returns null when no external CLI exists`, () => {
      expect(
        resolveGitHubCopilotBinary({
          homeDir: "/Users/me",
          platform: "darwin",
          env: {},
          fs: fsWith([]),
        })
      ).toBeNull();
    });
  });

  describe("githubCopilotBinarySearchDirs()", () => {
    it(`${ISSUE} reports npm and well-known locations shown by setup UI`, () => {
      const dirs = githubCopilotBinarySearchDirs({
        homeDir: "/Users/me",
        platform: "darwin",
        env: {},
        fs: fsWith([]),
      });
      expect(dirs).toContain("/usr/local/bin");
      expect(dirs).toContain("/Users/me/.npm-global/bin");
    });
  });
});
