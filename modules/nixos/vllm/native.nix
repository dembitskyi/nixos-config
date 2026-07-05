# Native backend for the unified vLLM module.
# Runs vLLM directly from nixpkgs. Emits one ExecStart per active model.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.vllm;

  mkExecStart =
    modelKey:
    let
      m = cfg.models.${modelKey};
      port = cfg.activeModels.${modelKey}.port;
      hasPlugin = cfg.enableReasoningParser && m.reasoningParserPlugin != null;
      args = lib.concatStringsSep " " (
        [
          (lib.escapeShellArg m.huggingfaceId)
          "--host ${cfg.host}"
          "--port ${toString port}"
        ]
        ++ (cfg._mkModelArgs modelKey)
        ++ lib.optional hasPlugin "--reasoning-parser-plugin ${m.reasoningParserPlugin}"
      );
    in
    pkgs.writeShellScript "vllm-native-start-${modelKey}" ''
      export HF_TOKEN=$(< ${config.sops.secrets.huggingface_token.path})
      exec ${pkgs.vllm}/bin/vllm serve ${args}
    '';
in
{
  config = lib.mkIf (cfg.enable && !cfg.useDocker) {
    environment.systemPackages = [ pkgs.vllm ];

    systemd.services = lib.listToAttrs (
      map (modelKey: {
        name = cfg._unitName modelKey;
        value.serviceConfig.ExecStart = mkExecStart modelKey;
      }) (lib.attrNames cfg.activeModels)
    );
  };
}
