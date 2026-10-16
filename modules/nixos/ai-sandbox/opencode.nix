# Sandboxed opencode servers (on demand) and their terminal clients.
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
  jsonFormat = pkgs.formats.json { };

  sharedPassword = config.sops.secrets."OPENCODE/SERVER_PASSWORD".path;
  curl = lib.getExe pkgs.curl;
  homeOf = id: "${userHome}/.local/state/opencode-${id}";
  workspaceOf =
    id: server:
    if server.isolated then "${userHome}/workspace/opencode-${id}" else "${userHome}/workspace";

  serverUnits =
    id: server:
    let
      workspace = workspaceOf id server;
      url = "http://127.0.0.1:${toString (units.backendPort server.port)}";
      password =
        if server.isolated then "$HOME/.opencode-password" else "$CREDENTIALS_DIRECTORY/password";
      # An isolated server cannot reach the MCP servers with secrets.
      config' = lib.recursiveUpdate server.config (
        lib.optionalAttrs server.isolated {
          mcp.servers = lib.listToAttrs (
            map (
              name:
              lib.nameValuePair "mcp_${lib.replaceStrings [ "-" ] [ "_" ] name}" (
                cfg.mcpServers.${name} // { disabled = true; }
              )
            ) (lib.subtractLists (lib.attrNames cfg.extraServers) cfg.secretMcpServers)
          );
        }
      );
    in
    units.onDemand "opencode-${id}" {
      description = "opencode server ${id}";
      inherit (server) port;
      setup =
        (
          if server.isolated then
            ''
              if [ ! -s ~/.opencode-password ]; then
                (umask 077 && head -c 32 /dev/urandom | base64 -w0 >~/.opencode-password)
              fi
              OPENCODE_PASSWORD="$(cat ~/.opencode-password)"
            ''
          else
            ''
              OPENCODE_PASSWORD="$(cat "$CREDENTIALS_DIRECTORY/password")"
            ''
        )
        + ''
          export OPENCODE_PASSWORD
        ''
        # Ranks above every other config, project ones included.
        + lib.optionalString (config' != { }) ''
          OPENCODE_CONFIG_CONTENT="$(cat ${jsonFormat.generate "opencode-${id}.json" config'})"
          export OPENCODE_CONFIG_CONTENT
        '';
      command = "${lib.getExe pkgs.opencode} serve --hostname 127.0.0.1 --port ${toString (units.backendPort server.port)}";
      busy = ''
        ${curl} -fsS --max-time 10 -u "opencode:$(cat ${password})" ${url}/api/session/active |
          ${lib.getExe pkgs.jq} -e '.data != {}' >/dev/null
      '';
      # Routes answer 503 until /api/info does 200 (500: the start failed).
      ready = ''
        case "$(${curl} -s -o /dev/null -w '%{http_code}' --max-time 5 -u "opencode:$(cat ${password} 2>/dev/null)" ${url}/api/info)" in
          200) ;;
          500) exit 1 ;;
          *) false ;;
        esac
      '';
      unit = lib.mkMerge [
        (units.sandbox {
          home = if server.isolated then "opencode-${id}" else "ai-sandbox";
          proxy = !server.isolated;
          inherit (server) docker;
          extraPackages = lib.optional server.docker pkgs.docker-client;
        })
        {
          Service = {
            WorkingDirectory = workspace;
            Environment = [
              # For the native modules of npm plugins.
              "LD_LIBRARY_PATH=${lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}"
              "OPENCODE_DB=${server.database}"
            ];
            # Same paths as on the host, where the TUI runs.
            BindPaths = [
              "${workspace}:${workspace}"
            ]
            ++ lib.optionals (!server.isolated) (
              [ "${userHome}/.local/share/opencode:${userHome}/.local/share/opencode" ] ++ cfg.binds
            )
            ++ map (dev: "-${dev}") server.devices;
            BindReadOnlyPaths = [
              "${userHome}/.config/opencode:${userHome}/.config/opencode"
            ]
            ++ cfg.opencode.readOnlyBinds
            ++ lib.optionals (!server.isolated) (
              # The sockets of the MCP servers with secrets.
              [ "-%t/ai-sandbox-mcp:%t/ai-sandbox-mcp" ] ++ cfg.readOnlyBinds
            );
            LoadCredential = lib.optional (!server.isolated) "password:${sharedPassword}";
          }
          // lib.optionalAttrs server.isolated {
            TemporaryFileSystem = [ "${userHome}/workspace:ro" ];
          };
        }
      ];
    };

  clients = lib.concatLists (
    lib.mapAttrsToList (
      id: server: map (client: { inherit client id server; }) server.clients
    ) cfg.opencode.servers
  );

  # Isolated clients keep their history and logs in the server's home.
  clientCase =
    {
      client,
      id,
      server,
    }:
    ''
      ${client})
        url=http://127.0.0.1:${toString server.port}
        dir=${workspaceOf id server}
    ''
    + (
      if server.isolated then
        ''
          password_file=${homeOf id}/.opencode-password
          # Its server makes the password on its first start.
          unit=opencode-${id}.service
          export XDG_DATA_HOME=${homeOf id}/.local/share
          export XDG_STATE_HOME=${homeOf id}/.local/state
          export XDG_CACHE_HOME=${homeOf id}/.cache
        ''
      else
        ''
          password_file=${sharedPassword}
        ''
    )
    + ''
      ;;
    '';

  opencodeDev = pkgs.writeShellApplication {
    name = "opencode-dev";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.opencode
      pkgs.systemd
    ];
    text = ''
      unit=""
      case "''${1:-}" in
      ${lib.concatMapStrings clientCase clients}
        *)
          echo "usage: opencode-dev <${
            lib.concatMapStringsSep "|" (c: c.client) clients
          }> [opencode options]" >&2
          exit 2
          ;;
      esac
      shift
      mkdir -p "$dir"
      if [ -n "$unit" ] && [ ! -s "$password_file" ]; then
        systemctl --user start "$unit"
      fi
      case "$PWD/" in
        "$dir"/*) ;;
        *) cd "$dir" ;;
      esac
      OPENCODE_PASSWORD="$(cat "$password_file")"
      export OPENCODE_PASSWORD
      exec opencode --server "$url" "$@"
    '';
  };
in
{
  options.mine.ai-sandbox.opencode = {
    servers = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule (
          { name, ... }:
          {
            options = {
              port = lib.mkOption {
                type = lib.types.port;
                description = "Port on 127.0.0.1 whose first connection starts the server.";
              };
              isolated = lib.mkEnableOption "its own home (database, logins, logs), password and workspace folder ~/workspace/opencode-<id>; only the config is shared";
              docker = lib.mkEnableOption "the Docker daemon (root-equivalent) and CLI in the server";
              devices = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                example = [ "/dev/bus/usb" ];
                description = "Device nodes or directories bound into this server only (skipped when missing).";
              };
              clients = lib.mkOption {
                type = lib.types.listOf (lib.types.strMatching "[a-z0-9]+");
                default = [ ];
                description = "Terminal clients: desktop entries and `opencode-dev <client>`.";
              };
              config = lib.mkOption {
                inherit (jsonFormat) type;
                default = { };
                description = "Config layered over the shared one.";
              };
              database = lib.mkOption {
                type = lib.types.str;
                default = "opencode-${name}.db";
                description = "Database file in opencode's data dir.";
              };
            };
          }
        )
      );
      default = { };
      description = "opencode servers (units opencode-<id>); `main` and `automation` are predefined.";
    };

    readOnlyBinds = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Read-only binds into every opencode server: files the shared config reads.";
    };
  };

  config = lib.mkIf cfg.enable {
    mine.ai-sandbox.opencode.servers = {
      main = {
        port = lib.mkDefault 4096;
        clients = [
          "s1"
          "s2"
        ];
        database = "opencode-stable.db";
      };
      automation = {
        port = lib.mkDefault 4097;
        clients = [ "a1" ];
        config =
          lib.mkDefault
            config.home-manager.users.${config.variables.username}.mine.home.opencode.automationConfig;
      };
    };

    sops.secrets."OPENCODE/SERVER_PASSWORD" = {
      owner = config.variables.username;
      mode = "0400";
    };

    home-manager.users.${config.variables.username} = {
      home.packages = [ opencodeDev ];

      xdg.desktopEntries = lib.listToAttrs (
        map (
          { client, ... }:
          lib.nameValuePair "opencode-${client}" {
            name = "opencode ${lib.toUpper client}";
            genericName = "OpenCode - AI coding agent";
            comment = "OpenCode client for the sandboxed server";
            exec = "tmux new-session -A -D -s ocode_${client} opencode-dev ${client}";
            terminal = true;
            icon = "utilities-terminal";
            type = "Application";
            categories = [ "Utility" ];
          }
        ) clients
      );

      systemd.user = lib.mkMerge (
        lib.mapAttrsToList serverUnits cfg.opencode.servers
        ++ [
          {
            tmpfiles.rules = [
              "d ${userHome}/.config/opencode 0700 - - -"
              "d ${userHome}/.config/opencode/skills 0700 - - -"
              "d ${userHome}/.local/share/opencode 0700 - - -"
            ]
            ++ lib.mapAttrsToList (id: server: "d ${workspaceOf id server} 0755 - - -") cfg.opencode.servers;
          }
        ]
      );
    };
  };
}
