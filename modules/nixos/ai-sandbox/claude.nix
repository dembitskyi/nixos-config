# Claude Code sessions (sessions.nix).
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.ai-sandbox.claude;
  vcfg = cfg.vllm;
  units = import ./units.nix { inherit lib pkgs config; };
  playwright = config.mine.ai-sandbox.mcpServers.playwright;

  settingsFile = pkgs.writeText "claude-code-settings.json" (
    builtins.toJSON {
      skipDangerousModePermissionPrompt = true;
      permissions.defaultMode = "bypassPermissions";
    }
  );

  mcpConfigFile = pkgs.writeText "claude-code-mcp.json" (
    builtins.toJSON {
      mcpServers.playwright = {
        type = "stdio";
        command = builtins.head playwright.command;
        args = builtins.tail playwright.command;
        env = playwright.environment;
      };
    }
  );

  systemPromptAppend = pkgs.writeText "claude-code-system-prompt-append.md" ''
    # Browser for testing web apps

    The Playwright MCP tools (`mcp__playwright__*`) drive a real Chromium (the
    persistent ai-browser, Chrome DevTools Protocol at http://127.0.0.1:9222).
    Open your own servers at http://ai-sandbox:PORT, listening on 0.0.0.0.
    Use it whenever you need to test or look at a web app.

    - Open your own tab and close it when done. Leave the other tabs alone (they
      hold logged-in sessions other tools drive) and never close the browser.
    - The browser is headed: what you open shows on the user's screen.
    - Other agents use the same browser, so check which tab is selected before
      acting.
    - Automatically named outputs (snapshots, screenshots, console and network
      logs) go to ~/.cache/playwright-mcp/.
  '';

  commonEnv = {
    DISABLE_UPDATES = 1;
    DISABLE_TELEMETRY = 1;
    DISABLE_ERROR_REPORTING = 1;
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 1;
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = 1;
    FORCE_AUTOUPDATE_PLUGINS = 0;
    CLAUDE_CODE_DISABLE_AGENT_VIEW = 1;
  };

  vllmEnv = {
    ANTHROPIC_BASE_URL = vcfg.baseUrl;
    ANTHROPIC_AUTH_TOKEN = "dummy";
    ANTHROPIC_DEFAULT_OPUS_MODEL = vcfg.model;
    ANTHROPIC_DEFAULT_SONNET_MODEL = vcfg.model;
    ANTHROPIC_DEFAULT_HAIKU_MODEL = vcfg.model;
    ANTHROPIC_DEFAULT_FABLE_MODEL = vcfg.model;
    CLAUDE_CODE_SUBAGENT_MODEL = vcfg.model;
    CLAUDE_CODE_MAX_CONTEXT_TOKENS = vcfg.contextWindow;
    CLAUDE_CODE_AUTO_COMPACT_WINDOW = vcfg.contextWindow;
    CLAUDE_CODE_MAX_OUTPUT_TOKENS = vcfg.maxOutputTokens;
    CLAUDE_CODE_EFFORT_LEVEL = vcfg.effortLevel;
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 1;
    CLAUDE_CODE_ATTRIBUTION_HEADER = 0;
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE = 1;
    API_TIMEOUT_MS = 3000000;
    CLAUDE_STREAM_IDLE_TIMEOUT_MS = 1800000;
    API_FORCE_IDLE_TIMEOUT = 0;
    CLAUDE_CODE_MAX_RETRIES = 5;
  };
in
{
  options.mine.ai-sandbox.claude = {
    enable = lib.mkEnableOption "Claude Code sessions in the AI sandbox";

    model = lib.mkOption {
      type = lib.types.str;
      default = "claude-opus-5-5";
      description = "Model of the Anthropic API sessions (log in once with /login).";
    };

    vllm = {
      enable = lib.mkEnableOption "the isolated L1 session on a local vLLM model behind llama-swap";
      baseUrl = lib.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:5411";
        description = "llama-swap endpoint (Anthropic Messages API).";
      };
      model = lib.mkOption {
        type = lib.types.str;
        description = "Served name of the vLLM model, used for every model role.";
      };
      contextWindow = lib.mkOption {
        type = lib.types.ints.positive;
        description = "Context window of the model (its vLLM max-model-len).";
      };
      maxOutputTokens = lib.mkOption {
        type = lib.types.ints.positive;
        default = 32000;
      };
      effortLevel = lib.mkOption {
        type = lib.types.enum [
          "low"
          "medium"
          "high"
          "xhigh"
          "max"
        ];
        default = "medium";
        description = "Reasoning effort; the Qwen3.8 templates accept low, medium and xhigh only.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    mine.ai-sandbox.network.hostPorts = lib.optional cfg.vllm.enable (units.portOf cfg.vllm.baseUrl);

    # Ctrl+P: the command menu.
    home-manager.users.${config.variables.username}.programs.tmux.extraConfig = ''
      bind-key -n C-p if-shell -F '#{m:*claude-sandbox*,#{pane_start_command}}' 'send-keys C-s /' 'send-keys C-p'
    '';

    mine.ai-sandbox.sessions.claude = {
      title = "Claude Code";
      command = lib.getExe pkgs.claude-code;
      env = commonEnv;
      args = [
        "--settings=${settingsFile}"
        "--permission-mode=bypassPermissions"
        "--mcp-config=${mcpConfigFile}"
        "--append-system-prompt-file=${systemPromptAppend}"
      ];
      slotDirs = [ ".claude/sessions" ];
      backends = {
        anthropic.args = [ "--model=${cfg.model}" ];
      }
      // lib.optionalAttrs vcfg.enable {
        vllm = {
          env = vllmEnv;
          args = [
            "--model=${vcfg.model}"
            "--disallowedTools=WebSearch"
          ];
        };
      };
      slots =
        lib.genAttrs (map (n: "s${toString n}") (lib.range 1 6) ++ [ "a1" ]) (_: {
          backend = "anthropic";
          folder = "s1";
        })
        // lib.optionalAttrs vcfg.enable {
          l1 = {
            backend = "vllm";
            isolated = true;
          };
        };
    };
  };
}
