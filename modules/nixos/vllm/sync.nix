# `vllm-sync` CLI: pre-download model weights into the shared HF cache so
# llama-swap doesn't have to fetch (and time out) on first request.
#
#   vllm-sync <model-key>   # download one model (+ its speculative draft)
#   vllm-sync all           # download every activeModels entry
#   vllm-sync list          # show model keys -> HF repo ids
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.vllm;

  # hf-transfer is the Rust fast-path downloader — a big speedup for the 60-130 GB models.
  pyEnv = pkgs.python3.withPackages (ps: [
    ps.huggingface-hub
    ps.hf-transfer
  ]);

  # Model key -> repos to fetch: the model plus any Eagle/speculative draft repo.
  syncRepos = lib.mapAttrs (
    _: m:
    [ m.huggingfaceId ]
    ++ lib.optional (
      m.speculativeConfig != null && m.speculativeConfig ? model
    ) m.speculativeConfig.model
  ) cfg.models;

  reposBashLines = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (
      k: repos: "  [${lib.escapeShellArg k}]=${lib.escapeShellArg (lib.concatStringsSep " " repos)}"
    ) syncRepos
  );

  activeKeys = lib.concatStringsSep " " (map lib.escapeShellArg (lib.attrNames cfg.activeModels));

  vllmSync = pkgs.writeShellScriptBin "vllm-sync" ''
    set -euo pipefail

    declare -A REPOS=(
    ${reposBashLines}
    )
    ACTIVE=(${activeKeys})

    help() {
      echo "vllm-sync — pre-download vLLM models into the shared HF cache."
      echo
      echo "  vllm-sync <model-key>   download one model (+ its speculative draft)"
      echo "  vllm-sync all           download every activeModels entry"
      echo "  vllm-sync list          show each model repo: cached size, or missing"
      echo
      echo "options:"
      echo "  -v, --verbose           verbose download logging (sets HF_DEBUG=1)"
      echo "      --no-xet            disable Xet transfer (sets HF_HUB_DISABLE_XET=1)"
      echo "  -h, --help              show this help"
    }

    verbose=0
    noxet=0
    target=""
    for a in "$@"; do
      case "$a" in
        -h | --help) help; exit 0 ;;
        -v | --verbose) verbose=1 ;;
        --no-xet) noxet=1 ;;
        -*) echo "unknown option: $a" >&2; exit 1 ;;
        *) [ -z "$target" ] && target="$a" || { echo "too many arguments" >&2; exit 1; } ;;
      esac
    done
    [ -n "$target" ] || { help; exit 1; }

    if [ "$target" = list ]; then
      hub=${cfg._stateDir}/.cache/huggingface/hub
      printf '%-22s %-46s %s\n' MODEL REPO STATUS
      for k in "''${!REPOS[@]}"; do
        for repo in ''${REPOS[$k]}; do
          dir="$hub/models--''${repo//\//--}"
          if [ -d "$dir" ]; then st="$(du -sh "$dir" 2>/dev/null | cut -f1)"; else st="missing"; fi
          printf '%-22s %-46s %s\n' "$k" "$repo" "$st"
        done
      done | sort
      exit 0
    fi

    # Root is needed to read the vllm-owned HF token and write the vllm cache;
    # the actual download runs as vllm so the cache stays vllm-owned.
    [ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
    token=$(< ${config.sops.secrets.huggingface_token.path})
    hf=${pyEnv}/bin/hf
    [ -x "$hf" ] || hf=${pyEnv}/bin/huggingface-cli

    envExtra=()
    [ "$verbose" = 1 ] && envExtra+=(HF_DEBUG=1)
    [ "$noxet" = 1 ] && envExtra+=(HF_HUB_DISABLE_XET=1)

    sync_one() {
      local key="$1" repos="''${REPOS[$1]:-}"
      [ -n "$repos" ] || { echo "unknown model: $key (see: vllm-sync list)" >&2; exit 1; }
      for repo in $repos; do
        echo ">> $key: $repo"
        ${pkgs.util-linux}/bin/runuser -u vllm -- \
          env HOME=${cfg._stateDir} HF_HOME=${cfg._stateDir}/.cache/huggingface \
          HF_TOKEN="$token" HF_HUB_ENABLE_HF_TRANSFER=1 HF_HUB_VERBOSITY=info "''${envExtra[@]}" \
          "$hf" download "$repo" --exclude "metal/*" --exclude "original/*"
      done
    }

    if [ "$target" = all ]; then
      for k in "''${ACTIVE[@]}"; do sync_one "$k"; done
    else
      sync_one "$target"
    fi
    echo "done."
  '';
in
{
  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ vllmSync ];
  };
}
