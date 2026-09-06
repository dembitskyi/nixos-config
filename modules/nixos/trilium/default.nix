{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.trilium;
  aiCfg = cfg.ai;

  # Trilium routes OpenAI-compatible backends (vLLM, llama.cpp-server,
  # LiteLLM) through an OpenAI-protocol provider with a custom base URL.
  # The settings live as rows in the `options` table; ETAPI exposes no
  # options endpoint, so a oneshot seeds them with the same SQL Trilium
  # itself uses. Reads go through the in-memory becca cache, so the
  # seeder restarts trilium-server, but only when a value actually
  # changed. seed.py detects the Trilium options schema at runtime
  # (0.104.x uses experimentalFeatures + llmProviders, newer releases
  # use aiSelectedProvider + per-provider rows), so one config survives
  # Trilium upgrades.
  providerTables = {
    openai = {
      baseUrl = "openaiBaseUrl";
      apiKey = "openaiApiKey";
      model = "openaiDefaultModel";
    };
    ollama = {
      baseUrl = "ollamaBaseUrl";
      apiKey = null;
      model = "ollamaDefaultModel";
    };
    anthropic = {
      baseUrl = "anthropicBaseUrl";
      apiKey = "anthropicApiKey";
      model = "anthropicDefaultModel";
    };
  };
  table = providerTables.${aiCfg.provider};

  # Trilium 0.104.x names its provider type "openai-compatible"; the newer
  # scheme reuses the nix provider name directly.
  legacyTypes = {
    openai = "openai-compatible";
    ollama = "ollama";
    anthropic = "anthropic";
  };

  # Backend facts for seed.py, serialized as JSON (always valid, no
  # templating). An empty API key is valid: Trilium treats the key as
  # optional for OpenAI-compatible endpoints without authentication; a
  # secret key arrives separately via --key-file at runtime.
  aiJson = pkgs.writeText "trilium-ai.json" (
    builtins.toJSON {
      inherit (aiCfg) providerId;
      providerType = legacyTypes.${aiCfg.provider};
      newProvider = aiCfg.provider;
      inherit (aiCfg) baseUrl model;
      apiKey = if aiCfg.apiKey != null then aiCfg.apiKey else "";
      keyFromFile = table.apiKey != null && aiCfg.apiKeyFile != null;
    }
  );
in
{

  options = {
    mine.trilium.enable = lib.mkEnableOption "enable trilium server";

    mine.trilium.ai = {
      enable = lib.mkEnableOption "Trilium AI/LLM features";

      provider = lib.mkOption {
        type = lib.types.enum [
          "openai"
          "ollama"
          "anthropic"
        ];
        default = "openai";
        description = ''
          AI provider. vLLM and other OpenAI-compatible backends
          (llama.cpp-server, LiteLLM) use "openai" with a custom baseUrl.
        '';
      };

      baseUrl = lib.mkOption {
        type = lib.types.str;
        default = "https://api.openai.com/v1";
        description = "Provider base URL. Point at llama-swap/vLLM for local inference.";
        example = "http://127.0.0.1:5411/v1";
      };

      model = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          Default model name (backend servedName for vLLM). Used by the
          newer Trilium options schema; 0.104.x defaults to the first
          model from the provider listing instead.
        '';
        example = "Qwen3.8-27B";
      };

      providerId = lib.mkOption {
        type = lib.types.str;
        default = "default";
        description = "Stable id for this backend inside the Trilium provider list.";
        example = "vllm-local";
      };

      apiKey = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          API key baked into the seeder script (visible in the Nix store).
          Only for non-sensitive or dummy keys; use apiKeyFile for real
          secrets. Null leaves the key empty, which Trilium accepts for
          keyless OpenAI-compatible endpoints.
        '';
      };

      apiKeyFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "Path to a file containing the API key, read at runtime via LoadCredential.";
      };
    };
  };

  config = lib.mkMerge [
    (lib.mkIf cfg.enable {
      services.trilium-server = {
        enable = true;
        package = pkgs.trilium-next-server;
        host = "127.0.0.1";
        port = config.variables.trilium-port;
        dataDir = "/persistent/var/lib/trilium";
        nginx = {
          enable = true;
          hostName = "notes.vmserver.vnet";
        };
      };
    })

    (lib.mkIf (cfg.enable && aiCfg.enable) {
      assertions = [
        {
          assertion = aiCfg.apiKey == null || aiCfg.apiKeyFile == null;
          message = "mine.trilium.ai: set at most one of apiKey and apiKeyFile.";
        }
        {
          assertion = aiCfg.model != "";
          message = "mine.trilium.ai: model must name the default model (servedName for vLLM).";
        }
        {
          assertion = table.apiKey != null || (aiCfg.apiKey == null && aiCfg.apiKeyFile == null);
          message = "mine.trilium.ai: the ollama provider takes no API key.";
        }
      ];

      # Least-privilege restart for the seeder: the trilium user may
      # restart only trilium-server.service, mirroring the llama-swap
      # polkit rule for vllm-*.service in ../vllm/swap.nix.
      security.polkit.extraConfig = ''
        polkit.addRule(function(action, subject) {
          if (action.id == "org.freedesktop.systemd1.manage-units" &&
              subject.user == "trilium" &&
              action.lookup("unit") == "trilium-server.service" &&
              action.lookup("verb") == "restart") {
            return polkit.Result.YES;
          }
        });
      '';

      systemd.services.trilium-ai-config = {
        description = "Seed Trilium AI/LLM provider options";
        after = [ "trilium-server.service" ];
        wants = [ "trilium-server.service" ];
        wantedBy = [ "multi-user.target" ];
        path = [ pkgs.systemd ];
        serviceConfig = {
          Type = "oneshot";
          User = "trilium";
          Group = "trilium";
          LoadCredential = lib.optional (aiCfg.apiKeyFile != null) "ai-api-key:${aiCfg.apiKeyFile}";
        };
        script =
          "${pkgs.python3}/bin/python3 ${./seed.py}"
          + " --db ${lib.escapeShellArg "${config.services.trilium-server.dataDir}/document.db"}"
          + " --config ${aiJson}"
          + lib.optionalString (aiCfg.apiKeyFile != null) " --key-file \"$CREDENTIALS_DIRECTORY/ai-api-key\"";
      };
    })
  ];
}
