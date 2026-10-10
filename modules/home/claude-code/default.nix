# Claude Code in the AI sandbox, as sandboxed on-demand sessions (see
# ../ai-sessions): the Anthropic API by default, optionally a local vLLM model
# behind llama-swap.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.home.claude-code;
  vcfg = cfg.vllm;

  # Sessions never ask (bypassPermissions): the sandbox is the boundary. The
  # denies of the shared shell policy (../opencode/curated-bash.nix) still
  # block; its "ask" rules are left out, since Claude Code would still prompt
  # for them.
  curatedBash = import ../opencode/curated-bash.nix;
  settings = {
    # Skips the confirmation before entering bypassPermissions mode.
    skipDangerousModePermissionPrompt = true;
    permissions.deny =
      lib.mapAttrsToList (pattern: _: "Bash(${pattern})") (
        lib.filterAttrs (_: rule: rule == "deny") curatedBash
      )
      ++ [
        "Edit(//nix/**)"
        "WebFetch"
      ];
  };
  settingsFile = pkgs.writeText "claude-code-settings.json" (builtins.toJSON settings);

  # Claude Code is updated by Nix, not by itself, and sends no telemetry, error
  # reports, or other non-essential traffic. Agent view is off: its background
  # supervisor is reached through /tmp, which every session (and any host-side
  # Claude Code) shares.
  commonEnv = {
    DISABLE_UPDATES = 1;
    DISABLE_TELEMETRY = 1;
    DISABLE_ERROR_REPORTING = 1;
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 1;
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = 1;
    # The nixpkgs wrapper defaults this to 1, forcing plugin updates.
    FORCE_AUTOUPDATE_PLUGINS = 0;
    CLAUDE_CODE_DISABLE_AGENT_VIEW = 1;
  };

  vllmEnv = {
    ANTHROPIC_BASE_URL = vcfg.baseUrl;
    # llama-swap ignores it, but it makes Claude Code skip the login.
    ANTHROPIC_AUTH_TOKEN = "dummy";
    # llama-swap keeps one model resident and swaps (for minutes) on any
    # other name, so every model role resolves to the same served model.
    ANTHROPIC_DEFAULT_OPUS_MODEL = vcfg.model;
    ANTHROPIC_DEFAULT_SONNET_MODEL = vcfg.model;
    ANTHROPIC_DEFAULT_HAIKU_MODEL = vcfg.model;
    ANTHROPIC_DEFAULT_FABLE_MODEL = vcfg.model;
    CLAUDE_CODE_SUBAGENT_MODEL = vcfg.model;
    CLAUDE_CODE_MAX_CONTEXT_TOKENS = vcfg.contextWindow;
    CLAUDE_CODE_AUTO_COMPACT_WINDOW = vcfg.contextWindow;
    CLAUDE_CODE_MAX_OUTPUT_TOKENS = vcfg.maxOutputTokens;
    CLAUDE_CODE_EFFORT_LEVEL = vcfg.effortLevel;
    # Drop Anthropic-only request features, and the per-request attribution
    # header that defeats vLLM's prefix cache.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 1;
    CLAUDE_CODE_ATTRIBUTION_HEADER = 0;
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE = 1;
    # A cold model start can take up to llama-swap's health-check timeout
    # (45 minutes), and vLLM streams nothing while it prefills.
    API_TIMEOUT_MS = 3000000;
    CLAUDE_STREAM_IDLE_TIMEOUT_MS = 1800000;
    API_FORCE_IDLE_TIMEOUT = 0;
    CLAUDE_CODE_MAX_RETRIES = 5;
  };
in
{
  options.mine.home.claude-code = {
    enable = lib.mkEnableOption "Claude Code (AI) sessions in the AI sandbox";

    model = lib.mkOption {
      type = lib.types.str;
      default = "claude-opus-5-5";
      description = "Model of the default sessions, served by the Anthropic API (log in once with /login).";
    };

    vllm = {
      enable = lib.mkEnableOption "an optional Claude Code session backed by a local vLLM model behind llama-swap";

      baseUrl = lib.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:5411";
        description = "llama-swap endpoint, which proxies the vLLM backends' Anthropic Messages API (/v1/messages).";
      };

      model = lib.mkOption {
        type = lib.types.str;
        example = "Qwen3.8-27B";
        description = "Served name of the vLLM model used for every model role (main, subagents, background requests).";
      };

      contextWindow = lib.mkOption {
        type = lib.types.ints.positive;
        example = 262144;
        description = "Context window of the model (its vLLM max-model-len), which Claude Code cannot look up.";
      };

      maxOutputTokens = lib.mkOption {
        type = lib.types.ints.positive;
        default = 32000;
        description = "Maximum output tokens per request.";
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
        description = ''
          Reasoning effort requested from the model. It must be one the model's
          chat template accepts: Claude Code's default, "high", is rejected by
          the Qwen3.8 templates (low/medium/xhigh only).
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    mine.home.ai-sessions.sessions.claude = {
      title = "Claude Code";
      command = lib.getExe pkgs.claude-code;
      env = commonEnv;
      args = [
        "--settings=${settingsFile}"
        "--permission-mode=bypassPermissions"
      ];
      defaultBackend = "anthropic";
      backends = {
        anthropic.args = [ "--model=${cfg.model}" ];
      }
      // lib.optionalAttrs vcfg.enable {
        vllm = {
          env = vllmEnv;
          args = [
            "--model=${vcfg.model}"
            # WebSearch runs server-side at Anthropic; vLLM rejects it.
            "--disallowedTools=WebSearch"
          ];
        };
      };
      slots = {
        s1 = {
          backend = "anthropic";
          comment = "Sandboxed Claude Code (${cfg.model})";
        };
        s2 = {
          backend = "anthropic";
          comment = "Sandboxed Claude Code (${cfg.model})";
        };
      }
      // lib.optionalAttrs vcfg.enable {
        l1 = {
          backend = "vllm";
          comment = "Sandboxed Claude Code on local vLLM (${vcfg.model})";
        };
      };
    };
  };
}
