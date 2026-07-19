import * as vscode from "vscode";

const defaultAlias = "active";

const aliasesStateKey = "aliases";

/** Called by VS Code. */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const extensionId: string = context.extension.packageJSON.name;

  // -------------------------------------------------------------------------------------------------
  // MARK: Aliases

  const aliases = function parseAliases(): Record<string, string | null> {
    try {
      return JSON.parse(context.workspaceState.get(aliasesStateKey) ?? "{}");
    } catch (e) {
      console.warn("Failed to parse targets from workspace state:", e);
      return {};
    }
  }();

  const setAlias = async (name: string, target: string | null | undefined) => {
    if (target === undefined) delete aliases[name];
    else aliases[name] = target;

    await Promise.all([
      vscode.commands.executeCommand(
        "setContext",
        `${extensionId}.${name}`,
        target,
      ),
      context.workspaceState.update(aliasesStateKey, JSON.stringify(aliases)),
    ]);
  };

  const promptAlias = async (alias: string) => {
    // https://github.com/bazel-contrib/vscode-bazel/blob/6518f01fd1d401d0af9be2d355b3d1e68ba4efac/src/extension/command_variables.ts#L208
    const target = await executeBazelCommand("bazel.pickTarget");

    if (target !== undefined) {
      await setAlias(alias, target);
      updateStatusBar();
    }

    return target;
  };

  // -----------------------------------------------------------------------------------------------
  // MARK: Status bar

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  context.subscriptions.push(statusBarItem);

  const updateStatusBar = () => {
    statusBarItem.text = aliases[defaultAlias] != null
      ? `$(heart) ${aliases[defaultAlias]}`
      : "$(heart) No active target";

    const targetKvs = Object.entries(aliases).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const queryString = (alias: string) =>
      encodeURIComponent(JSON.stringify({ alias }));

    statusBarItem.tooltip = new vscode.MarkdownString();

    if (targetKvs.every(([target]) => !target)) {
      statusBarItem.tooltip.appendMarkdown("| Alias | Target |\n|---|---|\n");

      for (const [alias] of targetKvs) {
        statusBarItem.tooltip.appendMarkdown(
          `| \`${alias}\` | [Click to set](command:${extensionId}.update?${
            queryString(alias)
          }) |\n`,
        );
      }
    } else {
      statusBarItem.tooltip.appendMarkdown(
        "| Alias | Target | Actions |\n|---|---|---|\n",
      );

      for (const [alias, target] of targetKvs) {
        statusBarItem.tooltip.appendMarkdown(
          `| \`${alias}\` | [${
            target ? `\`${target}\`` : "Click to set"
          }](command:${extensionId}.update?${queryString(alias)}) | ${
            target
              ? `[Build](command:${extensionId}.build?${
                queryString(alias)
              }) — [Copy label](command:${extensionId}.copy?${
                queryString(alias)
              })`
              : ""
          } |\n`,
        );
      }
    }
    statusBarItem.tooltip.isTrusted = true;
  };

  statusBarItem.command = `${extensionId}.update`;
  statusBarItem.name = "Bazel Aliases";

  // -----------------------------------------------------------------------------------------------
  // MARK: Batching

  // Store the subscriptions we have for each alias, since we want to dispose of them when the alias
  // is removed.
  const targetSubscriptions: Record<string, vscode.Disposable[]> = Object
    .create(null);

  context.subscriptions.push({
    dispose() {
      for (const subscriptions of Object.values(targetSubscriptions)) {
        for (const subscription of subscriptions) {
          subscription.dispose();
        }
      }
    },
  });

  // We execute commands in batches, so we can avoid running `bazel` commands multiple times for the
  // same target in quick succession.
  const batches: Record<string, Batch> = Object.create(null);

  const executeBatch = async (target: string, batch: Batch) => {
    if (batch.resolveBuild.length > 0 && batch.resolveEnvFile.length === 0) {
      // Explicitly build the target if we won't run it below.
      await executeBazelTask("build", target);

      for (const resolve of batch.resolveBuild) resolve();
    } else if (
      batch.resolveEnvFile.length + batch.resolveWorkingDir.length > 0
    ) {
      // If we need to run the target anyway, don't bother emitting `bazel build` first.
      const storageUri = context.storageUri!;

      await vscode.workspace.fs.createDirectory(storageUri);

      const runUnderId = target.replaceAll(/\W+/g, "_").replaceAll(
        /^_+|_+$/g,
        "",
      );
      const scriptPathUri = vscode.Uri.joinPath(
        storageUri,
        `${runUnderId}.env`,
      );

      // `--run_under=/bin/sh -c "env > '<env file>'"` would likely be more robust as it doesn't
      // require any parsing, but instead it produces a large environment that e.g. CodeLLDB's
      // `envFile` fails to parse (it does not support whitespace in env variable values).
      //
      // Instead, we use `--script_path` and transform it to an environment file here.
      const success = await executeBazelTask(
        "run",
        target,
        `--script_path=${scriptPathUri.fsPath}`,
      );

      if (!success) {
        for (const resolve of batch.resolveEnvFile) resolve(undefined);
      } else {
        const script = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(scriptPathUri),
        );
        const workingDirectory = script.match(/^cd (.+?) &&/m)![1];
        const env: string[] = [`PWD=${workingDirectory}`];

        for (const [, kv] of script.matchAll(/^\s+(\w+=.+) \\$/gm)) {
          env.push(kv);
        }

        await vscode.workspace.fs.writeFile(
          scriptPathUri,
          new TextEncoder().encode(env.join("\n")),
        );

        for (const resolve of batch.resolveEnvFile) {
          resolve(scriptPathUri.fsPath);
        }
        for (const resolve of batch.resolveWorkingDir) {
          resolve(workingDirectory);
        }
      }
    }

    if (batch.resolveOutput.length > 0) {
      // https://github.com/bazel-contrib/vscode-bazel/blob/6518f01fd1d401d0af9be2d355b3d1e68ba4efac/src/extension/command_variables.ts#L204-L207
      const output = await executeBazelCommand("bazel.getTargetOutput", target);

      for (const resolve of batch.resolveOutput) resolve(output);
    }
  };

  const scheduleBuild = (target: string) => {
    let batch = batches[target];

    if (batch === undefined) {
      batch = batches[target] = {
        resolveBuild: [],
        resolveOutput: [],
        resolveEnvFile: [],
        resolveWorkingDir: [],
      };

      setTimeout(() => {
        delete batches[target];

        executeBatch(target, batch).catch(() => {
          for (const resolve of batch.resolveBuild) resolve();
          for (const resolve of batch.resolveOutput) resolve(undefined);
          for (const resolve of batch.resolveEnvFile) resolve(undefined);
          for (const resolve of batch.resolveWorkingDir) resolve(undefined);
        });
      }, 100);
    }

    return batch;
  };

  // -----------------------------------------------------------------------------------------------
  // MARK: Commands

  const commands = {
    async update() {
      // No-op; the command wrapper updated `targets[alias]`.
    },
    async copy({ target }) {
      await vscode.env.clipboard.writeText(target);
    },
    async build({ target }) {
      await new Promise<void>((resolve) =>
        scheduleBuild(target).resolveBuild.push(resolve)
      );
    },
    async output({ target }) {
      return await new Promise<string | undefined>((resolve) => {
        const batch = scheduleBuild(target);
        batch.resolveBuild.push(() => {});
        batch.resolveOutput.push(resolve);
      });
    },
    async outputPath({ target }) {
      return await new Promise<string | undefined>((resolve) =>
        scheduleBuild(target).resolveOutput.push(resolve)
      );
    },
    async envFile({ target }) {
      return await new Promise<string | undefined>((resolve) =>
        scheduleBuild(target).resolveEnvFile.push(resolve)
      );
    },
    async workingDirectory({ target }) {
      return await new Promise<string | undefined>((resolve) =>
        scheduleBuild(target).resolveWorkingDir.push(resolve)
      );
    },
  } satisfies Record<
    string,
    (args: { target: string }) => Promise<void | string>
  >;

  const registerCommands = (alias: string) => {
    const subscriptions = targetSubscriptions[alias] ??= [];

    for (const rawCommandName in commands) {
      const commandName = rawCommandName as keyof typeof commands;
      const command = commands[commandName];

      const wrapper = async (
        args: unknown | { alias?: string | null; target?: string | null },
      ) => {
        // Parse arguments.
        if (Array.isArray(args)) args = args[0]; // Do this first to handle `args.length === 0`.

        if (args == null) {
          args = { alias };
        } else if (typeof args === "string") {
          args = { alias, target: args };
        } else if (typeof args !== "object") {
          throw new Error(
            `Invalid arguments for command ${extensionId}.${alias}.${commandName}: ${args}`,
          );
        }

        // Get missing arguments.
        const resolvedArgs = args as Record<string, unknown>;

        if (
          typeof resolvedArgs.alias !== "string" || resolvedArgs.alias === ""
        ) {
          resolvedArgs.alias = alias;
        }

        if (
          typeof resolvedArgs.target !== "string" || resolvedArgs.target === ""
        ) {
          resolvedArgs.target =
            (commandName === "update" ? undefined : aliases[alias]) ??
              await promptAlias(alias);
        } else if (commandName === "update") {
          // If a target was given for `update`, set it.
          setAlias(alias, resolvedArgs.target);
        }

        // Execute command.
        return await command(resolvedArgs as { target: string });
      };

      subscriptions.push(
        vscode.commands.registerCommand(
          `${extensionId}.${alias}.${commandName}`,
          wrapper,
        ),
      );

      if (alias === defaultAlias) {
        subscriptions.push(
          vscode.commands.registerCommand(
            `${extensionId}.${commandName}`,
            wrapper,
          ),
        );
      }
    }
  };

  const unregisterCommands = (aliasName: string) => {
    for (const subscription of targetSubscriptions[aliasName] ?? []) {
      subscription.dispose();
    }

    delete targetSubscriptions[aliasName];
  };

  // -------------------------------------------------------------------------------------------------
  // MARK: Configuration

  const configAliases = () => {
    const aliases: Record<string, string | null> = { [defaultAlias]: null };

    const config = vscode.workspace.getConfiguration(extensionId).inspect<
      Record<string, string>
    >("aliases");
    if (config === undefined) return aliases;

    for (
      const source of [
        "globalValue",
        "workspaceValue",
        "workspaceFolderValue",
      ] as const
    ) {
      if (!vscode.workspace.isTrusted && source !== "globalValue") break;

      const sourceAliases = config[source];
      if (sourceAliases == null) continue;

      for (const alias in sourceAliases) {
        const target = sourceAliases[alias];

        if (typeof target === "string") {
          // Go from least to most specific, overriding previous values.
          aliases[alias] = target;
        }
      }
    }

    return aliases;
  };

  const updateConfiguration = () => {
    const config = configAliases();
    const unseen = new Set(Object.keys(config));

    for (const alias in config) {
      if (!unseen.delete(alias)) {
        setAlias(alias, config[alias]);
        registerCommands(alias);
      }
    }

    for (const alias of unseen) {
      setAlias(alias, undefined);
      unregisterCommands(alias);
    }
  };

  // Watch configuration.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(extensionId)) updateConfiguration();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => updateConfiguration()),
  );

  // Apply initial configuration.
  for (
    const [alias, target] of Object.entries(configAliases())
  ) {
    setAlias(alias, aliases[alias] ?? target);
    registerCommands(alias);
  }

  // -----------------------------------------------------------------------------------------------
  // MARK: Startup

  updateStatusBar();
  statusBarItem.show();

  await cleanupStorage(context);
}

/** Called by VS Code. */
export async function deactivate(
  context: vscode.ExtensionContext,
): Promise<void> {
  await cleanupStorage(context);
}

// -------------------------------------------------------------------------------------------------
// MARK: Helpers

/** Removes temporary files created by the extension. */
async function cleanupStorage(context: vscode.ExtensionContext): Promise<void> {
  if (context.storageUri !== undefined) {
    await vscode.workspace.fs.delete(context.storageUri, {
      recursive: true,
      useTrash: false,
    }).then(undefined, () => {});
  }
}

/**
 * Same as `vscode.commands.executeCommand(command, ...args)`, but prompts the user to install the
 * Bazel extension if it is not installed.
 */
async function executeBazelCommand(
  command: string,
  ...args: [] | [any]
): Promise<string | undefined> {
  try {
    return await vscode.commands.executeCommand(command, ...args);
  } catch (e) {
    if (
      e instanceof Error && e.message === "command 'bazel.pickTarget' not found"
    ) {
      const choice = await vscode.window.showErrorMessage(
        "The Bazel extension is not installed. Please install it to use this extension.",
        "Install Bazel Extension",
      );

      if (choice === "Install Bazel Extension") {
        await vscode.commands.executeCommand(
          "workbench.extensions.installExtension",
          "BazelBuild.vscode-bazel",
        );

        return await vscode.commands.executeCommand(command, ...args);
      }
    }
  }
}

/**
 * Executes `bazel <build|run> <target> [extraArgs...]` and returns whether the command succeeded.
 *
 * This uses the Bazel extension's configuration to determine `bazel`, extra arguments, etc.
 */
async function executeBazelTask(
  command: "build" | "run",
  target: string,
  ...extraArgs: string[]
): Promise<boolean> {
  // Unfortunately `bazel.buildTarget` does not accept a target (it accepts a function, which we
  // cannot pass through `executeCommand()` [^1]), so we have to execute the task directly.
  //
  // [^1]: https://github.com/bazel-contrib/vscode-bazel/blob/6518f01fd1d401d0af9be2d355b3d1e68ba4efac/src/extension/bazel_wrapper_commands.ts#L70

  // Find the workspace folder corresponding to the Bazel workspace.
  const bazelWorkspace = await vscode.commands.executeCommand<string>(
    "bazel.info.workspace",
  );
  const workspaceFolder = vscode.workspace.workspaceFolders?.length === 1
    ? vscode.workspace.workspaceFolders[0]
    : vscode.workspace.getWorkspaceFolder(vscode.Uri.file(bazelWorkspace));

  // https://github.com/bazel-contrib/vscode-bazel/blob/6518f01fd1d401d0af9be2d355b3d1e68ba4efac/src/bazel/tasks.ts#L277-L287
  const task = new vscode.Task(
    {
      type: "bazel",
      command: "build",
      targets: [target],
    },
    workspaceFolder ?? vscode.TaskScope.Workspace,
    `${command} ${target}`,
    "bazel-aliases",
  );

  // https://github.com/bazel-contrib/vscode-bazel/blob/6518f01fd1d401d0af9be2d355b3d1e68ba4efac/src/bazel/tasks.ts#L229-L289
  const bazelConfiguration = vscode.workspace.getConfiguration("bazel");

  task.execution = new vscode.ProcessExecution(
    // https://github.com/bazel-contrib/vscode-bazel/blob/6518f01fd1d401d0af9be2d355b3d1e68ba4efac/src/bazel/tasks.ts#L268-L274
    bazelConfiguration.get<string>("executable", "bazel"),
    [
      ...bazelConfiguration.get<string[]>("commandLine.startupOptions", []),
      command,
      ...bazelConfiguration.get<string[]>("commandLine.commandArgs", []),
      target,
      ...extraArgs,
    ],
    { cwd: bazelWorkspace },
  );

  task.presentationOptions = {
    clear: false,
    close: true,
    echo: true,
    focus: false,
    panel: vscode.TaskPanelKind.Shared,
    reveal: vscode.TaskRevealKind.Silent,
    showReuseMessage: false,
  };

  // https://github.com/bazel-contrib/vscode-bazel/blob/6518f01fd1d401d0af9be2d355b3d1e68ba4efac/src/extension/command_variables.ts#L217-L223
  const taskExecution = await vscode.tasks.executeTask(task);

  return await new Promise<boolean>((resolve) => {
    const subscription = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== taskExecution) return;

      subscription.dispose();

      resolve(e.exitCode === 0);
    });
  });
}

interface Batch {
  resolveBuild: { (): void }[];
  resolveOutput: { (output: string | undefined): void }[];
  resolveEnvFile: { (envFile: string | undefined): void }[];
  resolveWorkingDir: { (workingDir: string | undefined): void }[];
}
