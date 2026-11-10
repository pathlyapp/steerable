# Packaging

Artifacts for distributing the CLI outside npm.

## Homebrew

`homebrew/steerable.rb` is a `Language::Node` formula. It is not in Homebrew
core; it belongs to a tap:

```bash
brew tap pathlyapp/steerable
brew install steerable
```

### Publishing a version

1. Publish the npm packages (see `RELEASING.md`). The platform runtime packages
   must be on the registry first, or `npm install` inside the formula fails.
2. Fill in the tarball digest:

   ```bash
   version=0.9.0
   curl -fsSL "https://registry.npmjs.org/@steerable/agent-cli/-/agent-cli-${version}.tgz" \
     | shasum -a 256
   ```

   Put the result in `url` and `sha256`, replacing the placeholder.
3. Copy the file into the tap repository (`pathlyapp/homebrew-steerable`) as
   `Formula/steerable.rb`.
4. Verify on a machine without a global npm install:

   ```bash
   brew install --build-from-source pathlyapp/steerable/steerable
   brew test steerable
   steerable-cli doctor
   ```

The formula's test asserts two things: `--version` reports the formula version,
and `run` without a credential exits 78 with the fix in its output. That second
assertion is the cheap way to prove the whole preflight path works from a
Homebrew install, with no network call and no key.

## install.sh

`scripts/install.sh` is the `curl | sh` path. It installs Node when the host has
none or an old one, then installs the CLI into `${STEERABLE_PREFIX}/npm`
(default `~/.local`) without sudo, and verifies the command runs.

```bash
curl -fsSL https://steerableframework.com/install.sh | sh
```

Serve it from the documentation site; the file lives in the repository so the
script and the docs cannot drift apart. Options:

| Variable | Meaning |
|---|---|
| `STEERABLE_VERSION` | exact version instead of `latest` |
| `STEERABLE_PREFIX` | install prefix (default `~/.local`) |
| `STEERABLE_NO_NODE` | never install Node; fail instead |

Both paths end at the same place: `steerable-cli login`, then
`steerable-cli run`. Neither downloads the runtime separately — the npm package
carries the platform runtime for the host.
