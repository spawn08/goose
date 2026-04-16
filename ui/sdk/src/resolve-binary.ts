import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PLATFORMS: Record<string, string> = {
  "darwin-arm64": "@aaif/goose-binary-darwin-arm64",
  "darwin-x64": "@aaif/goose-binary-darwin-x64",
  "linux-arm64": "@aaif/goose-binary-linux-arm64",
  "linux-x64": "@aaif/goose-binary-linux-x64",
  "win32-x64": "@aaif/goose-binary-win32-x64",
};

/**
 * Resolves the path to the platform-specific goose binary installed as an
 * optional dependency of this package. Returns `null` if no binary is
 * available for the current platform.
 */
export function resolveGooseBinary(): string | null {
  const pkg = PLATFORMS[`${process.platform}-${process.arch}`];
  if (!pkg) return null;

  try {
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
    const binName = process.platform === "win32" ? "goose.exe" : "goose";
    return join(pkgDir, "bin", binName);
  } catch {
    return null;
  }
}
