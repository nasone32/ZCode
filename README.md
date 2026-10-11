# ZCode fork — ChatGPT OAuth + open-source coding-plan auth

Fork of [zai-org/ZCode](https://github.com/zai-org/ZCode), based on v3.15.1.

## What this fork does

- **Sign in with ChatGPT** — use your ChatGPT Plus/Pro subscription in ZCode: OpenAI models (GPT-6.1-Sol and friends) show up in the model picker, no API key required. Tokens are stored in the local encrypted credential store and refreshed automatically.
- **Coding-plan requests work from open-source builds** — model traffic goes directly to `api.z.ai` / `open.bigmodel.cn` using the short-lived project access token. Official binaries route these calls through a gateway that requires a client signature not included in the open-source edition, so every GLM request from a self-built app failed with `401 Unauthorized`.
- **Subagent retry fix** — client signing lifecycle errors (e.g. "request signer has been disposed") are retried instead of killing the subagent.

## Download & install

Get the installer from [Releases](https://github.com/nasone32/ZCode/releases), then on Debian/Ubuntu:

```bash
sudo apt install ./ZCode\ Preview-3.15.1-linux-amd64.deb
```

An AppImage is also available (`chmod +x` it, then run).

The package installs **ZCode Preview**, a separate app that lives **alongside** your regular ZCode installation: different app id (`dev.zcode.app.preview`), own profile (`~/.config/ZCode Preview`). Your normal ZCode is untouched, and both share the same `~/.zcode` login credentials.

## Sign in with OpenAI (one-time, via CLI)

There is no extra button in the desktop UI. Authenticate once with the bundled CLI — it writes the OpenAI tokens to the shared credential store, and the desktop app picks them up immediately (even while running):

```bash
node "/opt/ZCode Preview/resources/glm/zcode.cjs" login chatgpt
```

A browser window opens for OpenAI consent; after it completes, the OpenAI models appear in the model picker inside ZCode Preview. To disconnect: `node "/opt/ZCode Preview/resources/glm/zcode.cjs" logout chatgpt`.

## Build from source

```bash
pnpm install
cd packages/desktop
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 ZCODE_SKIP_REMOTE_ASSETS=1 pnpm build
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 ZCODE_TARGET_OS=linux ZCODE_TARGET_ARCH=x64 ZCODE_SKIP_REMOTE_ASSETS=1 \
  pnpm exec electron-builder --config electron-builder.config.js --linux AppImage deb --x64
```

Installers land in `packages/desktop/dist/`.
