{
  lib,
  config,
  pkgs,
  ...
}:
let
  mkPromptFileOption =
    default: description:
    lib.mkOption {
      type = lib.types.path;
      inherit default description;
    };
  mkModelOption =
    default:
    lib.mkOption {
      type = lib.types.str;
      inherit default;
      description = "Model used by a parallel-orchestration agent.";
    };
  writePrompt = name: path: pkgs.writeText name (builtins.readFile path);

  # CLI tool for monitoring AI token usage and estimating Copilot costs.
  opencode-usage = pkgs.writeShellApplication {
    name = "opencode-usage";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec python3 ${./scripts/opencode-usage.py} \
        --pricing ${./scripts/pricing.json} \
        "$@"
    '';
  };

  # AI web search over CDP, driving the persistent ai-browser on port 9222.
  # Shared with the fastmcp sandbox so the /search command resolves there too.
  ai-search = pkgs.callPackage ./ai-search.nix { };

  # fzf picker backing the /skill TUI plugin (runs host-side in the TUI).
  skill-picker = pkgs.callPackage ./skill-picker.nix { };

  # /skill TUI plugin, with the picker's store path baked in. Declared in the
  # TUI plugin list (programs.opencode.tui.plugin) rather than the plugin drop-in
  # dir: the server auto-loads ~/.config/opencode/plugin, but the TUI only loads
  # plugins listed in tui.json. Listing it here also keeps it out of the
  # sandboxed server, which has no terminal to drive fzf.
  skillPlugin = pkgs.replaceVars ./plugins/skill.ts {
    skillPicker = lib.getExe skill-picker;
  };

  searchProvider = config.mine.home.opencode.searchProvider;

  orchestratorPlugin = pkgs.replaceVars ./plugins/orchestrator/plugin.ts {
    fallbackChain = lib.optionalString parallelCfg.fallback.enable (
      lib.concatStringsSep "," parallelCfg.fallback.chain
    );
  };

  # Per-server client overrides (e.g. timeout).
  clientOverrides = {
    playwright = {
      timeout = 300000;
    };
    browseruse = {
      timeout = 300000;
    };
    ghidra = {
      timeout = 900000;
    };
  };

  # Uncomment to connect a manually-started browser-use dev instance:
  # devMcpServers = {
  #   mcp_browseruse_dev = {
  #     type = "remote";
  #     enabled = true;
  #     url = "http://localhost:9999/browseruse";
  #     oauth = false;
  #     timeout = 300000;
  #   };
  # };

  defaultMcpServers = lib.mapAttrs' (
    name: url:
    let
      overrides = clientOverrides.${name} or { };
    in
    lib.nameValuePair "mcp_${lib.replaceStrings [ "-" ] [ "_" ] name}" (
      {
        type = "remote";
        enabled = true;
        inherit url;
        oauth = false;
      }
      // overrides
    )
  ) config.mine.home.opencode.mcpServerUrls;
  # Create prompt files in the nix store.
  buildPrompt = writePrompt "build-prompt.md" config.mine.home.opencode.promptFiles.build;
  localPrompt = writePrompt "local-prompt.md" config.mine.home.opencode.promptFiles.local;
  debugPrompt = writePrompt "debug-prompt.md" config.mine.home.opencode.promptFiles.debug;
  editorPrompt = writePrompt "english-prompt.md" config.mine.home.opencode.promptFiles.english;
  prPrompt = writePrompt "pr-prompt.md" config.mine.home.opencode.promptFiles.pr;
  genericPrompt = writePrompt "generic-prompt.md" config.mine.home.opencode.promptFiles.generic;
  browserPrompt = writePrompt "browser-prompt.md" config.mine.home.opencode.promptFiles.browser;
  notificationPrompt = writePrompt "notification-prompt.md" config.mine.home.opencode.promptFiles.notification;
  followPromptPrompt = writePrompt "follow-prompt.md" config.mine.home.opencode.promptFiles.follow-prompt;
  orchestratorPrompt = writePrompt "orchestrator-prompt.md" ./prompts/orchestrator/orchestrator.md;
  explorerPrompt = writePrompt "explorer-prompt.md" ./prompts/orchestrator/explorer.md;
  librarianPrompt = writePrompt "librarian-prompt.md" ./prompts/orchestrator/librarian.md;
  oraclePrompt = writePrompt "oracle-prompt.md" ./prompts/orchestrator/oracle.md;
  fixerPrompt = writePrompt "fixer-prompt.md" ./prompts/orchestrator/fixer.md;
  councillorPrompt = writePrompt "councillor-prompt.md" ./prompts/orchestrator/councillor.md;
  tools = import ./tools.nix;
  # Curated read-only bash allow-list spread into sub-agents that declare
  # their own permission.bash (which replaces, not merges with, the global
  # allow-list).
  curatedAgentBash = import ./curated-bash.nix;
  # Deny-by-default inspection-only bash for background research sub-agents,
  # where an `ask` cannot reach the user and only wastes a turn.
  readonlyAgentBash = import ./readonly-bash.nix;
  # Merge host-specific permission overrides into an agent's permission block.
  extraPerms = agent: config.mine.home.opencode.extraAgentPermissions.${agent} or { };
  withExtraPerms = agent: base: lib.recursiveUpdate base (extraPerms agent);
  # Merge host-specific tool overrides into an agent's tools list.
  extraTools = agent: config.mine.home.opencode.extraAgentTools.${agent} or { };
  withExtraTools = agent: base: base // (extraTools agent);

  # Parallel multi-agent orchestration: an opt-in orchestrator that fans work
  # out to specialist subagents via native background tasks. Gated behind
  # `parallelOrchestration.enable`; adds nothing when disabled.
  parallelCfg = config.mine.home.opencode.parallelOrchestration;
  parallelModels = parallelCfg.models;

  # Council prompt with the councillor roster baked in, so renaming seats in
  # `models.councillors` keeps the dispatch list and seat names in sync with the
  # actually-registered councillor-<name> agents.
  councilSeatNames = builtins.attrNames parallelModels.councillors;
  councilPrompt = pkgs.replaceVars ./prompts/orchestrator/council.md {
    councilDispatch = lib.concatStringsSep "\n" (
      map (
        name:
        "   - `task(subagent_type: \"councillor-${name}\", background: true, prompt: <question + context>)`"
      ) councilSeatNames
    );
    councilSeats = lib.concatStringsSep ", " councilSeatNames;
  };

  # One council seat per entry in `models.councillors`, each pinned to a
  # different model for genuine cross-model diversity. Hidden: dispatched only
  # by the council agent, never @-mentioned directly.
  councillorAgents = lib.mapAttrs' (
    name: model:
    lib.nameValuePair "councillor-${name}" {
      description = "Council seat (${name}): independent read-only advisor.";
      mode = "subagent";
      hidden = true;
      inherit model;
      prompt = "{file:${councillorPrompt}}";
      tools = lib.mergeAttrsList [
        tools.readTools
        tools.gitReadMcp
        tools.context7Mcp
        tools.aiSearch
      ];
    }
  ) parallelModels.councillors;

  # `task` allow-map letting the council dispatch only its own councillors.
  councilTaskPerms =
    (lib.mapAttrs' (name: _: lib.nameValuePair "councillor-${name}" "allow")
      parallelModels.councillors
    )
    // {
      "*" = "deny";
    };

  parallelAgents = lib.optionalAttrs parallelCfg.enable (
    {
      orchestrator = {
        description = "Plans and delegates work to specialist subagents, running independent lanes in parallel.";
        mode = "primary";
        model = parallelModels.orchestrator;
        prompt = "{file:${orchestratorPrompt}}";
        tools = withExtraTools "orchestrator" (
          lib.mergeAttrsList [
            tools.taskTool
            tools.readTools
            tools.writeTools
            tools.sessionId
            tools.cancelTask
            tools.aiSearch
            tools.memoryMcp
            tools.context7Mcp
            tools.githubMcpSearch
          ]
        );
        permission = withExtraPerms "orchestrator" {
          task = {
            "explorer" = "allow";
            "librarian" = "allow";
            "oracle" = "allow";
            "fixer" = "allow";
            "council" = "allow";
            "pr" = "allow";
            "vision" = "allow";
            "browser" = "allow";
            "*" = "deny";
          };
        };
      };

      explorer = {
        description = "Fast read-only codebase reconnaissance: locates files, symbols, and patterns, returning a compressed map.";
        mode = "subagent";
        hidden = true;
        model = parallelModels.explorer;
        prompt = "{file:${explorerPrompt}}";
        tools = lib.mergeAttrsList [
          tools.readTools
          tools.readonlyBash
          tools.gitReadMcp
          tools.aiSearch
        ];
        permission = withExtraPerms "explorer" {
          bash = readonlyAgentBash;
        };
      };

      librarian = {
        description = "External documentation and library research specialist.";
        mode = "subagent";
        hidden = true;
        model = parallelModels.librarian;
        prompt = "{file:${librarianPrompt}}";
        tools = lib.mergeAttrsList [
          tools.readTools
          tools.aiSearch
          tools.context7Mcp
          tools.githubMcpSearch
          tools.fetchMcp
        ];
      };

      oracle = {
        description = "Strategic advisor and reviewer: architecture, risk, hard debugging, and code review (read-only).";
        mode = "subagent";
        hidden = true;
        model = parallelModels.oracle;
        variant = "high";
        prompt = "{file:${oraclePrompt}}";
        tools = lib.mergeAttrsList [
          tools.readTools
          tools.gitReadMcp
          tools.context7Mcp
          tools.memoryMcp
          tools.aiSearch
        ];
      };

      fixer = {
        description = "Bounded implementation specialist: executes well-scoped code changes from a clear spec.";
        mode = "subagent";
        hidden = true;
        model = parallelModels.fixer;
        prompt = "{file:${fixerPrompt}}";
        tools = lib.mergeAttrsList [
          tools.readTools
          tools.writeTools
        ];
        permission = withExtraPerms "fixer" {
          bash = curatedAgentBash;
        };
      };

      council = {
        description = "Multi-model consensus: dispatches several councillor models on one question and synthesizes a single verdict. Invoke manually with @council.";
        mode = "all";
        hidden = true;
        model = parallelModels.council;
        variant = "high";
        prompt = "{file:${councilPrompt}}";
        tools = lib.mergeAttrsList [
          tools.taskTool
          tools.readTools
        ];
        permission = {
          task = councilTaskPerms;
        };
      };
    }
    // councillorAgents
  );
in
{
  imports = [
    ./permission.nix
  ];

  options = {
    mine.home.opencode.enable = lib.mkEnableOption "enable opencode (AI)";
    mine.home.opencode.mcpServerUrls = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Mapping of MCP server name to URL. Populated by the fastmcp NixOS module.";
    };
    mine.home.opencode.extraMcpServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Additional opencode MCP server definitions merged into the default MCP mapping.";
    };
    mine.home.opencode.extraAgents = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Additional opencode agent definitions merged into the default agent mapping.";
    };
    mine.home.opencode.promptFiles.build =
      mkPromptFileOption ./prompts/build.md "Prompt file used by the build opencode agent.";
    mine.home.opencode.promptFiles.local =
      mkPromptFileOption ./prompts/local.md "Prompt file used by the local opencode agent.";
    mine.home.opencode.promptFiles.debug =
      mkPromptFileOption ./prompts/debug.md "Prompt file used by the debug opencode agent.";
    mine.home.opencode.promptFiles.english =
      mkPromptFileOption ./prompts/english.md "Prompt file used by the refine opencode agent.";
    mine.home.opencode.promptFiles.pr =
      mkPromptFileOption ./prompts/pr.md "Prompt file used by the pr opencode subagent.";
    mine.home.opencode.promptFiles.generic =
      mkPromptFileOption ./prompts/generic.md "Prompt file used by the generic opencode agent.";
    mine.home.opencode.promptFiles.browser =
      mkPromptFileOption ./prompts/browser.md "Prompt file used by the browser opencode agent.";
    mine.home.opencode.promptFiles.notification =
      mkPromptFileOption ./prompts/notification.md "Prompt file used by the notification-analyzer opencode agent.";
    mine.home.opencode.promptFiles.follow-prompt =
      mkPromptFileOption ./prompts/follow-prompt.md "Prompt file used by the follow-prompt opencode agent.";
    mine.home.opencode.extraAgentPermissions = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Per-agent permission overrides, deep-merged into the corresponding agent's permission block. Keyed by agent name.";
    };
    mine.home.opencode.extraPermissions = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Extra global permission rules, deep-merged into the top-level opencode permission set.";
    };
    mine.home.opencode.extraAgentTools = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Per-agent tool overrides, merged into the corresponding agent's tools list. Keyed by agent name.";
    };
    mine.home.opencode.extraProviders = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Additional opencode provider definitions merged into the settings.";
    };
    mine.home.opencode.automationAgents = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Agent definitions only available in the automation opencode instance.";
    };
    mine.home.opencode.defaultModel = lib.mkOption {
      type = lib.types.str;
      default = "github-copilot/claude-opus-4.8-fast";
      description = "Default model used by opencode.";
    };
    mine.home.opencode.searchProvider = lib.mkOption {
      type = lib.types.enum [
        "perplexity"
        "google"
      ];
      default = "perplexity";
      description = "Provider used by the /search command (perplexity or google).";
    };
    mine.home.opencode.parallelOrchestration = {
      enable = lib.mkEnableOption "parallel multi-agent orchestration (orchestrator + specialist subagents + council)";
      models = {
        orchestrator = mkModelOption "github-copilot/claude-opus-4.8-fast";
        explorer = mkModelOption "github-copilot/gpt-5.5";
        librarian = mkModelOption "github-copilot/gpt-5.5";
        oracle = mkModelOption "github-copilot/claude-opus-4.8-fast";
        fixer = mkModelOption "github-copilot/claude-sonnet-5";
        council = mkModelOption "github-copilot/claude-opus-4.8-fast";
        councillors = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = {
            opus = "github-copilot/claude-opus-4.8-fast";
            gpt = "github-copilot/gpt-5.5";
            sonnet = "github-copilot/claude-sonnet-5";
          };
          description = "Council seats: map of seat name to model. Each seat runs a different model for cross-model diversity.";
        };
      };
      fallback = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Retry a rate-limited turn on the next model in the fallback chain.";
        };
        chain = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [
            "github-copilot/claude-opus-4.8-fast"
            "github-copilot/claude-sonnet-5"
            "github-copilot/gpt-5.5"
          ];
          description = "Ordered models tried on rate-limit failover.";
        };
      };
    };
  };

  config = lib.mkIf config.mine.home.opencode.enable {
    mine.home.opencode.automationAgents = {
      follow-prompt = {
        description = "Follows the user's prompt exactly.";
        mode = "primary";
        model = "github-copilot/claude-opus-4.8-fast";
        variant = "medium";
        prompt = "{file:${followPromptPrompt}}";
        tools = withExtraTools "follow-prompt" (
          lib.mergeAttrsList [
            tools.taskTool
            tools.readTools
            tools.writeTools
            tools.aiSearch
            tools.context7Mcp
            tools.githubMcpSearch
            tools.githubMcpWrite
          ]
        );
      };
    };

    xdg.desktopEntries.opencode = {
      name = "opencode (unsafe)";
      genericName = "OpenCode - AI coding agent";
      comment = "Launcher for opencode";
      exec = "tmux new-session -A -D -s ocode_u1 opencode";
      terminal = true; # set true if you want a terminal
      icon = "utilities-terminal"; # or a path to an icon
      type = "Application";
      categories = [ "Utility" ];
    };

    xdg.desktopEntries.opencode-s1 = {
      name = "opencode S1";
      genericName = "OpenCode - AI coding agent";
      comment = "Launcher for opencode";
      exec = "tmux new-session -A -D -s ocode_s1 bash -lc \"opencode attach http://127.0.0.1:4096\"";
      terminal = true; # set true if you want a terminal
      icon = "utilities-terminal"; # or a path to an icon
      type = "Application";
      categories = [ "Utility" ];
    };

    xdg.desktopEntries.opencode-s2 = {
      name = "opencode S2";
      genericName = "OpenCode - AI coding agent";
      comment = "Launcher for opencode";
      exec = "tmux new-session -A -D -s ocode_s2 bash -lc \"opencode attach http://127.0.0.1:4096\"";
      terminal = true; # set true if you want a terminal
      icon = "utilities-terminal"; # or a path to an icon
      type = "Application";
      categories = [ "Utility" ];
    };

    xdg.desktopEntries.opencode-a1 = {
      name = "opencode (automation)";
      genericName = "OpenCode - AI coding agent";
      comment = "Launcher for opencode";
      exec = "tmux new-session -A -D -s ocode_a1 bash -lc \"opencode attach http://127.0.0.1:4097\"";
      terminal = true; # set true if you want a terminal
      icon = "utilities-terminal"; # or a path to an icon
      type = "Application";
      categories = [ "Utility" ];
    };

    home.packages = [
      opencode-usage
      ai-search
      skill-picker
      pkgs.rtk
    ];

    xdg.configFile = {
      "opencode/plugin/env-protection.js" = {
        source = ./plugins/env-protection.js;
      };
      "opencode/plugin/rtk.ts" = {
        source = ./plugins/rtk.ts;
      };
      "opencode/tool/session-id.ts" = {
        source = ./tools/session-id.ts;
      };
      # AI-callable counterpart of the /search command. The provider is baked
      # from `searchProvider` by substituting the `@searchProvider@` placeholder.
      "opencode/tool/ai-search.ts" = {
        source = pkgs.replaceVars ./tools/ai-search.ts {
          inherit searchProvider;
        };
      };
      "rtk/config.toml" = {
        text = ''
          [hooks]
          exclude_commands = ["curl", "ps", "playwright", "grep"]
        '';
      };
    }
    // lib.optionalAttrs parallelCfg.enable {
      # Orchestrator runtime plugin (single file): live Background Job Board +
      # worker-session reuse + per-turn scheduler reminder, cross-model failover,
      # and task() fix hints. Logs to ~/.local/share/opencode/log/orchestrator.log.
      # The fallback chain is baked as a comma-separated list (empty = disabled).
      "opencode/plugin/orchestrator.ts" = {
        source = orchestratorPlugin;
      };
    };

    programs.opencode = {
      enable = true;
      package = pkgs.opencode;
      tui = {
        keybinds = {
          app_exit = "<leader>q";
          session_child_first = "ctrl+g";
        };
        theme = "catppuccin";
        # The TUI does not auto-load the plugin drop-in dir (only the server
        # does), so the /skill picker plugin is listed here explicitly.
        plugin = [ "${skillPlugin}" ];
      };
      settings = {
        share = "disabled";
        autoupdate = false;
        model = config.mine.home.opencode.defaultModel;
        default_agent = "local";
        # Allow nested subagents (e.g. council dispatching councillors).
        subagent_depth = 2;
        provider = config.mine.home.opencode.extraProviders;
        agent = {
          plan = {
            # Disable built-in `plan` agent.
            disable = true;
          };
          local = {
            description = "Analyzes code, explains logic and relationships, and provides expert advice grounded in the local project context.";
            mode = "primary";
            model = "github-copilot/claude-opus-4.8-fast";
            variant = "medium";
            prompt = "{file:${localPrompt}}";
            tools = withExtraTools "local" (
              lib.mergeAttrsList [
                tools.taskTool
                tools.readTools
                tools.timeMcp
                tools.sessionId
                tools.aiSearch
                tools.memoryMcp
                tools.gitReadMcp
                tools.context7Mcp
              ]
            );
          };
          refine = {
            description = "Writing Analyzing and Improving Prompt";
            hidden = true;
            mode = "primary";
            model = "github-copilot/claude-sonnet-4.6";
            prompt = "{file:${editorPrompt}}";
            tools = lib.mergeAttrsList [
              tools.disableSkill
            ];
          };
          pr = {
            description = "Creates and manages GitHub pull requests using MCP GitHub tools.";
            mode = "subagent";
            model = "github-copilot/claude-opus-4.8-fast";
            variant = "medium";
            prompt = "{file:${prPrompt}}";
            tools = lib.mergeAttrsList [
              tools.readTools
              tools.writeTools
              tools.disableSkill
              tools.githubMcpSearch
              tools.githubMcpWrite
            ];
            permission = withExtraPerms "pr" {
              bash = curatedAgentBash;
            };
          };
          build = {
            description = "Builds complex new features or entire applications based on a high-level description of what needs to be done.";
            mode = "primary";
            model = "github-copilot/claude-opus-4.8-fast";
            variant = "medium";
            prompt = "{file:${buildPrompt}}";
            tools = withExtraTools "build" (
              lib.mergeAttrsList [
                tools.taskTool
                tools.readTools
                tools.writeTools
                tools.sessionId
                tools.aiSearch
                tools.memoryMcp
                tools.context7Mcp
                tools.githubMcpSearch
                tools.githubMcpWrite
              ]
            );
            permission = withExtraPerms "build" {
              task = {
                "pr" = "allow";
                "vision" = "allow";
                "*" = "deny";
              };
            };
          };
          debug = {
            description = "Finds and fixes bugs in the codebase based on error messages, logs, or a description of the issue.";
            mode = "primary";
            model = "github-copilot/claude-opus-4.8-fast";
            variant = "medium";
            prompt = "{file:${debugPrompt}}";
            tools = withExtraTools "debug" (
              lib.mergeAttrsList [
                tools.taskTool
                tools.readTools
                tools.writeTools
                tools.sessionId
                tools.aiSearch
                tools.memoryMcp
                tools.context7Mcp
                tools.ghidraMcp
                tools.githubMcpSearch
                tools.githubMcpWrite
              ]
            );
            permission = withExtraPerms "debug" {
              task = {
                "*" = "deny";
              };
            };
          };
          generic = {
            description = "General-purpose assistant with web access via browser subagent.";
            mode = "primary";
            model = "github-copilot/claude-opus-4.8-fast";
            variant = "medium";
            prompt = "{file:${genericPrompt}}";
            tools = withExtraTools "generic" (
              lib.mergeAttrsList [
                tools.taskTool
                tools.readTools
                tools.writeTools
                tools.disableSkill
                tools.sessionId
                tools.aiSearch
                tools.memoryMcp
                tools.context7Mcp
                tools.githubMcpSearch
              ]
            );
            permission = withExtraPerms "generic" {
              task = {
                "browser" = "allow";
                "vision" = "allow";
                "*" = "deny";
              };
            };
          };
          browser = {
            description = "Browser automation subagent for web tasks using combined browseruse and playwright MCPs.";
            mode = "subagent";
            model = "github-copilot/claude-opus-4.8-fast";
            variant = "medium";
            prompt = "{file:${browserPrompt}}";
            tools = lib.mergeAttrsList [
              tools.disableSkill
              tools.browserUseMcp
              tools.browserMcp
            ];
          };
          vision = {
            description = "Analyzes images and returns a text description or answers questions about them.";
            mode = "subagent";
            model = "github-copilot/gpt-5.5";
            prompt = ''
              You are a vision analysis agent. When given an image file path, read it and analyze its contents.
              Provide detailed, structured descriptions of what you see. Answer any specific questions about the image.
            '';
            tools = {
              read = true;
              glob = true;
              skill = false;
            };
          };
          notification-analyzer = {
            description = "Classifies desktop notifications and outputs structured action markers.";
            hidden = true;
            mode = "primary";
            model = "github-copilot/gpt-5.4-mini";
            prompt = "{file:${notificationPrompt}}";
            tools = {
              bash = true;
              edit = false;
              write = false;
              skill = false;
            };
            permission = withExtraPerms "notification-analyzer" {
              bash = {
                "hyprctl dispatch exec *" = "allow";
                "*" = "deny";
              };
            };
          };
        }
        // parallelAgents
        // config.mine.home.opencode.extraAgents;
        tools = {
          "*" = false; # disable all tools, including MCP servers
        };
        mcp = defaultMcpServers // config.mine.home.opencode.extraMcpServers;
        # Append `// devMcpServers` above when testing with a dev browser-use instance.
        command = {
          # Runs an AI search via the ai-browser (CDP :9222) and injects the
          # result into the current session — enriching context, not a subtask.
          search = {
            description = "AI web search (${searchProvider}) to enrich context.";
            template = ''
              Results of an AI web search for the query below. Use them as
              context for the conversation; cite sources where relevant.

              !`ai-search --provider ${searchProvider} "$ARGUMENTS"`
            '';
          };
        };
      };
    };
  };
}
