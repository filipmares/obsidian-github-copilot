const execFileAsync = jest.fn();

jest.mock("@/utils/desktopRuntime", () => ({
  requireNodeModule: (name: string) => {
    if (name === "child_process") return { execFile: jest.fn() };
    if (name === "util") return { promisify: () => execFileAsync };
    throw new Error(`Unexpected module: ${name}`);
  },
}));

import { parseGitHubCopilotVersionOutput, probeGitHubCopilotVersion } from "./githubCopilotVersion";

const ISSUE = "https://github.com/logancyang/obsidian-copilot/issues/3096";

describe("githubCopilotVersion", () => {
  beforeEach(() => execFileAsync.mockReset());

  describe("parseGitHubCopilotVersionOutput()", () => {
    it(`${ISSUE} extracts semantic versions from CLI output`, () => {
      expect(parseGitHubCopilotVersionOutput("GitHub Copilot CLI 1.0.79")).toBe("1.0.79");
    });

    it(`${ISSUE} rejects output without a semantic version`, () => {
      expect(parseGitHubCopilotVersionOutput("copilot version unknown")).toBeNull();
    });
  });

  describe("probeGitHubCopilotVersion()", () => {
    it(`${ISSUE} accepts the minimum supported external CLI`, async () => {
      execFileAsync.mockResolvedValue({ stdout: "1.0.79", stderr: "" });
      await expect(probeGitHubCopilotVersion("/usr/local/bin/copilot", {})).resolves.toEqual({
        kind: "supported",
        version: "1.0.79",
      });
    });

    it(`${ISSUE} rejects an older external CLI with upgrade guidance`, async () => {
      execFileAsync.mockResolvedValue({ stdout: "1.0.78", stderr: "" });
      await expect(probeGitHubCopilotVersion("/usr/local/bin/copilot", {})).resolves.toMatchObject({
        kind: "incompatible",
        version: "1.0.78",
      });
    });

    it(`${ISSUE} runs an npm JavaScript entry point with the host Node runtime`, async () => {
      execFileAsync.mockResolvedValue({ stdout: "1.0.79", stderr: "" });
      await probeGitHubCopilotVersion("C:\\npm\\@github\\copilot\\npm-loader.js", { TEST: "1" });
      expect(execFileAsync).toHaveBeenCalledWith(
        process.execPath,
        ["C:\\npm\\@github\\copilot\\npm-loader.js", "--version"],
        expect.objectContaining({
          env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1", TEST: "1" }),
        })
      );
    });

    it(`${ISSUE} fails when version output is unreadable`, async () => {
      execFileAsync.mockResolvedValue({ stdout: "unknown", stderr: "" });
      await expect(probeGitHubCopilotVersion("/usr/local/bin/copilot", {})).rejects.toThrow(
        "Could not read"
      );
    });
  });
});
