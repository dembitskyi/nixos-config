# Docker backend for the unified vLLM module.
# Runs the official vLLM image under the service user's UID/GID so cache
# files are not root-owned.
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
  config = lib.mkIf (cfg.enable && cfg.useDocker) {
    virtualisation.docker.enable = true;

    users.users.vllm.extraGroups = [ "docker" ];

    systemd.services.vllm = {
      after = [ "docker.service" ];
      wants = [ "docker.socket" ];
      path = [ pkgs.docker ];

      serviceConfig.ExecStart = pkgs.writeShellScript "vllm-docker-start" ''
        HF_TOKEN=$(< ${config.sops.secrets.huggingface_token.path})

        # Run the container with the service user's UID/GID so files written
        # to the mounted cache stay owned by vllm, not root. HOME is set to
        # the same path on both sides so $HOME/.cache/huggingface is shared.
        exec docker run --rm \
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
          -e HOME="${cfg._stateDir}" \
          -e VLLM_LOG_STATS_INTERVAL=1 \
          -e HF_TOKEN="$HF_TOKEN" \
          ${cfg.docker.image} \
          ${args}
      '';
    };
  };
}
