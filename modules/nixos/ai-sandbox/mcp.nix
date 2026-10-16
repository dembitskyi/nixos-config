# MCP servers, with exactly the access of the clients they serve. Servers
# without secrets run inside each client's sandbox (stdio), in its workspace.
# Servers with secrets run per connection in their own unit, as the shared
# opencode servers (their only clients, through a socket only they see).
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
  placeholder = config.sops.placeholder;
  fastmcp = lib.getExe' (pkgs.python313.withPackages (ps: [ ps.fastmcp ])) "fastmcp";
  uvx = lib.getExe' pkgs.uv "uvx";

  npx = package: env: {
    command = lib.getExe' pkgs.nodejs "npx";
    args = [
      "-y"
      package
    ];
    inherit env;
  };

  browseruse-conf = pkgs.writeText "browseruse.conf" ''
    {
      "browser_profile": {
        "fe352f2b-c9ab-41b5-bd14-d315cd952404": {
          "id": "fe352f2b-c9ab-41b5-bd14-d315cd952404",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268569",
          "headless": false,
          "user_data_dir": null,
          "allowed_domains": null,
          "downloads_path": null,
          "cdp_url": "http://127.0.0.1:9222"
        }
      },
      "llm": {
        "85b108a4-a573-4f6c-b739-f605553f66ce": {
          "id": "85b108a4-a573-4f6c-b739-f605553f66ce",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268580",
          "api_key": null,
          "provider": "${cfg.browseruse.provider}",
          "model": "${cfg.browseruse.opencode.model}",
          "host": null
        }
      },
      "agent": {
        "02a2dfdb-d7da-4f48-acae-2766ea324d0d": {
          "id": "02a2dfdb-d7da-4f48-acae-2766ea324d0d",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268586",
          "max_steps": null,
          "use_vision": null,
          "system_prompt": null
        }
      }
    }
  '';

  # A Ghidra project takes one user: one per working directory.
  ghidraMcp = pkgs.writeShellScript "ghidra-mcp" ''
    exec ${uvx} pyghidra-mcp --project-path "$HOME/.local/share/ghidra/''${PWD//\//_}"
  '';

  localServers = {
    context7 = npx "@upstash/context7-mcp" { };
    playwright = {
      command = lib.getExe pkgs.playwright-mcp;
      args = [
        "--cdp-endpoint=http://127.0.0.1:9222"
        # Keeps snapshots and screenshots out of the working tree.
        "--output-dir=${userHome}/.cache/playwright-mcp"
      ];
    };
  }
  // lib.optionalAttrs cfg.browseruse.enable {
    browseruse = {
      command = lib.getExe pkgs.browser-use;
      args = [ "--mcp" ];
      env = {
        BROWSER_USE_DEBUG_LOG_FILE = "/tmp/browser.log";
        BROWSER_USE_CONFIG_PATH = browseruse-conf;
        BROWSER_USE_LOGGING_LEVEL = "info";
        MODEL_PROVIDER = cfg.browseruse.provider;
        OPENCODE_MODEL = cfg.browseruse.opencode.model;
        OPENCODE_PROVIDER = cfg.browseruse.opencode.provider;
        OPENCODE_BASE_URL = "http://127.0.0.1:${toString cfg.opencode.servers.automation.port or 4097}";
        PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
      };
    };
  }
  // lib.optionalAttrs cfg.ghidra.enable {
    ghidra = {
      command = "${ghidraMcp}";
      env = {
        GHIDRA_INSTALL_DIR = "${pkgs.ghidra}/lib/ghidra";
        JAVA_HOME = "${pkgs.jdk21.home}";
        # JPype's uv-installed native extension needs the C++ runtime.
        LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
      };
    };
  };

  secretServers = {
    github = npx "@modelcontextprotocol/server-github" {
      GITHUB_PERSONAL_ACCESS_TOKEN = placeholder."MCP/GITHUB_TOKEN";
    };
    jira = {
      command = uvx;
      args = [ "mcp-atlassian" ];
      env = {
        JIRA_URL = placeholder."MCP/JIRA_URL";
        JIRA_USERNAME = placeholder."MCP/JIRA_USERNAME";
        JIRA_API_TOKEN = placeholder."MCP/JIRA_API_TOKEN";
        CONFLUENCE_URL = placeholder."MCP/CONFLUENCE_URL";
        CONFLUENCE_USERNAME = placeholder."MCP/CONFLUENCE_USERNAME";
        CONFLUENCE_API_TOKEN = placeholder."MCP/CONFLUENCE_API_TOKEN";
      };
    };
  }
  // cfg.extraServers;
  # Stateful servers run once for all clients, on demand over HTTP on
  # 127.0.0.1:8000+, which any local process can reach.
  sharedServers = lib.filterAttrs (_: s: s.shared or false) secretServers;
  sharedPorts = lib.listToAttrs (
    lib.imap0 (i: name: lib.nameValuePair name (8000 + i)) (lib.attrNames sharedServers)
  );
  perConnection = removeAttrs secretServers (lib.attrNames sharedServers);

  # The MCP client passes the server only a few variables of its own.
  withAgent = pkgs.writeShellScript "ai-sandbox-mcp-env" ''
    export SSH_AUTH_SOCK="/run/user/$(id -u)/ai-sandbox-ssh-agent/socket"
    exec "$@"
  '';

  connect = pkgs.writeShellScript "ai-sandbox-mcp-connect" ''
    exec ${lib.getExe pkgs.socat} STDIO "UNIX-CONNECT:/run/user/$(id -u)/ai-sandbox-mcp/$1.sock"
  '';

  # Native opencode entries; the servers' own env gets the telemetry opt-outs.
  entry = command: env: {
    type = "local";
    inherit command;
    environment = telemetryOptOut // env;
  };
  entries =
    lib.mapAttrs (_: s: entry ([ s.command ] ++ s.args or [ ]) (s.env or { })) localServers
    // lib.mapAttrs (
      name: _:
      entry [
        "${connect}"
        name
      ] { }
    ) perConnection
    // lib.mapAttrs (name: port: {
      type = "remote";
      url = "http://127.0.0.1:${toString port}/${name}";
      oauth = false;
    }) sharedPorts;

  # As the shared opencode servers, with the server's config (and secrets).
  secretService =
    name:
    lib.mkMerge [
      (units.sandbox { proxy = false; })
      {
        Service = {
          WorkingDirectory = "${userHome}/workspace";
          BindPaths = [ "${userHome}/workspace:${userHome}/workspace" ] ++ cfg.binds;
          BindReadOnlyPaths = cfg.readOnlyBinds;
          LoadCredential = [ "config.json:${config.sops.templates."mcp-${name}".path}" ];
        };
      }
    ];

  sharedUnits =
    name: port:
    units.onDemand "ai-sandbox-mcp-${name}" {
      description = "AI sandbox MCP server ${name}";
      inherit port;
      command = "${fastmcp} run \"$CREDENTIALS_DIRECTORY/config.json\" --no-banner -t streamable-http -p ${toString (units.backendPort port)} --path /${name}";
      unit = secretService name;
    };

  secretUnits = name: _: {
    sockets."ai-sandbox-mcp-${name}" = {
      Unit.Description = "AI sandbox MCP server ${name}";
      Socket = {
        ListenStream = "%t/ai-sandbox-mcp/${name}.sock";
        Accept = true;
        DirectoryMode = "0700";
        SocketMode = "0600";
      };
      Install.WantedBy = [ "sockets.target" ];
    };
    services."ai-sandbox-mcp-${name}@" = lib.mkMerge [
      (secretService name)
      {
        Unit = {
          Description = "AI sandbox MCP server ${name}";
          CollectMode = "inactive-or-failed";
          # A rebuild must not restart a live connection's instance.
          X-SwitchMethod = "keep-old";
        };
        Service = {
          ExecStart = "${fastmcp} run %d/config.json --no-banner";
          StandardInput = "socket";
          StandardOutput = "socket";
          StandardError = "journal";
        };
      }
    ];
  };
in
{
  options.mine.ai-sandbox = {
    ghidra.enable = lib.mkEnableOption "the headless pyghidra-mcp reverse-engineering server (pulls ghidra + a JDK into the closure)";

    mcpServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      readOnly = true;
      default = entries;
      description = "Every MCP server as a native opencode `mcp.servers` entry (stdio).";
    };

    secretMcpServers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      readOnly = true;
      internal = true;
      default = lib.attrNames perConnection;
      description = "MCP servers in units of their own, reachable from the shared opencode servers only.";
    };

    extraServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Additional MCP servers with secrets (fastmcp `mcpServers` entries), run like github and jira, or once for all clients with `shared = true` (stateful servers); hosts add them to opencode (`mcpServers`) themselves.";
    };

    browseruse = {
      enable = lib.mkEnableOption "the browser-use MCP server; the Playwright one covers browser automation without it";
      provider = lib.mkOption {
        type = lib.types.str;
        default = "opencode";
        description = "Model provider backend used by browser-use.";
      };
      opencode.model = lib.mkOption {
        type = lib.types.str;
        default = "claude-opus-4.8-fast";
        description = "Model name passed to browser-use when using the opencode backend.";
      };
      opencode.provider = lib.mkOption {
        type = lib.types.str;
        default = "github-copilot";
        description = "Provider name passed to browser-use when using the opencode backend.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    sops.secrets = {
      "MCP/GITHUB_TOKEN" = {
        owner = config.variables.username;
        mode = "0400";
      };
      "MCP/JIRA_URL" = { };
      "MCP/JIRA_USERNAME" = { };
      "MCP/JIRA_API_TOKEN" = { };
      "MCP/CONFLUENCE_URL" = { };
      "MCP/CONFLUENCE_USERNAME" = { };
      "MCP/CONFLUENCE_API_TOKEN" = { };
    };

    # fastmcp does not pass the unit's environment on.
    sops.templates = lib.mapAttrs' (
      name: server:
      lib.nameValuePair "mcp-${name}" {
        content = builtins.toJSON {
          mcpServers.${name} =
            if server ? command then
              removeAttrs server [ "shared" ]
              // {
                command = "${withAgent}";
                args = [ server.command ] ++ server.args or [ ];
                env = telemetryOptOut // server.env or { };
              }
            else
              removeAttrs server [ "shared" ];
        };
        owner = config.variables.username;
      }
    ) secretServers;

    home-manager.users.${config.variables.username} = {
      # The built-in servers; hosts add their extra ones.
      mine.home.opencode.mcpServers = lib.mapAttrs' (
        name: lib.nameValuePair "mcp_${lib.replaceStrings [ "-" ] [ "_" ] name}"
      ) (removeAttrs entries (lib.attrNames cfg.extraServers));

      systemd.user = lib.mkMerge (
        lib.mapAttrsToList secretUnits perConnection ++ lib.mapAttrsToList sharedUnits sharedPorts
      );
    };
  };
}
