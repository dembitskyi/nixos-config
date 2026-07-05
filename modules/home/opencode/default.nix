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

  # Per-server client overrides (e.g. timeout).
  clientOverrides = {
    playwright = {
      timeout = 300000;
    };
    browseruse = {
      timeout = 300000;
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
  tools = import ./tools.nix;
  # Curated read-only bash allow-list spread into sub-agents that declare
  # their own permission.bash (which replaces, not merges with, the global
  # allow-list).
  curatedAgentBash = import ./curated-bash.nix;
  # Merge host-specific permission overrides into an agent's permission block.
  extraPerms = agent: config.mine.home.opencode.extraAgentPermissions.${agent} or { };
  withExtraPerms = agent: base: lib.recursiveUpdate base (extraPerms agent);
  # Merge host-specific tool overrides into an agent's tools list.
  extraTools = agent: config.mine.home.opencode.extraAgentTools.${agent} or { };
  withExtraTools = agent: base: base // (extraTools agent);
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
      default = "github-copilot/claude-opus-4.8";
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
  };

  config = lib.mkIf config.mine.home.opencode.enable {
    mine.home.opencode.automationAgents = {
      follow-prompt = {
        description = "Follows the user's prompt exactly.";
        mode = "primary";
        model = "github-copilot/claude-opus-4.8";
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
        provider = config.mine.home.opencode.extraProviders;
        agent = {
          plan = {
            # Disable built-in `plan` agent.
            disable = true;
          };
          local = {
            description = "Analyzes code, explains logic and relationships, and provides expert advice grounded in the local project context.";
            mode = "primary";
            model = "github-copilot/claude-opus-4.8";
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
            model = "github-copilot/claude-opus-4.8";
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
            model = "github-copilot/claude-opus-4.8";
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
            model = "github-copilot/claude-opus-4.8";
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
                tools.githubMcpSearch
                tools.githubMcpWrite
              ]
            );
          };
          generic = {
            description = "General-purpose assistant with web access via browser subagent.";
            mode = "primary";
            model = "github-copilot/claude-opus-4.8";
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
            model = "github-copilot/claude-opus-4.8";
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
