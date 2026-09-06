import { execFileSync } from "node:child_process";
import { createRequire, isBuiltin } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const ISSUE = "https://github.com/logancyang/obsidian-copilot/issues/3096";
const nativeRequire = createRequire(resolve("package.json"));

// Build the installed SDK, not Jest's SDK mock: browser-field resolution changes
// its transport exports before the adapter ever sees the SDK namespace.
const buildProbe = `
  import esbuild from "esbuild";
  import nodeModuleShim, { nodeBuiltinExternals } from "./nodeModuleShim.mjs";
  const result = await esbuild.build({
    stdin: {
      contents: [
        'export { GitHubCopilotSdkBackendProcess } from "./src/agentMode/sdk/GitHubCopilotSdkBackendProcess";',
        'export const loadSdk = () => import("@github/copilot-sdk");',
      ].join("\\n"),
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    target: "es2020",
    minify: true,
    write: false,
    metafile: true,
    external: ["koffi", ...nodeBuiltinExternals],
    define: { "import.meta.url": "import_meta.url" },
    plugins: [
      nodeModuleShim,
      {
        name: "isolate-date-formatting",
        setup(build) {
          build.onResolve({ filter: /^@\\/utils$/ }, () => ({
            path: "date-formatting", namespace: "test",
          }));
          build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: "export const formatDateTime = () => '';",
          }));
        },
      },
    ],
  });
  process.stdout.write(JSON.stringify({
    code: result.outputFiles[0].text,
    inputs: Object.keys(result.metafile.inputs),
  }));
`;

function evaluateBundle(code) {
  const module = { exports: {} };
  const required = [];
  const context = {
    module,
    exports: module.exports,
    process,
    Buffer,
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    __filename: resolve("main.js"),
    import_meta: { url: "file:///copilot/main.js" },
    require(id) {
      required.push(id);
      if (!isBuiltin(id)) throw new Error(`Unexpected runtime dependency: ${id}`);
      return nativeRequire(id);
    },
  };
  context.window = context;
  runInNewContext(code, context, { timeout: 5000 });
  return { exports: module.exports, required };
}

describe("nodeModuleShim", () => {
  describe("setup()", () => {
    let bundle;

    beforeAll(() => {
      bundle = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "--eval", buildProbe], {
          cwd: resolve("."),
          encoding: "utf8",
          maxBuffer: 5_000_000,
          timeout: 30_000,
        })
      );
    }, 35_000);

    it(`${ISSUE} bundles the Node JSON-RPC transport instead of its browser-field replacement`, () => {
      expect(bundle.inputs).toContain("node_modules/vscode-jsonrpc/lib/node/main.js");
      expect(bundle.inputs).not.toContain("node_modules/vscode-jsonrpc/lib/browser/main.js");
    });

    it(`${ISSUE} leaves SDK and optional FFI evaluation off the Settings load path`, () => {
      const { exports, required } = evaluateBundle(bundle.code);
      expect(typeof exports.GitHubCopilotSdkBackendProcess).toBe("function");
      expect(required).toEqual([]);
    });

    it(`${ISSUE} initializes real SDK namespace getters on repeated minified CommonJS imports without koffi`, async () => {
      const { exports, required } = evaluateBundle(bundle.code);
      const sdk = await exports.loadSdk();
      expect(sdk.default).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(sdk, "CopilotClient").get).toEqual(
        expect.any(Function)
      );
      expect(typeof sdk.CopilotClient).toBe("function");
      expect(await exports.loadSdk()).toBe(sdk);
      const client = new sdk.CopilotClient({
        connection: sdk.RuntimeConnection.forStdio({ path: process.execPath }),
      });
      expect(client).toBeInstanceOf(sdk.CopilotClient);
      expect(required).not.toContain("koffi");
      expect(required).not.toContain("@github/copilot-sdk");
    });

    it(`${ISSUE} reaches CLI validation through the adapter's default SDK loader on every start attempt`, async () => {
      const { exports, required } = evaluateBundle(bundle.code);
      const backend = new exports.GitHubCopilotSdkBackendProcess({
        binaryPath: resolve("nonexistent-copilot-test-cli"),
        baseDirectory: resolve("."),
        descriptor: {},
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(backend.start()).rejects.toThrow(/CLI.*not found/i);
        expect(backend.isRunning()).toBe(false);
      }
      expect(required).not.toContain("koffi");
    });
  });
});
