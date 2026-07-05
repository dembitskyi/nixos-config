# Unified vLLM module.
# Exposes a single mine.vllm.* option namespace and shared service plumbing.
# Backend-specific bits live in docker.nix and native.nix.
# Multi-model: one systemd unit per entry in mine.vllm.activeModels, none
# wantedBy multi-user.target — they are started on demand by llama-swap
# (see swap.nix).
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.vllm;

  defaultModels = import ./models.nix { inherit pkgs; };

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

      reasoningParserPlugin = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = ''
          Path to a custom reasoning-parser plugin .py file, loaded via vLLM's
          --reasoning-parser-plugin flag. The plugin's registered parser name
          still goes in reasoningParser. The Docker backend mounts the file
          into the container; the native backend passes the store path directly.
        '';
      };

      image = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          Per-model Docker image override (Docker backend only). Null uses
          mine.vllm.docker.image. Useful when a model requires a specific vLLM
          version.
        '';
      };
    };
  };

  activeModelType = lib.types.submodule {
    options = {
      port = lib.mkOption {
        type = lib.types.port;
        description = "Port the backend vLLM server binds to. Must be unique across activeModels.";
      };
    };
  };

  # Build the common vLLM CLI arg list for a given model key.
  mkModelArgs =
    modelKey:
    let
      m = cfg.models.${modelKey};
    in
    [
      "--served-model-name ${m.servedName}"
      "--gpu-memory-utilization ${builtins.toString m.gpuMemoryUtilization}"
      "--max-model-len ${toString m.maxModelLen}"
      "--max-num-seqs ${toString m.maxNumSeqs}"
    ]
    ++ lib.optional (m.quantization != null) "--quantization ${m.quantization}"
    ++ lib.optional (
      cfg.enableToolCalling && m.toolCallParser != null
    ) "--tool-call-parser ${m.toolCallParser} --enable-auto-tool-choice"
    ++ lib.optional (
      cfg.enableReasoningParser && m.reasoningParser != null
    ) "--reasoning-parser ${m.reasoningParser}"
    ++ lib.optional (
      m.speculativeConfig != null
    ) "--speculative-config ${lib.escapeShellArg (builtins.toJSON m.speculativeConfig)}"
    ++ m.extraArgs;

  # Unit name for the backend vLLM server for a given model key.
  unitName = modelKey: "vllm-${modelKey}";

  activeModelKeys = lib.attrNames cfg.activeModels;
  activePorts = map (k: cfg.activeModels.${k}.port) activeModelKeys;
in
{
  imports = [
    ./docker.nix
    ./native.nix
    ./swap.nix
    ./sync.nix
  ];

  options.mine.vllm = {
    enable = lib.mkEnableOption "vLLM inference server";

    useDocker = lib.mkEnableOption "run vLLM via Docker instead of the native binary";

    activeModels = lib.mkOption {
      type = lib.types.attrsOf activeModelType;
      default = { };
      description = ''
        Models to expose as on-demand backend services. Each key must exist in
        mine.vllm.models. Each entry defines the port the backend vLLM server
        binds to. One systemd unit (vllm-<key>.service) is generated per entry;
        none auto-start at boot — they are managed by llama-swap (see
        mine.vllm.swap).
      '';
      example = lib.literalExpression ''
        {
          "qwen3.5-27b-nvfp4" = { port = 5412; };
          "qwen3.6-35b-a3b"   = { port = 5413; };
        }
      '';
    };

    models = lib.mkOption {
      type = lib.types.attrsOf modelType;
      default = defaultModels;
      description = "Registry of available model configurations. Extend or override defaults.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address backend vLLM servers bind to.";
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

    # Internal: exposed so backends can build per-model arg lists.
    _mkModelArgs = lib.mkOption {
      type = lib.types.functionTo (lib.types.listOf lib.types.str);
      internal = true;
      readOnly = true;
      default = mkModelArgs;
    };

    _unitName = lib.mkOption {
      type = lib.types.functionTo lib.types.str;
      internal = true;
      readOnly = true;
      default = unitName;
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
        assertion = cfg.activeModels != { };
        message = "mine.vllm.activeModels must define at least one model.";
      }
      {
        assertion = lib.all (k: cfg.models ? ${k}) activeModelKeys;
        message = "mine.vllm.activeModels references keys missing from mine.vllm.models.";
      }
      {
        assertion = lib.length (lib.unique activePorts) == lib.length activePorts;
        message = "mine.vllm.activeModels ports must be unique.";
      }
      {
        assertion = lib.all (
          k:
          let
            m = cfg.models.${k};
          in
          m.reasoningParserPlugin == null || m.reasoningParser != null
        ) activeModelKeys;
        message = "mine.vllm: a model with reasoningParserPlugin set must also set reasoningParser (the plugin's registered parser name).";
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
      # 0755 so `vllm-sync list` can stat the (public) model cache without sudo.
      "d ${cfg._stateDir} 0755 vllm vllm -"
      "d ${cfg._stateDir}/.cache 0755 vllm vllm -"
      "d ${cfg._stateDir}/.cache/huggingface 0755 vllm vllm -"
    ];

    # Generate one shared service skeleton per active model. Backends
    # (docker.nix / native.nix) fill in ExecStart.
    systemd.services = lib.listToAttrs (
      map (modelKey: {
        name = unitName modelKey;
        value = {
          description = "vLLM OpenAI-compatible API server (${modelKey})";
          after = [ "network.target" ];
          # Intentionally NOT wantedBy multi-user.target — started on demand.
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
      }) activeModelKeys
    );
  };
}
