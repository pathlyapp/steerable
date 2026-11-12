class Steerable < Formula
  desc "Command line and terminal interface for the Steerable agent framework"
  homepage "https://steerableframework.com/"
  url "https://registry.npmjs.org/@steerable/agent-cli/-/agent-cli-0.9.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "Apache-2.0"

  # Homebrew's `node` follows the current LTS, which satisfies the CLI's
  # `engines` floor (22.19). A formula must not pin `node@22`: that formula
  # tracks one minor line and the CLI needs 22.19 or newer.
  depends_on "node"

  # The CLI ships prebuilt JS plus one optional runtime package per platform.
  # `npm install` picks the matching runtime; Homebrew only has to place the
  # command and link its dependency tree.
  def install
    system "npm", "install", *std_npm_args(prefix: libexec)
    bin.install_symlink libexec/"bin/steerable-cli"
  end

  def caveats
    <<~EOS
      Configure a model before the first run:

        steerable-cli login

      Or set the provider's environment variable and skip the prompt:

        export DEEPSEEK_API_KEY=sk-...

      `steerable-cli doctor` lists every runtime and configuration check with
      the command that fixes a failure.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/steerable-cli --version")

    # The terminal interface needs a TTY, so the smoke test drives `run`
    # without a credential: it must refuse to start and name the fix, which
    # exercises the whole preflight path without a network call.
    output = shell_output(
      "HOME=#{testpath} #{bin}/steerable-cli run test --no-project 2>&1",
      78,
    )
    assert_match "steerable-cli login", output
  end
end
