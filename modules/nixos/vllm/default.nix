# Unified vLLM module.
# Exposes a single mine.vllm.* option namespace and shared service plumbing.
# Backend-specific bits live in docker.nix and native.nix.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.vllm;

  defaultModels = import ./models.nix;

  modelType = lib.types.submodule {
    options = {
      huggingfaceId = lib.mkOption {
        type = lib.types.str;
        description = "HuggingFace model identifier.";
      };

      servedName = lib.mkOption {
        type = lib.types.str;
        description = "Name to serve the model as via the API.";
      };

      quantization = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Quantization backend (e.g. modelopt, awq, gptq). Null to disable.";
      };

      maxModelLen = lib.mkOption {
        type = lib.types.int;
        default = 32768;
        description = "Maximum context length.";
      };

      maxNumSeqs = lib.mkOption {
        type = lib.types.int;
        default = 256;
        description = "Maximum number of concurrent sequences.";
      };

      gpuMemoryUtilization = lib.mkOption {
        type = lib.types.float;
        default = 0.90;
        description = "Fraction of GPU memory to use.";
      };

      toolCallParser = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Tool-call parser name. Null to disable.";
      };

      reasoningParser = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Reasoning parser name. Null to disable.";
      };

      speculativeConfig = lib.mkOption {
        type = lib.types.nullOr (lib.types.attrsOf lib.types.anything);
        default = null;
        description = "Speculative decoding configuration as an attrset (serialized to JSON).";
      };

      extraArgs = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Additional CLI arguments passed to vLLM.";
      };
    };
  };

  # Resolved model is guarded so an invalid key fails via the assertion,
  # not a confusing eval error in the backends.
  selectedModel = cfg.models.${cfg.model} or null;

  # Common vLLM CLI arguments shared by both backends. Backend-specific
  # arguments (positional model id, --host, --port) are appended separately.
  commonArgs =
    [
      "--served-model-name ${selectedModel.servedName}"
      "--gpu-memory-utilization ${builtins.toString selectedModel.gpuMemoryUtilization}"
      "--max-model-len ${toString selectedModel.maxModelLen}"
      "--max-num-seqs ${toString selectedModel.maxNumSeqs}"
    ]
    ++ lib.optional (selectedModel.quantization != null) "--quantization ${selectedModel.quantization}"
    ++ lib.optional (cfg.enableToolCalling && selectedModel.toolCallParser != null)
      "--tool-call-parser ${selectedModel.toolCallParser} --enable-auto-tool-choice"
    ++ lib.optional (cfg.enableReasoningParser && selectedModel.reasoningParser != null)
      "--reasoning-parser ${selectedModel.reasoningParser}"
    ++ lib.optional (selectedModel.speculativeConfig != null)
      "--speculative-config ${lib.escapeShellArg (builtins.toJSON selectedModel.speculativeConfig)}"
    ++ selectedModel.extraArgs;
in
{
  imports = [
    ./docker.nix
    ./native.nix
  ];

  options.mine.vllm = {
    enable = lib.mkEnableOption "vLLM inference server";

    useDocker = lib.mkEnableOption "run vLLM via Docker instead of the native binary";

    model = lib.mkOption {
      type = lib.types.str;
      default = "qwen3.5-27b-nvfp4";
      description = "Key into the models attrset selecting which model to serve.";
    };

    models = lib.mkOption {
      type = lib.types.attrsOf modelType;
      default = defaultModels;
      description = "Registry of available model configurations. Extend or override defaults.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address the API server binds to.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 5411;
      description = "Port for the vLLM API server.";
    };

    enableToolCalling = lib.mkEnableOption "tool calling features";

    enableReasoningParser = lib.mkEnableOption "reasoning parser";

    docker = {
      image = lib.mkOption {
        type = lib.types.str;
        default = "vllm/vllm-openai:cu130-nightly";
        description = "Docker image to use for the vLLM container.";
      };

      shmSize = lib.mkOption {
        type = lib.types.str;
        default = "16g";
        description = "Shared memory size for the container.";
      };
    };

    # Internal: shared CLI arg list, exposed so backends can compose it.
    _commonArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      internal = true;
      readOnly = true;
      default = commonArgs;
    };

    _stateDir = lib.mkOption {
      type = lib.types.path;
      internal = true;
      readOnly = true;
      default = "/var/lib/vllm";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.models ? ${cfg.model};
        message = "mine.vllm.model '${cfg.model}' is not defined in mine.vllm.models.";
      }
    ];

    sops.secrets.huggingface_token.owner = "vllm";

    users.users.vllm = {
      isSystemUser = true;
      group = "vllm";
      home = cfg._stateDir;
      createHome = true;
      description = "vLLM Service User";
    };

    users.groups.vllm = { };

    systemd.tmpfiles.rules = [
      "d ${cfg._stateDir}/.cache 0755 vllm vllm -"
      "d ${cfg._stateDir}/.cache/huggingface 0755 vllm vllm -"
    ];

    systemd.services.vllm = {
      description = "vLLM OpenAI-compatible API server";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        Type = "simple";
        User = "vllm";
        Group = "vllm";
        Restart = "on-failure";
        RestartSec = "10s";
        LimitNOFILE = "65536";
        Environment = [ "HOME=${cfg._stateDir}" ];
      };
    };
  };
}
