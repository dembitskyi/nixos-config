{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.vllm.enable = lib.mkEnableOption "enable vllm";
  };

  config = lib.mkIf config.mine.vllm.enable {
    environment.systemPackages = with pkgs; [ vllm ];

    users.users.vllm = {
      isSystemUser = true;
      group = "vllm";
      extraGroups = [ "users" ];
      home = "/var/lib/vllm";
      createHome = true;
    };
    users.groups.vllm = { };

    sops.secrets.huggingface_token = {
      owner = "vllm";
      group = "vllm";
    };

    systemd.services.vllm = {
      description = "vLLM OpenAI-compatible API server";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        Type = "simple";
        User = "vllm";
        Group = "vllm";
        ExecStart = "${pkgs.vllm}/bin/vllm serve --host 0.0.0.0 --port 5555 RedHatAI/Qwen3.6-35B-A3B-NVFP4 --reasoning-parser qwen3";
        Restart = "on-failure";
        RestartSec = "10s";
        Environment = [
          "HOME=/var/lib/vllm"
          "HF_TOKEN_PATH=${config.sops.secrets.huggingface_token.path}"
        ];
      };
    };
  };
}
