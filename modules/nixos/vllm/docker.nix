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
      # Per-model env (e.g. VLLM_PLE_CPU_OFFLOAD) as -e KEY=VALUE args.
      extraEnvArgs = lib.concatStringsSep " " (
        lib.mapAttrsToList (k: v: "-e ${lib.escapeShellArg "${k}=${v}"}") m.extraEnv
      );
      args = lib.concatStringsSep " " (
        [
          (lib.escapeShellArg (cfg._modelSource modelKey))
          "--host ${cfg.host}"
          "--port ${toString port}"
        ]
        ++ (cfg._mkModelArgs modelKey)
        ++ lib.optional hasPlugin "--reasoning-parser-plugin ${containerPluginPath}"
      );
      # Raw -v specs from extraMounts (bind-mounted patch files, ...).
      mountArgs = lib.concatStringsSep " " (map (s: "-v ${s}") m.extraMounts);
      # Tricky per-model docker flags (caps, seccomp, ...). Empty for all
      # models except the ones that opt in via extraDockerArgs.
      extraDockerArgs = lib.concatStringsSep " " m.extraDockerArgs;
      # imagePatches: extract each target from the pinned image, apply its diff,
      # bind-mount it back. Digest pin keeps the context stable; a failed apply
      # aborts the unit (set -e).
      patchBase = p: baseNameOf p.target;
      imagePatchDir = "${cfg._stateDir}/patched/${modelKey}";
      imagePatchScript = lib.optionalString (m.imagePatches != [ ]) ''
        rm -rf ${lib.escapeShellArg imagePatchDir}
        mkdir -p ${lib.escapeShellArg imagePatchDir}
        ${lib.concatMapStringsSep "\n" (p: ''
          docker run --rm --entrypoint cat ${image} ${lib.escapeShellArg p.target} \
            > ${lib.escapeShellArg "${imagePatchDir}/${patchBase p}"}
          patch --forward ${lib.escapeShellArg "${imagePatchDir}/${patchBase p}"} < ${p.patch} \
            || { echo "vllm ${modelKey}: image patch failed for ${p.target}" >&2; exit 1; }
        '') m.imagePatches}
      '';
      imagePatchMounts = lib.concatStringsSep " " (
        map (p: "-v ${imagePatchDir}/${patchBase p}:${p.target}:ro") m.imagePatches
      );
      pluginMount = lib.optionalString hasPlugin ''
        -v ${m.reasoningParserPlugin}:${containerPluginPath}:ro \
      '';
    in
    pkgs.writeShellScript "vllm-docker-start-${modelKey}" ''
      set -euo pipefail
      HF_TOKEN=$(< ${config.sops.secrets.huggingface_token.path})
      ${imagePatchScript}${
        lib.optionalString (m.preStart != "") ''
          # Per-model pre-start hook (e.g. prepare bind-mounted files).
          ${m.preStart}
        ''
      }

      # Run the container with the service user's UID/GID so files written
      # to the mounted cache stay owned by vllm, not root. HOME is set to
      # the same path on both sides so $HOME/.cache/huggingface is shared.
      # Capability and sandbox relaxations live on the model
      # (extraDockerArgs), never here — this backend stays unprivileged.
      exec docker run --rm \
        --name ${cfg._unitName modelKey} \
        --user "$(id -u):$(id -g)" \
        --device nvidia.com/gpu=all \
        --ipc=host \
        ${extraDockerArgs} \
        --shm-size=${cfg.docker.shmSize} \
        --ulimit memlock=-1 \
        --ulimit stack=67108864 \
        --network host \
        -v /etc/passwd:/etc/passwd:ro \
        -v /etc/group:/etc/group:ro \
        -v "${cfg._stateDir}:${cfg._stateDir}" \
        ${pluginMount}${mountArgs} ${imagePatchMounts} \
        -e HOME="${cfg._stateDir}" \
        -e VLLM_LOG_STATS_INTERVAL=1 \
        ${extraEnvArgs} \
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
          path = [
            pkgs.docker
            pkgs.gnupatch
          ];
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
            # vLLM teardown of large models (NCCL, engine procs) exceeds
            # 30s; shorter values SIGKILL mid-stop and fail the unit.
            TimeoutStopSec = "180s";
          };
        };
      }) (lib.attrNames cfg.activeModels)
    );
  };
}
