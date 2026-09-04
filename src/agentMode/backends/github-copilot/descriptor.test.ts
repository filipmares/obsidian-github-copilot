import { GitHubCopilotBackendDescriptor } from "./descriptor";

const ISSUE = "https://github.com/logancyang/obsidian-copilot/issues/3096";

describe("descriptor", () => {
  describe("GitHubCopilotBackendDescriptor", () => {
    it(`${ISSUE} identifies a cloud agent with native model discovery`, () => {
      expect(GitHubCopilotBackendDescriptor).toMatchObject({
        id: "github-copilot",
        displayName: "GitHub Copilot",
        selfHostable: false,
        routesCopilotModels: false,
        skillsProjectDir: ".github/skills",
      });
    });

    it(`${ISSUE} round-trips supported reasoning effort in model ids`, () => {
      const encoded = GitHubCopilotBackendDescriptor.wire.encode({
        baseModelId: "claude-sonnet-4.6",
        effort: "high",
      });
      expect(encoded).toBe("claude-sonnet-4.6/high");
      expect(GitHubCopilotBackendDescriptor.wire.decode(encoded)).toEqual({
        selection: { baseModelId: "claude-sonnet-4.6", effort: "high" },
        provider: null,
      });
    });

    it(`${ISSUE} maps all canonical modes onto SDK agent modes`, () => {
      expect(GitHubCopilotBackendDescriptor.getModeMapping?.(null, null)).toEqual({
        kind: "setMode",
        canonical: { default: "default", plan: "plan", auto: "auto" },
        readOnlyModeId: "plan",
      });
    });
  });
});
