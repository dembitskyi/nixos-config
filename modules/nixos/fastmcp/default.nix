{
  lib,
  config,
  pkgs,
  ...
}:
let
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  userRuntimeDir = "%t";
  fastmcpSshAgentSocket = "%t/fastmcp-ssh-agent/socket";
  githubKnownHosts = pkgs.writeText "github_known_hosts" ''
    github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
  '';
  sshAgentPackages = with pkgs; [
    coreutils
    openssh
  ];
  fastmcpSshAgentScript = pkgs.writeShellScript "fastmcp-ssh-agent" ''
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
  gitSshWrapper = pkgs.writeShellScriptBin "fastmcp-git-ssh" ''
    username="${config.variables.username}"
    uid="$(${lib.getExe' pkgs.coreutils "id"} -u "$username")"
    credentials_dir="/run/user/$uid/credentials/fastmcp.service"

    exec ${lib.getExe pkgs.openssh} \
      -F /dev/null \
      -i "$credentials_dir/github_ssh_key" \
      -o IdentitiesOnly=yes \
      -o IdentityAgent=none \
      -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile="$credentials_dir/github_known_hosts" \
      -o GlobalKnownHostsFile=/dev/null \
      "$@"
  '';
  # Skills exposed to the opencode service. All other skills in
  # ~/.config/opencode/skills/ are hidden via a tmpfs overlay to avoid
  # inflating the permission ruleset (each skill adds a rule that gets
  # logged on every evaluate() call).
  allowedSkills = [
    "bash-pro"
    "c-pro"
    "cpp-pro"
    "hyprland"
    "nixos"
  ];
  extraPackages = with pkgs; [
    bash
    bat
    coreutils-full
    file
    findutils
    fzf
    gawk
    gnugrep
    gnused
    jq
    less
    man
    nix
    nodejs
    opencode
    procps
    ripgrep
    rtk
    systemd
    tree
    uv
    git
    openssh
    diffutils
    gh
    python313
    readline
    binutils
    gitSshWrapper
    gnutar
    gzip
    curl
    wget
  ];
  configData = import ./config.nix {
    inherit
      lib
      pkgs
      config
      ;
    placeholder = config.sops.placeholder;
    proxyEnv = config.mine.fastmcp.proxy.enable;
    automationConfig = config.mine.fastmcp.automationConfig;
  };
in
{
  imports = [ ./proxy.nix ];

  options = {
    mine.fastmcp = {
      enable = lib.mkEnableOption "enable fastmcp server";

      serverUrls = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        internal = true;
        default = { };
        description = "Computed mapping of server name to its URL. Derived from server order.";
      };

      automationConfig = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        default = { };
        description = "Extra opencode config merged into the automation instance via OPENCODE_CONFIG_CONTENT.";
      };

      extraServers = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        default = { };
        description = "Additional FastMCP server definitions merged into the default server set.";
      };

      extraPackages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "Additional packages to include in the fastmcp service PATH.";
      };

      browseruse = {
        provider = lib.mkOption {
          type = lib.types.str;
          default = "opencode";
          description = "Model provider backend used by browser-use.";
        };
        opencode.model = lib.mkOption {
          type = lib.types.str;
          default = "gpt-5.4";
          description = "Model name passed to browser-use when using the opencode backend.";
        };
        opencode.provider = lib.mkOption {
          type = lib.types.str;
          default = "github-copilot";
          description = "Provider name passed to browser-use when using the opencode backend.";
        };
      };
    };
  };

  config = lib.mkIf config.mine.fastmcp.enable {
    mine.fastmcp.serverUrls = configData.serverUrls;
    mine.fastmcp.automationConfig = lib.mkDefault (
      let
        hmCfg = config.home-manager.users.${config.variables.username}.mine.home.opencode;
      in
      lib.optionalAttrs (hmCfg.automationAgents != { }) {
        agent = hmCfg.automationAgents;
      }
    );

    sops.secrets = {
      "MCP/GITHUB_TOKEN" = {
        owner = config.variables.username;
        mode = "0400";
      };
      "MCP/GITHUB_SSH_KEY" = {
        owner = config.variables.username;
        mode = "0400";
      };
      "MCP/JIRA_URL" = { };
      "MCP/JIRA_USERNAME" = { };
      "MCP/JIRA_API_TOKEN" = { };
      "MCP/CONFLUENCE_URL" = { };
      "MCP/CONFLUENCE_USERNAME" = { };
      "MCP/CONFLUENCE_API_TOKEN" = { };
      "MCP/KAGI_API_TOKEN" = { };
    };

    sops.templates = configData.templates;

    services.nginx = {
      enable = true;
      virtualHosts."mcp.vmserver.vnet" = {
        locations."/" = {
          proxyPass = "http://127.0.0.1:8000";
          extraConfig = ''
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
          '';
        };
        locations."= /" = {
          extraConfig = ''
            return 301 $scheme://$host/docs;
          '';
        };
      };
    };

    home-manager.users.${config.variables.username} = hmArgs: {
      mine.home.opencode.mcpServerUrls = configData.defaultServerUrls;

      systemd.user.tmpfiles.rules = [
        "d ${userHome}/.config/opencode 0700 - - -"
        "d ${userHome}/.config/opencode/skills 0700 - - -"
        "d ${userHome}/.config/rtk 0700 - - -"
        "d ${userHome}/.local/share/opencode 0700 - - -"
        "d ${userHome}/.local/state/fastmcp/workspace 0755 - - -"
      ];

      home.file."workspace".source = hmArgs.config.lib.file.mkOutOfStoreSymlink "${userHome}/.local/state/fastmcp/workspace";

      systemd.user.services.fastmcp-ssh-agent = {
        Unit = {
          Description = "FastMCP SSH Agent";
          After = [ "graphical-session.target" ];
          PartOf = [ "fastmcp.service" ];
        };

        Service = {
          Environment = [ "PATH=${lib.makeBinPath sshAgentPackages}" ];
          RuntimeDirectory = "fastmcp-ssh-agent";
          LoadCredential = [ "github_ssh_key:${config.sops.secrets."MCP/GITHUB_SSH_KEY".path}" ];
          ExecStart = "${fastmcpSshAgentScript} ${fastmcpSshAgentSocket}";
        };
      };

      systemd.user.services.fastmcp = {
        Unit = {
          Description = "FastMCP Service";
          After = [
            "graphical-session.target"
            "network.target"
            "fastmcp-ssh-agent.service"
          ];
          PartOf = [ "graphical-session.target" ];
          Wants = [ "fastmcp-ssh-agent.service" ];
        };

        Install = {
          WantedBy = [ "graphical-session.target" ];
        };
        Service = {
          Environment = [
            "HOME=${userHome}"
            "SSH_AUTH_SOCK=${fastmcpSshAgentSocket}"
            "XDG_CACHE_HOME=${userHome}/.cache"
            "XDG_DATA_HOME=${userHome}/.local/share"
            "XDG_STATE_HOME=${userHome}/.local/state"
            "UV_CACHE_DIR=${userHome}/.cache/uv"
            "UV_STATE_DIR=${userHome}/.local/state/uv"
            "UV_DATA_DIR=${userHome}/.local/share/uv"
            "PATH=${lib.makeBinPath (extraPackages ++ config.mine.fastmcp.extraPackages)}"
          ];
          NoNewPrivileges = true;
          ProtectClock = true;
          PrivateDevices = true;
          PrivateMounts = true;
          PrivateTmp = false;
          ProtectHome = "tmpfs";
          StateDirectory = "fastmcp";
          BindPaths = [
            "%S/fastmcp:${userHome}"
            "${userRuntimeDir}/fastmcp-ssh-agent:${userRuntimeDir}/fastmcp-ssh-agent"
            "${userHome}/.local/share/opencode:${userHome}/.local/share/opencode"
            "${userHome}/.config/opencode:${userHome}/.config/opencode"
            "${userRuntimeDir}/hypr:${userRuntimeDir}/hypr"
          ];
          # Mount the full opencode config, then overlay an empty tmpfs on
          # skills/ to hide all 1,720 community skills, then punch through
          # only the allowed ones. systemd sorts mounts by path length, so
          # the ordering is: config dir → tmpfs overlay → individual skills.
          TemporaryFileSystem = [
            "${userHome}/.config/opencode/skills:ro"
          ];
          BindReadOnlyPaths = [
            "${userHome}/.config/rtk:${userHome}/.config/rtk"
          ]
          ++ map (
            skill: "${userHome}/.config/opencode/skills/${skill}:${userHome}/.config/opencode/skills/${skill}"
          ) allowedSkills;
          ProtectHostname = true;
          ProtectKernelLogs = true;
          ProtectKernelModules = true;
          ProtectKernelTunables = true;
          RestrictNamespaces = true;
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          LoadCredential = configData.loadConfig ++ [
            "github_ssh_key:${config.sops.secrets."MCP/GITHUB_SSH_KEY".path}"
            "github_known_hosts:${githubKnownHosts}"
          ];
          ExecStart = "${configData.execStartScript}";
        };
      };
    };
  };
}
