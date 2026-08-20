# `vllm-sync` CLI: pre-download model weights into the shared HF cache so
# llama-swap doesn't have to fetch (and time out) on first request.
#
#   vllm-sync <model-key>            # download one model (+ its speculative draft)
#   vllm-sync all                    # download every activeModels entry
#   vllm-sync download <hf-repo-id>          # download an arbitrary HF repo not in the config
#   vllm-sync download <hf-repo-id> <name>   # download into <stateDir>/models/<name> for a localPath model
#   vllm-sync list                   # show model keys -> HF repo ids
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

  # Model key -> repos to fetch (model + speculative draft); localPath models excluded.
  syncRepos = lib.mapAttrs (
    _: m:
    [ m.huggingfaceId ]
    ++ lib.optional (
      m.speculativeConfig != null && m.speculativeConfig ? model
    ) m.speculativeConfig.model
  ) (lib.filterAttrs (_: m: m.huggingfaceId != null) cfg.models);

  reposBashLines = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (
      k: repos: "  [${lib.escapeShellArg k}]=${lib.escapeShellArg (lib.concatStringsSep " " repos)}"
    ) syncRepos
  );

  activeKeys = lib.concatStringsSep " " (
    map lib.escapeShellArg (
      lib.filter (k: cfg.models.${k}.huggingfaceId != null) (lib.attrNames cfg.activeModels)
    )
  );

  vllmSync = pkgs.writeShellScriptBin "vllm-sync" ''
    set -euo pipefail

    declare -A REPOS=(
    ${reposBashLines}
    )
    ACTIVE=(${activeKeys})

    help() {
      echo "vllm-sync — pre-download vLLM models into the shared HF cache."
      echo
      echo "  vllm-sync <model-key>            download one model (+ its speculative draft)"
      echo "  vllm-sync all                    download every activeModels entry"
      echo "  vllm-sync download <hf-repo-id> [name]  fetch an off-config repo (with name -> localPath model)"
      echo "  vllm-sync list                   show each model repo: cached size, or missing"
      echo
      echo "options:"
      echo "  -v, --verbose           verbose download logging (sets HF_DEBUG=1)"
      echo "      --no-xet            disable Xet transfer (sets HF_HUB_DISABLE_XET=1)"
      echo "  -h, --help              show this help"
    }

    verbose=0
    noxet=0
    args=()
    for a in "$@"; do
      case "$a" in
        -h | --help) help; exit 0 ;;
        -v | --verbose) verbose=1 ;;
        --no-xet) noxet=1 ;;
        -*) echo "unknown option: $a" >&2; exit 1 ;;
        *) args+=("$a") ;;
      esac
    done
    [ "''${#args[@]}" -ge 1 ] || { help; exit 1; }
    target="''${args[0]}"

    # Root needed to stat the vllm cache (list) and read the HF token; downloads run as vllm.
    [ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

    if [ "$target" = list ]; then
      hub=${cfg._stateDir}/.cache/huggingface/hub
      printf '%-22s %-46s %s\n' MODEL REPO STATUS
      {
        for k in "''${!REPOS[@]}"; do
          for repo in ''${REPOS[$k]}; do
            dir="$hub/models--''${repo//\//--}"
            if [ -d "$dir" ]; then st="$(du -sh "$dir" 2>/dev/null | cut -f1)"; else st="missing"; fi
            printf '%-22s %-46s %s\n' "$k" "$repo" "$st"
          done
        done
        for d in ${cfg._stateDir}/models/*/; do
          [ -d "$d" ] || continue
          printf '%-22s %-46s %s\n' "$(basename "$d")" "(local)" "$(du -sh "$d" 2>/dev/null | cut -f1)"
        done
      } | sort
      exit 0
    fi

    token=$(< ${config.sops.secrets.huggingface_token.path})
    hf=${pyEnv}/bin/hf
    [ -x "$hf" ] || hf=${pyEnv}/bin/huggingface-cli

    envExtra=()
    [ "$verbose" = 1 ] && envExtra+=(HF_DEBUG=1)
    [ "$noxet" = 1 ] && envExtra+=(HF_HUB_DISABLE_XET=1)

    dl_repo() {
      local repo="$1"
      echo ">> $repo"
      ${pkgs.util-linux}/bin/runuser -u vllm -- \
        env HOME=${cfg._stateDir} HF_HOME=${cfg._stateDir}/.cache/huggingface \
        HF_TOKEN="$token" HF_HUB_ENABLE_HF_TRANSFER=1 HF_HUB_VERBOSITY=info "''${envExtra[@]}" \
        "$hf" download "$repo" --exclude "metal/*" --exclude "original/*"
    }

    dl_local() {
      local repo="$1" dest="$2"
      echo ">> $repo -> $dest"
      ${pkgs.util-linux}/bin/runuser -u vllm -- \
        env HOME=${cfg._stateDir} HF_HOME=${cfg._stateDir}/.cache/huggingface \
        HF_TOKEN="$token" HF_HUB_ENABLE_HF_TRANSFER=1 HF_HUB_VERBOSITY=info "''${envExtra[@]}" \
        "$hf" download "$repo" --local-dir "$dest" --exclude "metal/*" --exclude "original/*"
    }

    sync_one() {
      local key="$1" repos="''${REPOS[$1]:-}"
      [ -n "$repos" ] || { echo "unknown model: $key (see: vllm-sync list)" >&2; exit 1; }
      for repo in $repos; do dl_repo "$repo"; done
    }

    if [ "$target" = download ]; then
      repo="''${args[1]:-}"
      name="''${args[2]:-}"
      [ -n "$repo" ] || { echo "usage: vllm-sync download <hf-repo-id> [local-name]" >&2; exit 1; }
      if [ -n "$name" ]; then
        dest=${cfg._stateDir}/models/$name
        dl_local "$repo" "$dest"
        echo "serve with:  localPath = \"$dest\";  servedName = \"$name\";"
      else
        dl_repo "$repo"
      fi
      echo "done."
      exit 0
    fi

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
