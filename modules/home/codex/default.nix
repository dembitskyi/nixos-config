# Codex (OpenAI) in the AI sandbox, as sandboxed on-demand sessions (see
# ../ai-sessions): the OpenAI API by default, optionally a local vLLM model
# behind llama-swap.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.home.codex;
  vcfg = cfg.vllm;

  # Codex parses every --config value as TOML; JSON strings are valid TOML
  # strings.
  toToml =
    value:
    if lib.isAttrs value then
      "{${lib.concatStringsSep "," (lib.mapAttrsToList (key: v: "${key}=${toToml v}") value)}}"
    else if lib.isBool value then
      lib.boolToString value
    else if lib.isInt value then
      toString value
    else
      builtins.toJSON value;
  configArgs = settings: lib.mapAttrsToList (key: value: "--config=${key}=${toToml value}") settings;

  # Sessions never ask (approval_policy "never"): the sandbox is the boundary.
  # The denies of opencode's policy (../opencode/curated-bash.nix) still block,
  # as requirements that Codex enforces over any rules a session writes; its
  # "ask" rules are left out, since "never" would reject them instead. Codex
  # matches whole leading tokens instead of globs, so each pattern keeps its
  # literal prefix ("gh*" stops `gh ...`). The "rtk "-prefixed duplicates only
  # exist for opencode's command rewriting.
  curatedBash = lib.filterAttrs (pattern: _: !lib.hasPrefix "rtk " pattern) (
    import ../opencode/curated-bash.nix
  );
  toTokens =
    pattern:
    let
      words = lib.filter (word: word != "" && word != "*") (lib.splitString " " pattern);
    in
    lib.init words ++ [ (lib.removeSuffix "*" (lib.last words)) ];
  requirements.rules.prefix_rules = lib.mapAttrsToList (pattern: _: {
    pattern = map (token: { inherit token; }) (toTokens pattern);
    decision = "forbidden";
    justification = "Sandbox policy for `${pattern}`.";
  }) (lib.filterAttrs (_: rule: rule == "deny") curatedBash);
  # Under "never", Codex refuses the commands its heuristic flags as
  # dangerous (forced rm, also inside shell scripts it cannot split) unless a
  # rule allows them. These rules must stay regular files: Codex skips
  # symlinks and drops all .rules files if any fails to parse.
  autoApproveRules = pkgs.writeText "auto-approve.rules" ''
    prefix_rule(pattern = ["rm"], decision = "allow")
    prefix_rule(pattern = [["bash", "sh", "zsh"], ["-c", "-lc"]], decision = "allow")
  '';
  # Codex reads enforced requirements and system rules only from /etc/codex,
  # where the session units mount this (the AI sandbox module provides the
  # mount point).
  policyDir = pkgs.runCommand "codex-policy" { } ''
    mkdir -p $out/rules
    cp ${(pkgs.formats.toml { }).generate "requirements.toml" requirements} $out/requirements.toml
    cp ${autoApproveRules} $out/rules/auto-approve.rules
  '';

  # Codex's own sandbox (bubblewrap) needs user namespaces, which the session
  # sandbox forbids, so the session unit is the boundary, as for opencode.
  # --no-daemon keeps the shared, self-updating app-server from starting.
  commonArgs = [
    "--no-daemon"
    "--sandbox=danger-full-access"
    "--ask-for-approval=never"
  ]
  ++ configArgs {
    "analytics.enabled" = false;
    "feedback.enabled" = false;
    "otel.metrics_exporter" = "none";
    check_for_update_on_startup = false;
    # There is no keyring in the sandbox.
    cli_auth_credentials_store = "file";
    file_opener = "none";
  };

  vllmArgs = configArgs {
    "model_providers.vllm" = {
      name = "llama-swap";
      base_url = vcfg.baseUrl;
      wire_api = "responses";
      # A failed cold start must not trigger another one.
      request_max_retries = 0;
      stream_max_retries = 1;
      # Long prefills stream nothing for minutes.
      stream_idle_timeout_ms = 900000;
    };
    model_provider = "vllm";
    model_context_window = vcfg.contextWindow;
    # Leaves a quarter of the window for reasoning and output.
    model_auto_compact_token_limit = vcfg.contextWindow * 3 / 4;
    model_reasoning_effort = vcfg.effortLevel;
    # vLLM returns raw reasoning, never summaries.
    model_reasoning_summary = "none";
    # llama-swap keeps one model resident and swaps (for minutes) on any
    # other name, so reviews use the same served model.
    review_model = vcfg.model;
    # Web search is hosted by OpenAI, and subagents multiply the load on the
    # one local model.
    web_search = "disabled";
    "features.multi_agent" = false;
  };
in
{
  options.mine.home.codex = {
    enable = lib.mkEnableOption "Codex (AI) sessions in the AI sandbox";

    model = lib.mkOption {
      type = lib.types.str;
      default = "gpt-6-luna";
      description = "Model of the default sessions, served by the OpenAI API (log in once with `codex login`).";
    };

    vllm = {
      enable = lib.mkEnableOption "an optional Codex session backed by a local vLLM model behind llama-swap";

      baseUrl = lib.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:5411/v1";
        description = "llama-swap endpoint, which proxies the vLLM backends' Responses API (/v1/responses).";
      };

      model = lib.mkOption {
        type = lib.types.str;
        example = "Qwen3.8-27B";
        description = "Served name of the vLLM model.";
      };

      contextWindow = lib.mkOption {
        type = lib.types.ints.positive;
        example = 262144;
        description = "Context window of the model (its vLLM max-model-len), which Codex cannot look up.";
      };

      effortLevel = lib.mkOption {
        type = lib.types.enum [
          "low"
          "medium"
          "high"
          "xhigh"
        ];
        default = "medium";
        description = ''
          Reasoning effort requested from the model. It must be one the model's
          chat template accepts: the Qwen3.8 templates accept low, medium and
          xhigh only.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    mine.home.ai-sessions.sessions.codex = {
      title = "Codex";
      command = lib.getExe pkgs.codex;
      args = commonArgs;
      defaultBackend = "openai";
      backends = {
        openai.args = [ "--model=${cfg.model}" ];
      }
      // lib.optionalAttrs vcfg.enable {
        vllm.args = [ "--model=${vcfg.model}" ] ++ vllmArgs;
      };
      slots = {
        s1 = {
          backend = "openai";
          comment = "Sandboxed Codex (${cfg.model})";
        };
        s2 = {
          backend = "openai";
          comment = "Sandboxed Codex (${cfg.model})";
        };
      }
      // lib.optionalAttrs vcfg.enable {
        l1 = {
          backend = "vllm";
          comment = "Sandboxed Codex on local vLLM (${vcfg.model})";
        };
      };
      sandbox.Service.BindReadOnlyPaths = [ "${policyDir}:/etc/codex" ];
    };
  };
}
