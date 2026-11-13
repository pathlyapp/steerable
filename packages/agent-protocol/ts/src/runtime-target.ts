/**
 * Host platform identifiers for the published runtime bundles.
 *
 * The same five names key the sidecar bundles (`build_sidecar.py`), the
 * platform npm packages (`@steerable/runtime-<target>`), and the egress proxy
 * release assets, so a mismatch between them is a compile-time typo rather
 * than a runtime miss.
 */

/** One platform the framework publishes a runtime bundle for. */
export type RuntimeTarget = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64';

/** Every published target, in the order the release tooling builds them. */
export const RUNTIME_TARGETS: readonly RuntimeTarget[] = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
];

/**
 * Maps a Node platform/arch pair to a published target.
 *
 * @param platform `process.platform` value.
 * @param arch `process.arch` value.
 * @returns The matching target, or `null` when the framework publishes no bundle for it.
 */
export function runtimeTargetFor(platform: string, arch: string): RuntimeTarget | null {
  const candidate = `${platform}-${arch}`;
  return (RUNTIME_TARGETS as readonly string[]).includes(candidate) ? (candidate as RuntimeTarget) : null;
}

/**
 * Target for the running host.
 *
 * Takes the pair explicitly: this package is pure data types with no Node
 * globals, so callers pass `process.platform` and `process.arch`.
 *
 * @param platform `process.platform` value.
 * @param arch `process.arch` value.
 * @returns The running host's target, or `null` on an unpublished platform.
 */
export function hostRuntimeTarget(platform: string, arch: string): RuntimeTarget | null {
  return runtimeTargetFor(platform, arch);
}

/**
 * Platform tag used by the in-repo `python-runtime/` bundle layout.
 *
 * Only these four directories exist in packaged desktop resources, so this
 * stays narrower than {@link RuntimeTarget}: a Linux arm64 desktop build has
 * no bundled layout and falls through to the platform npm package.
 *
 * @param platform `process.platform` value.
 * @param arch `process.arch` value.
 * @returns The bundled-directory tag, or `null`.
 */
export function bundledRuntimeTag(
  platform: string,
  arch: string,
): 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'win32-x64' | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'win32') return arch === 'x64' ? 'win32-x64' : null;
  if (platform === 'linux') return arch === 'x64' ? 'linux-x64' : null;
  return null;
}
