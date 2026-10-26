# The AI sandbox: opencode servers, MCP servers and agent sessions.
{
  lib,
  config,
  pkgs,
  utils,
  ...
}:
let
  cfg = config.mine.ai-sandbox;
  units = import ./units.nix { inherit lib pkgs config; };
  inherit (units) userHome telemetryOptOut;
  user = config.variables.username;
  group = config.users.users.${user}.group;

  sections =
    names:
    lib.types.submodule {
      options = lib.genAttrs names (
        _:
        lib.mkOption {
          type = lib.types.attrsOf utils.systemdUtils.unitOptions.unitOption;
          default = { };
        }
      );
    };

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

  sandboxEnter = pkgs.writeShellApplication {
    name = "ai-sandbox-enter";
    runtimeInputs = with pkgs; [
      systemd
      util-linux
    ];
    text = ''
      unit="''${1:-opencode-main.service}"
      shift || true
      pid="$(systemctl show -p MainPID --value "$unit")"
      if [ -z "$pid" ] || [ "$pid" = "0" ]; then
        echo "usage: ai-sandbox-enter [UNIT [COMMAND...]] ($unit is not running)" >&2
        exit 1
      fi

      mapfile -d "" -t service_env < "/proc/$pid/environ"

      if [ "$#" -eq 0 ]; then
        set -- bash
      fi

      exec sudo nsenter \
        --target "$pid" \
        --mount \
        --uts \
        --pid \
        --net \
        --setuid "$(id -u)" \
        --setgid "$(id -g)" \
        --wd="${userHome}" \
        -- env "''${service_env[@]}" "$@"
    '';
  };

  bindsOption =
    access:
    lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "${access} binds (`src:dst`) into the shared opencode servers, `shared` MCP servers and session slots of the shared home.";
    };
in
{
  imports = [
    ./claude.nix
    ./clipboard.nix
    ./codex.nix
    ./mcp.nix
    ./network.nix
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

    pythonPackages = lib.mkOption {
      type = lib.types.functionTo (lib.types.listOf lib.types.package);
      default = _: [ ];
      example = lib.literalExpression "ps: [ ps.requests ]";
      description = "Additional packages of the sandbox's Python.";
    };

    devices = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/dev/dri/renderD128" ];
      description = "Device nodes bound into every sandboxed unit, such as a GPU's.";
    };

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

    homes = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      internal = true;
      description = "Sandbox homes under ~/.local/state, added by the modules that use them.";
    };

    units = {
      services = lib.mkOption {
        type = lib.types.attrsOf (sections [
          "Unit"
          "Service"
          "Install"
        ]);
        default = { };
        internal = true;
      };
      sockets = lib.mkOption {
        type = lib.types.attrsOf (sections [
          "Unit"
          "Socket"
          "Install"
        ]);
        default = { };
        internal = true;
      };
    };

    userControlledUnits = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      internal = true;
    };
  };

  config = lib.mkIf cfg.enable {
    environment.sessionVariables = telemetryOptOut;

    mine.ai-sandbox.homes = [ "ai-sandbox" ];

    systemd.services =
      lib.mapAttrs (_: unit: {
        unitConfig = unit.Unit;
        serviceConfig = {
          User = lib.mkDefault user;
          Group = lib.mkDefault group;
        }
        // unit.Service;
        wantedBy = unit.Install.WantedBy or [ ];
        restartIfChanged = false;
      }) cfg.units.services
      // {
        ai-sandbox-ssh-agent = {
          description = "AI Sandbox SSH Agent";
          unitConfig.StopWhenUnneeded = true;
          path = [
            pkgs.coreutils
            pkgs.openssh
          ];
          serviceConfig = {
            User = user;
            Group = group;
            Type = "exec";
            RuntimeDirectory = "ai-sandbox-ssh-agent";
            RuntimeDirectoryPreserve = true;
            LoadCredential = [ "github_ssh_key:${config.sops.secrets."MCP/GITHUB_SSH_KEY".path}" ];
            ExecStart = "${sshAgentScript} ${units.sshAgentDir}/socket";
          };
        };
      };
    systemd.sockets = lib.mapAttrs (_: unit: {
      unitConfig = unit.Unit;
      socketConfig = unit.Socket;
      wantedBy = unit.Install.WantedBy or [ ];
    }) cfg.units.sockets;

    systemd.tmpfiles.rules = [
      "d ${userHome}/workspace 0755 ${user} ${group} -"
    ]
    ++ map (home: "d ${userHome}/.local/state/${home} 0700 ${user} ${group} -") cfg.homes;

    security.polkit.extraConfig = lib.mkIf (cfg.userControlledUnits != [ ]) ''
      polkit.addRule(function (action, subject) {
        var units = ${builtins.toJSON cfg.userControlledUnits};
        if (action.id == "org.freedesktop.systemd1.manage-units" && subject.user == "${user}" &&
            units.indexOf(action.lookup("unit")) >= 0 &&
            ["start", "stop", "restart"].indexOf(action.lookup("verb")) >= 0) {
          return polkit.Result.YES;
        }
      });
    '';

    programs.ssh.knownHosts."github.com".publicKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    sops.secrets."MCP/GITHUB_SSH_KEY" = {
      owner = config.variables.username;
      mode = "0400";
    };

    home-manager.users.${config.variables.username}.home.packages = [ sandboxEnter ];
  };
}
