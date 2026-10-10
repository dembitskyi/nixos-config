{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.home.opencode;
  rules = import ./permissions.nix { inherit lib; };
  tools = import ./tools.nix;
  jsonFormat = pkgs.formats.json { };

  # AI web search over CDP, driving the persistent ai-browser on port 9222.
  # Backs the `websearch` tool through the host plugin.
  ai-search = pkgs.callPackage ./ai-search.nix { };

  # Community plugins, pinned so OpenCode never updates them on its own.
  memoryPlugin = "opencode-mem@2.29.2";
  pruningPlugin = "@tarquinen/opencode-dcp@3.2.0";
  subagentMonitorPlugin = "opencode-subagent-magazine@1.7.4";

  # Local plugins must be directories: OpenCode loads `index.ts` (or
  # `server.ts`) on the server and `tui.ts` in the terminal client.
  hostPlugin = ./plugins/host;
  crewPlugin = ./plugins/crew;
  lanesPlugin = ./plugins/lanes;

  # The /goal loop, pinned to a reviewed commit: keeps a session working toward
  # a standing goal until a judge model calls it done or blocked, or one of its
  # guards (turn budget, no tools, repetition, polling) stops it.
  goalPlugin = pkgs.fetchFromGitHub {
    name = "opencode-goal-plugin";
    owner = "zignd";
    repo = "opencode-goal-plugin";
    rev = "3ba0c50e585f7c3d6202fc72984b73b72de03aea";
    hash = "sha256-JPBY8mTkPKboy6xgDl8VIxjL+NwGYY5SUX1sbUAPMDg=";
  };

  ruleType = lib.types.submodule {
    options = {
      action = lib.mkOption {
        type = lib.types.str;
        description = "Permission action: a tool name or `<server>_<tool>`; wildcards allowed.";
      };
      resource = lib.mkOption {
        type = lib.types.str;
        default = "*";
        description = "Matched resource: a path, command, agent ID, or other tool-specific value.";
      };
      effect = lib.mkOption {
        type = lib.types.enum [
          "allow"
          "ask"
          "deny"
        ];
        description = "Effect applied when this is the last matching rule.";
      };
    };
  };

  agentType = lib.types.submodule {
    freeformType = jsonFormat.type;
    options = {
      system = lib.mkOption {
        type = lib.types.nullOr lib.types.lines;
        default = null;
        description = "System prompt. Definitions are concatenated, so hosts can append sections.";
      };
      tools = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Allow-list of permission actions (see tools.nix). When set, the agent
          starts from a deny-all and only these actions are allowed again, with
          the shared safety rules re-applied. A `!` prefix denies.
        '';
      };
      subagents = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Subagents this agent may launch.";
      };
      permissions = lib.mkOption {
        type = lib.types.listOf ruleType;
        default = [ ];
        description = "Extra ordered permission rules, applied after `tools` and `subagents`.";
      };
    };
  };

  renderRule = rule: { inherit (rule) action resource effect; };

  # Turns the module's agent shape into a native V2 `agents` entry.
  renderAgent =
    name: agent:
    let
      helpers = [
        "_module"
        "system"
        "tools"
        "subagents"
        "permissions"
      ];
      permissions =
        lib.optionals (agent.tools != null) (rules.allowOnly agent.tools)
        ++ map (rules.rule "allow" "subagent") agent.subagents
        ++ map renderRule agent.permissions;
    in
    lib.filterAttrs (key: value: value != null && !lib.elem key helpers) agent
    // lib.optionalAttrs (agent.system != null) {
      system = "{file:${pkgs.writeText "opencode-${name}.md" agent.system}}";
    }
    // lib.optionalAttrs (permissions != [ ]) { inherit permissions; };

  opusModel = "github-copilot/claude-opus-5.5";
  sonnetModel = "github-copilot/claude-sonnet-5.5";
  splitModel = model: lib.splitString "/" model;

  # `provider/model[#variant]` as the object plugins take.
  modelRef =
    ref:
    let
      parts = lib.splitString "#" ref;
      path = splitModel (builtins.head parts);
    in
    {
      providerID = builtins.head path;
      id = lib.concatStringsSep "/" (lib.drop 1 path);
    }
    // lib.optionalAttrs (builtins.length parts > 1) { variant = builtins.elemAt parts 1; };

  goalOptions = {
    inherit (cfg.goal) maxTurns;
  }
  // lib.optionalAttrs (cfg.goal.judgeModel != null) { judgeModel = modelRef cfg.goal.judgeModel; };

  # The AI sandbox only provides the browser-use MCP server when it is enabled there.
  browserUse = cfg.mcpServerUrls ? browseruse;

  # Subagents doing dev's work get its tools, minus questions, context compression, and lanes runs.
  subagentTools = lib.subtractLists [
    "question"
    "compress"
    "lanes_*"
  ] cfg.agents.dev.tools;

  devWorker = description: model: {
    inherit description;
    mode = "subagent";
    model = lib.mkDefault model;
    system = builtins.readFile ./prompts/dev-worker.md;
    tools = lib.mkDefault subagentTools;
  };
in
{
  options.mine.home.opencode = {
    enable = lib.mkEnableOption "opencode (AI)";
    defaultModel = lib.mkOption {
      type = lib.types.str;
      default = opusModel;
      description = "Default model as `provider/model`. The root default cannot carry a variant.";
    };
    defaultAgent = lib.mkOption {
      type = lib.types.str;
      default = "dev";
      description = "Default primary agent.";
    };
    agents = lib.mkOption {
      type = lib.types.attrsOf agentType;
      default = { };
      description = "Agents in the native V2 shape, plus the `tools` and `subagents` permission helpers.";
    };
    automationAgents = lib.mkOption {
      type = lib.types.attrsOf agentType;
      default = { };
      description = "Agents only available in the automation server.";
    };
    permissions = lib.mkOption {
      type = lib.types.listOf ruleType;
      default = [ ];
      description = "Extra global permission rules, appended after the built-in safety rules.";
    };
    providers = lib.mkOption {
      type = lib.types.attrsOf jsonFormat.type;
      default = { };
      description = ''
        Custom model providers as native V2 `providers` entries: a runtime
        `package`, `settings`, `headers`, `body`, and `models` with their
        `capabilities`, `limit`, `cost`, and `variants`. Packages ignore
        `settings` they do not know, so raw request fields belong in `body`.
      '';
    };
    mcpServerUrls = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "MCP server name to URL. Populated by the AI sandbox NixOS module.";
    };
    mcpServers = lib.mkOption {
      type = lib.types.attrsOf jsonFormat.type;
      default = { };
      description = "Extra MCP servers, as native V2 `mcp.servers` entries.";
    };
    plugins = lib.mkOption {
      type = lib.types.listOf jsonFormat.type;
      default = [ ];
      description = "Extra server plugins: package specs, plugin directories, or `{ package, options }`.";
    };
    skills = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Skills from the ai-skills pool exposed to opencode; definitions are
        concatenated. Every other pool skill is kept out of
        ~/.config/opencode/skills: OpenCode reads every installed skill
        eagerly, so the full pool exhausts memory.
      '';
    };
    extraSkills = lib.mkOption {
      type = lib.types.attrsOf lib.types.path;
      default = { };
      description = "Skills provided from Nix: skill ID to its SKILL.md.";
    };
    searchProvider = lib.mkOption {
      type = lib.types.enum [
        "perplexity"
        "google"
      ];
      default = "perplexity";
      description = "ai-search backend used by the websearch tool.";
    };
    memoryModel = lib.mkOption {
      type = lib.types.str;
      default = cfg.defaultModel;
      defaultText = lib.literalExpression "config.mine.home.opencode.defaultModel";
      description = "Model (`provider/model`) opencode-mem uses to auto-capture memories.";
    };
    contextPruning = lib.mkEnableOption "the Dynamic Context Pruning plugin (opencode-dcp) and dev's `compress` tool";
    maxLanes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 8;
      description = "Default and maximum number of parallel lanes in a lanes run.";
    };
    goal = {
      judgeModel = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = sonnetModel;
        description = "Model (`provider/model[#variant]`) that judges after every /goal turn whether the goal is done; null uses the session's model.";
      };
      maxTurns = lib.mkOption {
        type = lib.types.ints.positive;
        default = 50;
        description = "Continuation turns a /goal may take before it pauses; `/goal budget` changes it for one session.";
      };
    };
    crewPresets = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf lib.types.str);
      default = { };
      example = {
        max = {
          general = "github-copilot/claude-opus-5.5#max";
          vision = "github-copilot/gpt-6-luna#xhigh";
        };
      };
      description = "Named `/crew` presets: subagent ID to `provider/model[#variant]`.";
    };
    automationConfig = lib.mkOption {
      inherit (jsonFormat) type;
      readOnly = true;
      internal = true;
      description = "Config overlay for the automation server (OPENCODE_CONFIG_CONTENT).";
    };
  };

  config = lib.mkIf cfg.enable {
    mine.home.opencode = {
      agents = {
        # `dev` replaces the built-in build agent; plan is unused.
        build.disabled = true;
        plan.disabled = true;

        dev = {
          description = "Primary engineering agent: builds and debugs code, decompiles binaries, drives the browser, and researches.";
          mode = "primary";
          model = lib.mkDefault "${opusModel}#medium";
          system = builtins.readFile ./prompts/dev.md;
          tools = lib.concatLists [
            tools.read
            tools.write
            tools.research
            tools.opencode
            tools.github
            tools.context7
            tools.playwright
            (lib.optionals browserUse tools.browseruse)
            tools.ghidra
            tools.lanes
            [
              "question"
              "skill"
            ]
            (lib.optional cfg.contextPruning "compress")
          ];
          subagents = [
            "general"
            "explore"
            "dev-junior"
            "dev-senior"
            "pr"
            "vision"
          ];
        };

        # Built-in research subagent, given dev's tools (but no questions or
        # context compression) and the shared research prompt.
        general = {
          description = "General-purpose assistant for software and configuration research, local code inspection, and web search.";
          model = lib.mkDefault "${opusModel}#medium";
          system = builtins.readFile ./prompts/general.md;
          tools = lib.mkDefault subagentTools;
        };

        # The built-in explore agent allows all shell commands and .env reads;
        # re-apply the shared exceptions after its own rules.
        explore = {
          model = lib.mkDefault "${sonnetModel}#xhigh";
          permissions = rules.shellExceptions ++ rules.envReads ++ [ (rules.deny "webfetch") ];
        };

        dev-junior = devWorker "Implements small, well-specified code changes: fixes, tests, and mechanical edits." "${sonnetModel}#medium";
        dev-senior = devWorker "Implements complex code changes that need design judgment, deep debugging, or cross-cutting refactors." "${opusModel}#medium";

        # Started by the lanes plugin for each run, never launched by dev.
        planner = {
          description = "Plans lanes runs: splits a goal into tasks on disjoint files for dev-junior and dev-senior, then re-plans as results arrive.";
          mode = "subagent";
          model = lib.mkDefault "${opusModel}#medium";
          system = builtins.readFile ./prompts/planner.md;
          tools = tools.read ++ tools.plan;
        };

        pr = {
          description = "Creates and manages GitHub pull requests using MCP GitHub tools.";
          mode = "subagent";
          model = lib.mkDefault "${opusModel}#medium";
          system = builtins.readFile ./prompts/pr.md;
          tools = tools.read ++ tools.write ++ tools.github;
        };

        vision = {
          description = "Analyzes images and returns a text description or answers questions about them.";
          mode = "subagent";
          model = lib.mkDefault "github-copilot/gpt-6-luna";
          system = ''
            You are a vision analysis agent. When given an image file path, read it and analyze its contents.
            Provide detailed, structured descriptions of what you see. Answer any specific questions about the image.
          '';
          tools = [
            "read"
            "glob"
          ];
        };

        refine = {
          description = "Writing Analyzing and Improving Prompt";
          mode = "primary";
          hidden = true;
          model = lib.mkDefault "github-copilot/gpt-5.6-luna";
          system = builtins.readFile ./prompts/english.md;
          tools = [ ];
        };

        notification-analyzer = {
          description = "Classifies desktop notifications and outputs structured action markers.";
          mode = "primary";
          hidden = true;
          model = lib.mkDefault "github-copilot/gpt-5.4-mini";
          system = builtins.readFile ./prompts/notification.md;
          tools = [ ];
          permissions = [
            {
              action = "shell";
              resource = "hyprctl dispatch exec *";
              effect = "allow";
            }
          ];
        };
      };

      automationAgents.follow-prompt = {
        description = "Follows the user's prompt exactly.";
        mode = "primary";
        model = lib.mkDefault "${opusModel}#medium";
        system = builtins.readFile ./prompts/follow-prompt.md;
        tools = lib.concatLists [
          tools.read
          tools.write
          [ "websearch" ]
          tools.context7
          tools.github
        ];
      };

      extraSkills = {
        debugging = ./skills/debugging.md;
        ghidra = ./skills/ghidra.md;
        browser-automation =
          if browserUse then ./skills/browser-automation-browseruse.md else ./skills/browser-automation.md;
      };

      skills = [
        "cpp-pro"
        "python-pro"
        "hyprland"
        "nixos"
      ];

      automationConfig = {
        agents = lib.mapAttrs renderAgent cfg.automationAgents;
        # One-shot automation sessions need no memory capture, context
        # pruning or subagent controls.
        plugins = [
          "-opencode-mem"
          "-crew"
          "-lanes"
          "-goal"
        ]
        ++ lib.optional cfg.contextPruning "-opencode-dcp";
      };
    };

    # Only the curated pool skills are deployed; the Nix-provided ones are kept.
    mine.home.ai-skills = {
      include = cfg.skills;
      keep = lib.attrNames cfg.extraSkills;
    };

    xdg.desktopEntries.opencode = {
      name = "opencode (unsafe)";
      genericName = "OpenCode - AI coding agent";
      comment = "OpenCode with a private, unsandboxed server";
      exec = "tmux new-session -A -D -s ocode_u1 opencode --standalone";
      terminal = true;
      icon = "utilities-terminal";
      type = "Application";
      categories = [ "Utility" ];
    };

    home.packages = [ ai-search ];

    xdg.configFile = {
      "opencode/cli.json" = {
        # The TUI rewrites this file when settings change in its dialog; Nix stays authoritative.
        force = true;
        source = jsonFormat.generate "opencode-cli.json" {
          "$schema" = "https://opencode.ai/v2/cli.json";
          theme.name = "catppuccin";
          plugins = [
            {
              package = "${crewPlugin}";
              options = {
                presets = cfg.crewPresets;
                # Started by the lanes plugin rather than the subagent tool.
                managed.planner = "lanes planner";
              };
            }
            "${lanesPlugin}"
            "${goalPlugin}"
            subagentMonitorPlugin
          ]
          ++ lib.optional cfg.contextPruning pruningPlugin;
        };
      };
      "opencode/opencode-mem.jsonc" = {
        force = true;
        source = jsonFormat.generate "opencode-mem.jsonc" {
          autoUpdate = false;
          opencodeProvider = builtins.head (splitModel cfg.memoryModel);
          opencodeModel = lib.concatStringsSep "/" (lib.drop 1 (splitModel cfg.memoryModel));
        };
      };
    }
    // lib.optionalAttrs cfg.contextPruning {
      "opencode/dcp.jsonc" = {
        force = true;
        source = jsonFormat.generate "dcp.jsonc" { autoUpdate = false; };
      };
    }
    // lib.mapAttrs' (
      name: path: lib.nameValuePair "opencode/skills/${name}/SKILL.md" { source = path; }
    ) cfg.extraSkills;

    programs.opencode = {
      enable = true;
      package = pkgs.opencode;
      settings = {
        model = cfg.defaultModel;
        default_agent = cfg.defaultAgent;
        share = "disabled";
        update = "disable";
        websearch.provider = "ai-search";
        permissions = rules.global ++ map renderRule cfg.permissions;
        agents = lib.mapAttrs renderAgent cfg.agents;
        mcp.servers =
          lib.mapAttrs' (
            name: url:
            lib.nameValuePair "mcp_${lib.replaceStrings [ "-" ] [ "_" ] name}" {
              type = "remote";
              inherit url;
              oauth = false;
            }
          ) cfg.mcpServerUrls
          // cfg.mcpServers;
        commands.grill-me = {
          description = "Relentless design-tree interview to stress-test a plan before building.";
          template = ''
            {file:${./prompts/grill-me.md}}

            Subject (if empty, grill me on the current plan/conversation): $ARGUMENTS
          '';
        };
        plugins = [
          {
            package = "${hostPlugin}";
            options = {
              command = lib.getExe ai-search;
              provider = cfg.searchProvider;
            };
          }
          "${crewPlugin}"
          {
            package = "${lanesPlugin}";
            options.maxLanes = cfg.maxLanes;
          }
          {
            package = "${goalPlugin}";
            options = goalOptions;
          }
          memoryPlugin
        ]
        ++ lib.optional cfg.contextPruning pruningPlugin
        ++ cfg.plugins;
      }
      // lib.optionalAttrs (cfg.providers != { }) { inherit (cfg) providers; };
    };
  };
}
