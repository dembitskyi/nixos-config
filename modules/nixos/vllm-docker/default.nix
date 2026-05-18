{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.vllm-docker;
  stateDir = "/var/lib/vllm-docker";
  # Docker runs as root inside the container, so the workspace is root-owned.
  dockerWorkspace = "${stateDir}/docker-workspace";
in
{
  options = {
    mine.vllm-docker = {
      enable = lib.mkEnableOption "enable vllm via Docker";

      model = lib.mkOption {
        type = lib.types.str;
        default = "osoleve/Qwen3.5-27B-NVFP4-MTP";
        description = "HuggingFace model to serve";
      };

      servedName = lib.mkOption {
        type = lib.types.str;
        default = "Qwen3.5-27B-NVFP4";
        description = "Name to serve the model as";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 5411;
        description = "Port for vllm API server";
      };

      gpuMemoryUtilization = lib.mkOption {
        type = lib.types.float;
        default = 0.70;
        description = "GPU memory utilization ratio";
      };

      maxModelLen = lib.mkOption {
        type = lib.types.int;
        default = 128000;
        description = "Maximum context length (must match opencode contextLength)";
      };

      maxNumSeqs = lib.mkOption {
        type = lib.types.int;
        default = 762;
        description = "Maximum number of sequences";
      };

      enableToolCalling = lib.mkEnableOption "enable tool calling features";

      enableReasoningParser = lib.mkEnableOption "enable reasoning parser";
    };
  };

  config = lib.mkIf cfg.enable {
    virtualisation.docker.enable = true;

    sops.secrets.huggingface_token = { };

    users.users.vllm-docker = {
      isSystemUser = true;
      group = "vllm-docker";
      extraGroups = [ "docker" ];
      home = stateDir;
      createHome = true;
      description = "vLLM Docker Service User";
    };

    users.groups.vllm-docker = { };

    systemd.tmpfiles.rules = [
      "d ${dockerWorkspace}/.cache 0755 root root -"
    ];

    systemd.services.vllm-docker = {
      description = "vLLM OpenAI-compatible API server via Docker";
      after = [
        "network.target"
        "docker.service"
      ];
      wants = [ "docker.socket" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.docker ];

      serviceConfig = {
        Type = "simple";
        User = "vllm-docker";
        Group = "vllm-docker";
        LoadCredential = "huggingface_token:${config.sops.secrets.huggingface_token.path}";

        ExecStart = pkgs.writeShellScript "vllm-docker-start" ''
          MODEL="${cfg.model}"
          SERVED_NAME="${cfg.servedName}"
          PORT=${toString cfg.port}
          HF_CACHE="${dockerWorkspace}/.cache"
          HF_TOKEN="$(< "$CREDENTIALS_DIRECTORY/huggingface_token")"

          echo "Starting vLLM Docker: $MODEL on port $PORT"

          exec docker run --rm \
            --device nvidia.com/gpu=all \
            --ipc=host \
            --shm-size=16g \
            --ulimit memlock=-1 \
            --ulimit stack=67108864 \
            --network host \
            -v "$HF_CACHE:/root/.cache/huggingface" \
            -e VLLM_LOG_STATS_INTERVAL=1 \
            -e HF_TOKEN="$HF_TOKEN" \
            -e HUGGING_FACE_HUB_TOKEN="$HF_TOKEN" \
            vllm/vllm-openai:cu130-nightly \
            "$MODEL" \
            --served-model-name "$SERVED_NAME" \
            --port "$PORT" \
            --trust-remote-code \
            --language-model-only \
            --gpu-memory-utilization ${builtins.toString cfg.gpuMemoryUtilization} \
            --max-model-len ${toString cfg.maxModelLen} \
            --max-num-seqs ${toString cfg.maxNumSeqs} \
            --quantization modelopt \
            ${lib.optionalString cfg.enableToolCalling "--tool-call-parser qwen3_coder --enable-auto-tool-choice"} \
            ${lib.optionalString cfg.enableReasoningParser "--reasoning-parser qwen3"} \
            --speculative-config '{"method":"mtp","num_speculative_tokens":1}'
        '';

        Restart = "on-failure";
        RestartSec = "10s";
        LimitNOFILE = "65536";
        Environment = [ "HOME=${stateDir}" ];
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.enable [ cfg.port ];
  };
}
