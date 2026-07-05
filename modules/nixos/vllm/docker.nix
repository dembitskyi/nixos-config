# Docker backend for the unified vLLM module.
# Runs the official vLLM image under the service user's UID/GID so cache
# files are not root-owned. Emits one ExecStart per active model.
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
      image = if m.image != null then m.image else cfg.docker.image;
      hasPlugin = cfg.enableReasoningParser && m.reasoningParserPlugin != null;
      # In-container path the reasoning-parser plugin is bind-mounted to.
      containerPluginPath = "/app/${modelKey}-reasoning-parser.py";
      args = lib.concatStringsSep " " (
        [
          (lib.escapeShellArg m.huggingfaceId)
          "--host ${cfg.host}"
          "--port ${toString port}"
        ]
        ++ (cfg._mkModelArgs modelKey)
        ++ lib.optional hasPlugin "--reasoning-parser-plugin ${containerPluginPath}"
      );
      pluginMount = lib.optionalString hasPlugin ''
        -v ${m.reasoningParserPlugin}:${containerPluginPath}:ro \
      '';
    in
    pkgs.writeShellScript "vllm-docker-start-${modelKey}" ''
      HF_TOKEN=$(< ${config.sops.secrets.huggingface_token.path})

      # Run the container with the service user's UID/GID so files written
      # to the mounted cache stay owned by vllm, not root. HOME is set to
      # the same path on both sides so $HOME/.cache/huggingface is shared.
      exec docker run --rm \
        --name ${cfg._unitName modelKey} \
        --user "$(id -u):$(id -g)" \
        --device nvidia.com/gpu=all \
        --ipc=host \
        --shm-size=${cfg.docker.shmSize} \
        --ulimit memlock=-1 \
        --ulimit stack=67108864 \
        --network host \
        -v /etc/passwd:/etc/passwd:ro \
        -v /etc/group:/etc/group:ro \
        -v "${cfg._stateDir}:${cfg._stateDir}" \
        ${pluginMount}-e HOME="${cfg._stateDir}" \
        -e VLLM_LOG_STATS_INTERVAL=1 \
        -e HF_TOKEN="$HF_TOKEN" \
        ${image} \
        ${args}
    '';
in
{
  config = lib.mkIf (cfg.enable && cfg.useDocker) {
    virtualisation.docker.enable = true;

    users.users.vllm.extraGroups = [ "docker" ];

    systemd.services = lib.listToAttrs (
      map (modelKey: {
        name = cfg._unitName modelKey;
        value = {
          after = [ "docker.service" ];
          wants = [ "docker.socket" ];
          path = [ pkgs.docker ];
          serviceConfig = {
            # Remove any leftover container with this name (e.g. from a
            # previous unit that was killed before docker --rm could clean
            # up) so the next start isn't blocked by a name conflict and
            # doesn't leak VRAM.
            ExecStartPre = pkgs.writeShellScript "vllm-docker-cleanup-${modelKey}" ''
              ${pkgs.docker}/bin/docker rm -f ${cfg._unitName modelKey} 2>/dev/null || true
            '';
            ExecStart = mkExecStart modelKey;
            # `docker run` is attached, but the container lives in dockerd's
            # cgroup — not this unit's. If vLLM wedges (e.g. after an OOM),
            # systemd only SIGKILLs the client and the container keeps holding
            # VRAM. Force-remove it on every stop so swaps/TTL/restarts always
            # reclaim VRAM, not just the next ExecStartPre.
            ExecStopPost = "-${pkgs.docker}/bin/docker rm -f ${cfg._unitName modelKey}";
            TimeoutStopSec = "30s";
          };
        };
      }) (lib.attrNames cfg.activeModels)
    );
  };
}
