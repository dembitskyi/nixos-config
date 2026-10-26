# Interactive agent sessions (Claude Code, Codex).
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.ai-sandbox;
  units = import ./units.nix { inherit lib pkgs config; };
  inherit (units) userHome;

  wlPaste = pkgs.writeShellApplication {
    name = "wl-paste";
    runtimeInputs = with pkgs; [
      coreutils
      socat
    ];
    text = ''
      request=""
      case "$#:''${1:-}" in
        1:-l | 1:--list-types) request=list ;;
        2:-t | 2:--type)
          case "$2" in
            image/*) request="get $2" ;;
          esac
          ;;
      esac
      if [ -z "$request" ]; then
        echo "wl-paste: the AI sandbox only lists and pastes clipboard images (-l, --type image/...)." >&2
        exit 1
      fi

      answer="$(mktemp)"
      trap 'rm -f "$answer"' EXIT
      printf '%s\n' "$request" |
        socat -t 30 - "UNIX-CONNECT:/run/ai-sandbox-clipboard/socket" >"$answer"
      if [ ! -s "$answer" ]; then
        exit 1
      fi
      cat "$answer"
    '';
  };
  dtach = lib.getExe pkgs.dtach;
  runOf = name: id: "/run/ai-sandbox-sessions/${name}-${id}";

  workspaceOf =
    name: id: slot:
    "${userHome}/workspace/${name}-${if slot.folder == null then id else slot.folder}";
  slotDirsOf =
    _name: session: id: slot:
    lib.optionals (!slot.isolated) (map (dir: "${cfg.home}/${dir}/${id}") session.slotDirs);

  unitOf =
    name: session: id: slot:
    let
      workspace = workspaceOf name id slot;
      run = runOf name id;
    in
    lib.mkMerge [
      (units.sandbox {
        home = if slot.isolated then "${name}-${id}" else "ai-sandbox";
        proxy = !slot.isolated;
        extraPackages = lib.optional cfg.clipboard.enable wlPaste;
      })
      {
        Unit.Description = "${session.title} (${id})";
        Service = {
          Type = "exec";
          ExecStart = lib.getExe (entry name session);
          EnvironmentFile = "-${run}/env";
          Environment = [
            "AI_SESSION_SANDBOX=1"
            "AI_SESSION_RUN=${run}"
          ];
          TemporaryFileSystem = [ "${userHome}/workspace:ro" ];
          BindPaths = [
            "${workspace}:${workspace}"
            "${run}:${run}"
          ]
          ++ lib.zipListsWith (src: dir: "${src}:${userHome}/${dir}") (slotDirsOf name session id
            slot
          ) session.slotDirs
          ++ lib.optionals (!slot.isolated) cfg.binds;
          BindReadOnlyPaths =
            lib.optional cfg.clipboard.enable "-/run/ai-sandbox-clipboard:/run/ai-sandbox-clipboard"
            ++ lib.optionals (!slot.isolated) cfg.readOnlyBinds;
          PrivatePIDs = true;
        };
      }
      session.sandbox
    ];

  exports =
    env: lib.mapAttrsToList (key: value: "export ${key}=${lib.escapeShellArg (toString value)}") env;

  entry =
    name: session:
    pkgs.writeShellApplication {
      name = "${name}-sandbox-entry";
      text = ''
        if [ "''${AI_SESSION_SANDBOX:-}" != 1 ] || [ -e "/run/user/$(${lib.getExe' pkgs.coreutils "id"} -u)/bus" ]; then
          echo "${name}-sandbox: the session sandbox is not active." >&2
          exit 1
        fi
        mapfile -d "" -t start <"$AI_SESSION_RUN/start"
        cd "''${start[0]}"
        backend="''${start[1]}"
        set -- "''${start[@]:2}"
        ${lib.concatLines (exports session.env)}
        status=0
        case "$backend" in
        ${lib.concatStrings (
          lib.mapAttrsToList (backend: b: ''
            ${backend})
              ${lib.concatLines (exports b.env)}
              ${dtach} -N "$AI_SESSION_RUN/tty" -E -z -r winch ${
                lib.escapeShellArgs ([ session.command ] ++ b.args ++ session.args)
              } "$@" || status=$?
              ;;
          '') session.backends
        )}
        esac
        exit "$status"
      '';
    };

  launcher =
    name: session:
    pkgs.writeShellApplication {
      name = "${name}-sandbox";
      runtimeInputs = [
        pkgs.coreutils
        pkgs.findutils
        pkgs.systemd
      ];
      text = ''
        own=()
        case "''${1:-}" in
        ${lib.concatStrings (
          lib.mapAttrsToList (id: slot: ''
            ${id})
              backend=${slot.backend}
              workspace=${workspaceOf name id slot}
              own=(${toString (slotDirsOf name session id slot)})
              ;;
          '') session.slots
        )}
          *)
            echo "usage: ${name}-sandbox <${lib.concatStringsSep "|" (lib.attrNames session.slots)}> [${session.title} options]" >&2
            exit 2
            ;;
        esac
        slot="$1"
        shift
        unit="${name}-sandbox-$slot.service"
        run="/run/ai-sandbox-sessions/${name}-$slot"
        if systemctl --quiet is-active "$unit"; then
          echo "${name}-sandbox: $unit is already running; attach to its tmux session or run 'systemctl stop $unit'." >&2
          exit 1
        fi

        for dir in "''${own[@]}"; do
          mkdir -p "$dir"
          find "$dir" -mindepth 1 -delete
        done
        mkdir -p "$workspace"
        case "$PWD/" in
          "$workspace"/*) dir="$PWD" ;;
          *) dir="$workspace" ;;
        esac

        printf '%s\0' "$dir" "$backend" "$@" >"$run/start"
        : >"$run/env"
        for var in LANG LC_ALL TERM COLORTERM; do
          if [ -n "''${!var:-}" ]; then
            printf '%s=%s\n' "$var" "''${!var}" >>"$run/env"
          fi
        done
        rm -f "$run/tty"

        trap 'systemctl stop "$unit" 2>/dev/null || true' EXIT
        trap 'exit 129' HUP
        trap 'exit 143' TERM

        systemctl start "$unit"
        until [ -S "$run/tty" ]; do
          if ! systemctl --quiet is-active "$unit"; then
            echo "${name}-sandbox: $unit stopped; see journalctl -u $unit." >&2
            exit 1
          fi
          sleep 0.1
        done
        ${dtach} -a "$run/tty" -E -z -r winch
      '';
    };

  slotList =
    f:
    lib.filter (x: x != "") (
      lib.concatLists (
        lib.mapAttrsToList (name: session: lib.mapAttrsToList (f name) session.slots) cfg.sessions
      )
    );

  envType = lib.types.attrsOf (lib.types.either lib.types.str lib.types.int);
in
{
  options.mine.ai-sandbox = {
    sessions = lib.mkOption {
      default = { };
      description = "Interactive agent sessions, each with a `<name>-sandbox` launcher.";
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            title = lib.mkOption {
              type = lib.types.str;
              description = "Name in desktop entries and unit descriptions.";
            };
            command = lib.mkOption {
              type = lib.types.str;
              description = "The agent's executable.";
            };
            env = lib.mkOption {
              type = envType;
              default = { };
              description = "Environment of every backend.";
            };
            args = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Arguments of every backend, after the backend's own.";
            };
            backends = lib.mkOption {
              description = "Backends a slot can use.";
              type = lib.types.attrsOf (
                lib.types.submodule {
                  options = {
                    env = lib.mkOption {
                      type = envType;
                      default = { };
                    };
                    args = lib.mkOption {
                      type = lib.types.listOf lib.types.str;
                      default = [ ];
                    };
                  };
                }
              );
            };
            slots = lib.mkOption {
              default = { };
              description = "Slots: a desktop entry each (tmux session <name>_<slot>).";
              type = lib.types.attrsOf (
                lib.types.submodule {
                  options = {
                    backend = lib.mkOption { type = lib.types.str; };
                    folder = lib.mkOption {
                      type = lib.types.nullOr (lib.types.strMatching "[A-Za-z0-9_]+");
                      default = null;
                      description = "Workspace folder ~/workspace/<name>-<folder> (default: the slot's own). Slots may share one.";
                    };
                    isolated = lib.mkEnableOption "its own home (~/.local/state/<name>-<slot>) instead of the shared one, with its login and history";
                  };
                }
              );
            };
            slotDirs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Home dirs each slot of the shared home keeps to itself (emptied at start).";
            };
            sandbox = lib.mkOption {
              type = lib.types.attrsOf (lib.types.attrsOf lib.types.anything);
              default = { };
              description = "Extra unit sections of every slot.";
            };
          };
        }
      );
    };

    launchers = lib.mkOption {
      type = lib.types.attrsOf lib.types.package;
      readOnly = true;
      default = lib.mapAttrs launcher cfg.sessions;
      description = "Each session's launcher, for services that start slots themselves.";
    };
  };

  config = lib.mkIf (cfg.sessions != { }) {
    assertions = [
      {
        assertion = cfg.enable;
        message = "Agent sessions (mine.ai-sandbox.sessions) need mine.ai-sandbox.enable.";
      }
    ]
    ++ lib.concatLists (
      lib.mapAttrsToList (
        name: session:
        lib.mapAttrsToList (id: slot: {
          assertion = session.backends ? ${slot.backend};
          message = "${name} slot ${id}: no backend ${slot.backend}.";
        }) session.slots
      ) cfg.sessions
    );

    mine.ai-sandbox = {
      units.services = lib.concatMapAttrs (
        name: session:
        lib.mapAttrs' (
          id: slot: lib.nameValuePair "${name}-sandbox-${id}" (unitOf name session id slot)
        ) session.slots
      ) cfg.sessions;
      userControlledUnits = slotList (
        name: id: _:
        "${name}-sandbox-${id}.service"
      );
      homes = slotList (
        name: id: slot:
        lib.optionalString slot.isolated "${name}-${id}"
      );
    };

    systemd.tmpfiles.rules = [
      "d /run/ai-sandbox-sessions 0755 root root -"
    ]
    ++ slotList (
      name: id: _:
      "d ${runOf name id} 0700 ${config.variables.username} ${
        config.users.users.${config.variables.username}.group
      } -"
    );

    home-manager.users.${config.variables.username} = {
      home.packages = lib.attrValues cfg.launchers;

      xdg.desktopEntries = lib.concatMapAttrs (
        name: session:
        lib.mapAttrs' (
          id: slot:
          lib.nameValuePair "${name}-${id}" {
            name = "${session.title} ${lib.toUpper id}";
            genericName = "${session.title} - AI coding agent";
            comment = "Sandboxed ${session.title} (${slot.backend})";
            exec = "tmux new-session -A -D -s ${name}_${id} ${name}-sandbox ${id}";
            terminal = true;
            icon = "utilities-terminal";
            type = "Application";
            categories = [ "Utility" ];
          }
        ) session.slots
      ) cfg.sessions;
    };
  };
}
