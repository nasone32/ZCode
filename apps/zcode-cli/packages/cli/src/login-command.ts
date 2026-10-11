import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";

export async function runLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  noBrowser: boolean,
  args: readonly string[] = [],
): Promise<number> {
  try {
    const providerId = args[0] ?? "zai";
    if (args.length > 1 || (providerId !== "zai" && providerId !== "bigmodel" && providerId !== "chatgpt")) {
      throw new Error("Usage: zcode login [zai|bigmodel|chatgpt] [--no-browser]");
    }
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    if (providerId === "chatgpt") {
      return await runChatGptLoginCommand(ctx, options, deps, env, noBrowser);
    }

    const login = deps.loginZCodeCli ?? (await loadBootstrapModule()).loginZCodeCli;
    const result = await login({
      env,
      noBrowser,
      providerId,
      onAuthorizeUrl: (data) => {
        writeAuthorizeUrl(ctx, options, data.authorize_url, noBrowser, providerId);
      },
      onBrowserOpen: (browser) => {
        if (!options.json && !browser.opened) {
          ctx.stdout.write(`Browser open failed: ${browser.reason ?? "unknown error"}\n`);
        }
      },
    });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "ready",
          provider: result.providerId,
          user: {
            user_id: result.user.user_id,
            ...(result.user.email ? { email: result.user.email } : {}),
            ...(result.user.name ? { name: result.user.name } : {}),
            ...(result.user.avatar ? { avatar: result.user.avatar } : {}),
          },
          model: result.model,
          credentialsPath: result.credentialsPath,
          configPath: result.configPath,
          browserOpened: result.browser?.opened ?? false,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      [
        `Login successful${formatUserLabel(result.user)}.`,
        `Model: ${result.model}`,
        `Credentials: ${result.credentialsPath}`,
        `Model selection: ${result.configPath}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

async function runChatGptLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  env: Readonly<Record<string, string | undefined>>,
  noBrowser: boolean,
): Promise<number> {
  const bootstrap = await loadBootstrapModule();
  const loginChatGpt = deps.loginChatGptCli ?? bootstrap.loginChatGptCli;
  const result = await loginChatGpt({
    env,
    noBrowser,
    onAuthorizeUrl: (data) => {
      writeAuthorizeUrl(ctx, options, data.authorize_url, noBrowser, "chatgpt");
    },
    onBrowserOpen: (browser) => {
      if (!options.json && !browser.opened) {
        ctx.stdout.write(`Browser open failed: ${browser.reason ?? "unknown error"}\n`);
      }
    },
  });

  if (options.json) {
    ctx.stdout.write(
      formatJson({
        status: "ready",
        provider: "chatgpt",
        account: {
          subject: result.account.subject,
          ...(result.account.email ? { email: result.account.email } : {}),
          ...(result.account.name ? { name: result.account.name } : {}),
        },
        models: result.models.map((model) => ({ id: model.slug, name: model.display_name })),
        credentialsPath: result.credentialsPath,
        browserOpened: result.browser?.opened ?? false,
      }),
    );
    return 0;
  }

  const label = result.account.email ?? result.account.name ?? result.account.subject;
  ctx.stdout.write(
    [
      `Signed in with ChatGPT as ${label}.`,
      `Models: ${result.models.map((model) => model.slug).join(", ")}`,
      `Credentials: ${result.credentialsPath}`,
      "Select ChatGPT models with /model (e.g. GPT Sol).",
    ].join("\n") + "\n",
  );
  return 0;
}

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  args: readonly string[] = [],
): Promise<number> {
  try {
    const providerId = args[0] ?? "zai";
    if (args.length > 1 || (providerId !== "zai" && providerId !== "chatgpt")) {
      throw new Error("Usage: zcode logout [zai|chatgpt]");
    }
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    if (providerId === "chatgpt") {
      const logoutChatGpt = deps.logoutChatGptCli ?? (await loadBootstrapModule()).logoutChatGptCli;
      const result = await logoutChatGpt({ env });
      if (options.json) {
        ctx.stdout.write(
          formatJson({
            status: "logged_out",
            provider: "chatgpt",
            revoked: result.revoked,
            credentialsPath: result.credentialsPath,
          }),
        );
        return 0;
      }
      ctx.stdout.write(
        [
          `Logged out from ChatGPT. Credentials: ${result.credentialsPath}`,
          result.revoked
            ? undefined
            : "Note: remote session revocation failed; disconnect the app in ChatGPT Settings if needed.",
        ]
          .filter((line) => line !== undefined)
          .join("\n") + "\n",
      );
      return 0;
    }

    const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
    const result = await logout({ env });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "logged_out",
          provider: "zai",
          credentialsPath: result.credentialsPath,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      `Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

function writeAuthorizeUrl(
  ctx: RunContext,
  options: GlobalOptions,
  authorizeUrl: string,
  noBrowser: boolean,
  providerId: "zai" | "bigmodel" | "chatgpt",
): void {
  const target = options.json ? ctx.stderr : ctx.stdout;
  if (noBrowser) {
    target.write(`Open this URL to sign in:\n${authorizeUrl}\n`);
    return;
  }

  const providerLabel =
    providerId === "bigmodel" ? "BigModel" : providerId === "chatgpt" ? "ChatGPT" : "Z.AI";
  target.write(
    `Opening browser for ${providerLabel} authorization.\nFallback URL:\n${authorizeUrl}\n`,
  );
}

function formatUserLabel(user: { email?: string; name?: string; user_id: string }): string {
  const label = user.name || user.email || user.user_id;
  return label ? ` as ${label}` : "";
}
