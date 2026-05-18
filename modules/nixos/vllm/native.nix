# Native backend for the unified vLLM module.
# Runs vLLM directly from nixpkgs.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.vllm;
  model = cfg.models.${cfg.model};

  args = lib.concatStringsSep " " (
    [
      (lib.escapeShellArg model.huggingfaceId)
      "--host ${cfg.host}"
      "--port ${toString cfg.port}"
    ]
    ++ cfg._commonArgs
  );
in
{
  config = lib.mkIf (cfg.enable && !cfg.useDocker) {
    environment.systemPackages = [ pkgs.vllm ];

    systemd.services.vllm.serviceConfig.ExecStart = pkgs.writeShellScript "vllm-native-start" ''
      export HF_TOKEN=$(< ${config.sops.secrets.huggingface_token.path})
      exec ${pkgs.vllm}/bin/vllm serve ${args}
    '';
  };
}
