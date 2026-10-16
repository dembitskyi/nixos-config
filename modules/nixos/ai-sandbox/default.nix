# The AI sandbox: opencode servers, MCP servers and Claude Code / Codex
# sessions, all in units built from `sandbox` (units.nix) and started on demand.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.ai-sandbox;
  units = import ./units.nix { inherit lib pkgs config; };
  inherit (units) userHome telemetryOptOut;

  sshAgentScript = pkgs.writeShellScript "ai-sandbox-ssh-agent" ''
    set -euo pipefail

    socket_path="$1"
    rm -f "$socket_path"

    ssh-agent -D -a "$socket_path" >/dev/null &
    agent_pid="$!"

    cleanup() {
      if kill -0 "$agent_pid" 2>/dev/null; then
        kill "$agent_pid" 2>/dev/null || true
        wait "$agent_pid" 2>/dev/null || true
      fi
    }

    stop_agent() {
      cleanup
      exit 0
    }

    trap cleanup EXIT
    trap stop_agent INT TERM

    while ! [ -S "$socket_path" ]; do
      if ! kill -0 "$agent_pid" 2>/dev/null; then
        wait "$agent_pid"
      fi
    done

    SSH_AUTH_SOCK="$socket_path" ssh-add "$CREDENTIALS_DIRECTORY/github_ssh_key" >/dev/null
    wait "$agent_pid"
  '';

  # Debug helper: a shell (or command) in a running unit's namespaces.
  sandboxEnter = pkgs.writeShellApplication {
    name = "ai-sandbox-enter";
    runtimeInputs = with pkgs; [
      systemd
      util-linux
    ];
    text = ''
      unit="''${1:-opencode-main.service}"
      shift || true
      pid="$(systemctl --user show -p MainPID --value "$unit")"
      if [ -z "$pid" ] || [ "$pid" = "0" ]; then
        echo "usage: ai-sandbox-enter [UNIT [COMMAND...]] ($unit is not running)" >&2
        exit 1
      fi

      mapfile -d "" -t service_env < "/proc/$pid/environ"

      if [ "$#" -eq 0 ]; then
        set -- bash
      fi

      exec nsenter \
        --target "$pid" \
        --user \
        --preserve-credentials \
        --mount \
        --uts \
        --pid \
        --wd="${userHome}" \
        -- env "''${service_env[@]}" "$@"
    '';
  };

  bindsOption =
    access:
    lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "${access} binds (`src:dst`) into the shared opencode servers (and `shared` MCP servers).";
    };
in
{
  imports = [
    ./claude.nix
    ./clipboard.nix
    ./codex.nix
    ./mcp.nix
    ./opencode.nix
    ./proxy.nix
    ./sessions.nix
  ];

  options.mine.ai-sandbox = {
    enable = lib.mkEnableOption "the AI sandbox for OpenCode, MCP servers and agent sessions";

    offlineModelCatalog.enable = lib.mkEnableOption "the bundled OpenCode model catalog instead of fetching it from models.opencode.ai";

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Additional packages on the sandbox's PATH.";
    };

    gpu.enable = lib.mkEnableOption "the NVIDIA GPU in the sandbox";

    home = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${userHome}/.local/state/ai-sandbox";
      description = "Host path of the shared sandbox home.";
    };

    binds = bindsOption "Read-write";
    readOnlyBinds = bindsOption "Read-only";

    idleMinutes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 30;
      description = "Idle minutes before an opencode or MCP server exits.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.sessionVariables = telemetryOptOut;

    # Fresh sandbox homes (the isolated ones) know GitHub's host key.
    programs.ssh.knownHosts."github.com".publicKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    sops.secrets."MCP/GITHUB_SSH_KEY" = {
      owner = config.variables.username;
      mode = "0400";
    };

    home-manager.users.${config.variables.username} = {
      home.packages = [ sandboxEnter ];

      systemd.user.tmpfiles.rules = [ "d ${userHome}/workspace 0755 - - -" ];

      systemd.user.services.ai-sandbox-ssh-agent = {
        Unit = {
          Description = "AI Sandbox SSH Agent";
          StopWhenUnneeded = true;
        };
        Service = {
          # Started once its runtime directory, which units bind, exists.
          Type = "exec";
          Environment = [
            "PATH=${
              lib.makeBinPath [
                pkgs.coreutils
                pkgs.openssh
              ]
            }"
          ];
          RuntimeDirectory = "ai-sandbox-ssh-agent";
          # Running sessions keep the directory bound.
          RuntimeDirectoryPreserve = true;
          LoadCredential = [ "github_ssh_key:${config.sops.secrets."MCP/GITHUB_SSH_KEY".path}" ];
          ExecStart = "${sshAgentScript} %t/ai-sandbox-ssh-agent/socket";
        };
      };
    };
  };
}
