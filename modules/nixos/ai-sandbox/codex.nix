# Codex sessions (sessions.nix): the OpenAI API, or a local vLLM model behind
# llama-swap in the isolated L1.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.ai-sandbox.codex;
  vcfg = cfg.vllm;

  # Codex parses every --config value as TOML; JSON strings are TOML strings.
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

  # Sessions never ask, but the shared shell policy's denies stay enforced
  # requirements. Codex matches leading tokens, not globs.
  curatedBash = import ../../home/opencode/curated-bash.nix;
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
  # Under "never", Codex refuses what its heuristic flags (forced rm, shell
  # scripts) unless allowed. Rules must be regular files.
  autoApproveRules = pkgs.writeText "auto-approve.rules" ''
    prefix_rule(pattern = ["rm"], decision = "allow")
    prefix_rule(pattern = [["bash", "sh", "zsh"], ["-c", "-lc"]], decision = "allow")
  '';
  # Codex reads enforced requirements and rules only from /etc/codex.
  policyDir = pkgs.runCommand "codex-policy" { } ''
    mkdir -p $out/rules
    cp ${(pkgs.formats.toml { }).generate "requirements.toml" requirements} $out/requirements.toml
    cp ${autoApproveRules} $out/rules/auto-approve.rules
  '';

  # Codex's own sandbox needs user namespaces, which the session's forbids.
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
    # One resident model: reviews use it too.
    review_model = vcfg.model;
    # Web search is OpenAI's; subagents multiply the load on the one model.
    web_search = "disabled";
    "features.multi_agent" = false;
  };
in
{
  options.mine.ai-sandbox.codex = {
    enable = lib.mkEnableOption "Codex sessions in the AI sandbox";

    model = lib.mkOption {
      type = lib.types.str;
      default = "gpt-6-luna";
      description = "Model of the OpenAI API sessions (log in once with `codex login`).";
    };

    vllm = {
      enable = lib.mkEnableOption "the isolated L1 session on a local vLLM model behind llama-swap";
      baseUrl = lib.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:5411/v1";
        description = "llama-swap endpoint (Responses API).";
      };
      model = lib.mkOption {
        type = lib.types.str;
        description = "Served name of the vLLM model.";
      };
      contextWindow = lib.mkOption {
        type = lib.types.ints.positive;
        description = "Context window of the model (its vLLM max-model-len).";
      };
      effortLevel = lib.mkOption {
        type = lib.types.enum [
          "low"
          "medium"
          "high"
          "xhigh"
        ];
        default = "medium";
        description = "Reasoning effort; the Qwen3.8 templates accept low, medium and xhigh only.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # Mount point for the policy, which only the session units mount over it.
    environment.etc."codex/README".text = ''
      Left empty on purpose: the sandboxed Codex sessions mount their policy here.
    '';

    mine.ai-sandbox.sessions.codex = {
      title = "Codex";
      command = lib.getExe pkgs.codex;
      args = commonArgs;
      backends = {
        openai.args = [ "--model=${cfg.model}" ];
      }
      // lib.optionalAttrs vcfg.enable {
        vllm.args = [ "--model=${vcfg.model}" ] ++ vllmArgs;
      };
      slots = {
        s1.backend = "openai";
        s2.backend = "openai";
      }
      // lib.optionalAttrs vcfg.enable {
        l1 = {
          backend = "vllm";
          isolated = true;
        };
      };
      sandbox.Service.BindReadOnlyPaths = [ "${policyDir}:/etc/codex" ];
    };
  };
}
