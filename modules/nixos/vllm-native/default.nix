{
  lib,
  config,
  pkgs,
  ...
}:
let
  stateDir = "/var/lib/vllm-native";
in
{

  options = {
    mine.vllm-native.enable = lib.mkEnableOption "enable vllm native";
  };

  config = lib.mkIf config.mine.vllm-native.enable {
    environment.systemPackages = with pkgs; [ vllm ];

    users.users.vllm-native = {
      isSystemUser = true;
      group = "vllm-native";
      extraGroups = [ "users" ];
      home = stateDir;
      createHome = true;
    };
    users.groups.vllm-native = { };

    sops.secrets.huggingface_token = { };

    systemd.services.vllm-native = {
      description = "vLLM OpenAI-compatible API server (native)";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        Type = "simple";
        User = "vllm-native";
        Group = "vllm-native";
        LoadCredential = "huggingface_token:${config.sops.secrets.huggingface_token.path}";
        ExecStart = "${pkgs.vllm}/bin/vllm serve --host 0.0.0.0 --port 5555 RedHatAI/Qwen3.6-35B-A3B-NVFP4 --reasoning-parser qwen3";
        Restart = "on-failure";
        RestartSec = "10s";
        Environment = [
          "HOME=${stateDir}"
          "HF_TOKEN_PATH=%d/huggingface_token"
        ];
      };
    };
  };
}
