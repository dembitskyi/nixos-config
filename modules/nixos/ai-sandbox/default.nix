{
  lib,
  config,
  pkgs,
  ...
}:
let
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  userRuntimeDir = "%t";
  sandboxSshAgentSocket = "%t/ai-sandbox-ssh-agent/socket";
  githubKnownHosts = pkgs.writeText "github_known_hosts" ''
    github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
  '';
  sshAgentPackages = with pkgs; [
    coreutils
    openssh
  ];
  sandboxSshAgentScript = pkgs.writeShellScript "ai-sandbox-ssh-agent" ''
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
  gitSshWrapper = pkgs.writeShellScriptBin "ai-sandbox-git-ssh" ''
    username="${config.variables.username}"
    uid="$(${lib.getExe' pkgs.coreutils "id"} -u "$username")"
    credentials_dir="/run/user/$uid/credentials/ai-sandbox.service"

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
  # OpenSSH ownership-check workaround for the sandbox.
  #
  # /etc/ssh/ssh_config Includes systemd's ssh-proxy drop-in from the Nix
  # store. This unit runs under the unprivileged systemd --user manager, whose
  # user namespace can only map our own uid; every other host uid (including
  # root, who owns /nix/store) is squashed to `nobody`. OpenSSH strict-checks
  # the ownership of Include'd config files and rejects any not owned by root
  # or the caller, so the now-`nobody`-owned drop-in aborts every
  # ssh/git-over-ssh call with "Bad owner or permissions". OpenSSH does not
  # ownership-check the top-level config (only its Includes), so we bind a copy
  # with that Include stripped over /etc/ssh/ssh_config. Derived from the live
  # generated config so unrelated ssh client settings keep flowing through.
  sandboxSshConfig = pkgs.writeText "ssh_config-sandbox" (
    lib.concatStringsSep "\n" (
      lib.filter (line: !(lib.hasInfix "20-systemd-ssh-proxy.conf" line)) (
        lib.splitString "\n" config.environment.etc."ssh/ssh_config".text
      )
    )
  );
  # Host-side debug helper: drops into the running AI sandbox's
  # namespaces so we can inspect exactly what the service sees (bind mounts,
  # the ProtectHome tmpfs, the stripped ssh_config).
  # nsenter joins the user namespace first; --preserve-credentials keeps our
  # euid at 1000, which owns the namespace and therefore grants the privileges
  # needed to also join the mount namespace. The service env is replayed so
  # PATH/HOME/SSH_AUTH_SOCK/CREDENTIALS_DIRECTORY match the service exactly.
  sandboxEnter = pkgs.writeShellApplication {
    name = "ai-sandbox-enter";
    runtimeInputs = with pkgs; [
      systemd
      util-linux
    ];
    text = ''
      pid="$(systemctl --user show -p MainPID --value ai-sandbox.service)"
      if [ -z "$pid" ] || [ "$pid" = "0" ]; then
        echo "ai-sandbox-enter: ai-sandbox.service is not running" >&2
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
        --wd="${userHome}/workspace" \
        -- env "''${service_env[@]}" "$@"
    '';
  };
  # `opencode serve` always requires a password. Both sandboxed servers share
  # one generated on first start (see config.nix); this client wrapper reads it.
  opencodeSandbox = pkgs.writeShellApplication {
    name = "opencode-sandbox";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.opencode
    ];
    text = ''
      OPENCODE_PASSWORD="$(cat ${configData.passwordFile})"
      export OPENCODE_PASSWORD
      exec opencode "$@"
    '';
  };
  extraPackages = with pkgs; [
    bash
    bat
    # Runtime and test runner for the TypeScript opencode plugins under
    # modules/home/opencode/plugins (bun test, bun x tsc, bun x biome).
    bun
    coreutils-full
    fd
    file
    findutils
    fzf
    gawk
    # Provides ldd for native-library diagnostics.
    glibc.bin
    gnugrep
    gnused
    hostname
    jq
    less
    man
    nix
    nodejs
    opencode
    procps
    ripgrep
    shellcheck
    sqlite
    # ai-search CLI, also used by the opencode websearch provider.
    (callPackage ../../home/opencode/ai-search.nix { })
    systemd
    tree
    uv
    which
    git
    openssh
    diffutils
    gh
    (python313.withPackages (
      ps: with ps; [
        numpy
        scipy
        sympy
        mpmath
        matplotlib
        pandas
        networkx
        seaborn
        statsmodels
        scikit-learn
        scikit-image
        control
        pint
        uncertainties
        tabulate
        shapely
        pyproj
        geopandas
        trimesh
        spatialmath-python
        pyquaternion
        transforms3d
        pymc
        emcee
        arviz
        cvxpy
        pyomo
        pulp
        casadi
        openpyxl
        python-pptx
      ]
    ))
    pandoc
    readline
    binutils
    gitSshWrapper
    gnutar
    gzip
    unzip
    curl
    wget
    # Media tooling for sandboxed opencode tasks: video/audio (ffmpeg + ffprobe),
    # images (ImageMagick magick/convert/identify), PDFs (poppler pdfinfo/pdftoppm).
    ffmpeg-headless
    imagemagick
    poppler-utils
    # Network diagnostics (ss, ip) and session helpers (setsid, script).
    iproute2
    util-linux
  ];
  telemetryOptOut = import ./telemetry.nix;
  configData = import ./config.nix {
    inherit
      lib
      pkgs
      config
      telemetryOptOut
      ;
    placeholder = config.sops.placeholder;
    proxyEnv = config.mine.ai-sandbox.proxy.enable;
    automationConfig = config.mine.ai-sandbox.automationConfig;
  };

  # Environment, hardening and binds shared by every sandboxed agent unit:
  # ai-sandbox.service (opencode + MCP servers) and the on-demand agent
  # sessions (agentSessionSandbox below).
  sandboxEnvironment = [
    "HOME=${userHome}"
    "SSH_AUTH_SOCK=${sandboxSshAgentSocket}"
    "XDG_CACHE_HOME=${userHome}/.cache"
    "XDG_DATA_HOME=${userHome}/.local/share"
    "XDG_STATE_HOME=${userHome}/.local/state"
    "UV_CACHE_DIR=${userHome}/.cache/uv"
    "UV_STATE_DIR=${userHome}/.local/state/uv"
    "UV_DATA_DIR=${userHome}/.local/share/uv"
    "PATH=${
      lib.makeBinPath (
        extraPackages
        ++ config.mine.ai-sandbox.extraPackages
        ++ lib.optional config.mine.jfrog.enable config.mine.jfrog.package
      )
    }"
  ]
  ++ lib.mapAttrsToList (name: value: "${name}=${value}") telemetryOptOut
  ++ lib.optional config.mine.ai-sandbox.offlineModelCatalog.enable "OPENCODE_DISABLE_MODELS_FETCH=1";
  sandboxHardening = {
    NoNewPrivileges = true;
    ProtectClock = true;
    PrivateDevices = true;
    PrivateMounts = true;
    PrivateTmp = false;
    ProtectHome = "tmpfs";
    StateDirectory = "ai-sandbox";
    ProtectHostname = true;
    ProtectKernelLogs = true;
    ProtectKernelModules = true;
    ProtectKernelTunables = true;
    RestrictNamespaces = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
  };
  sandboxHomeBind = "%S/ai-sandbox:${userHome}";
  sandboxSshAgentBind = "${userRuntimeDir}/ai-sandbox-ssh-agent:${userRuntimeDir}/ai-sandbox-ssh-agent";
  sandboxSshConfigBind = "${sandboxSshConfig}:/etc/ssh/ssh_config";
  # Make the declarative jf config available to sandboxed `jf`.
  sandboxJfrogBinds = lib.optional config.mine.jfrog.enable "${config.mine.jfrog.confPath}:${config.mine.jfrog.targetPath}";

  # Sandbox of the agent sessions (modules/home/ai-sessions: Claude Code,
  # Codex), transient units started on demand. They share the opencode
  # sandbox's home and hardening, but none of its workspace (each session's
  # launcher binds just the slot's own folder of it), opencode's config and
  # data dirs, MCP credentials, skills or the Hyprland socket (whose IPC can
  # exec commands outside the sandbox).
  agentSessionSandbox = {
    Unit = {
      After = [ "ai-sandbox-ssh-agent.service" ];
      Wants = [ "ai-sandbox-ssh-agent.service" ];
    };
    Service = sandboxHardening // {
      Environment = sandboxEnvironment;
      BindPaths = [
        sandboxHomeBind
        # The opencode sandbox's ssh-agent (GitHub key), for git pull/push.
        sandboxSshAgentBind
        # PrivateDevices backs /dev/ptmx with a bind mount that the kernel
        # cannot resolve to its devpts instance from a user namespace, so
        # openpty() fails with ENOENT; mount devpts' own multiplexer instead.
        "/dev/pts/ptmx:/dev/ptmx"
      ];
      BindReadOnlyPaths = [ sandboxSshConfigBind ] ++ sandboxJfrogBinds;
      # An empty ~/workspace that the launcher binds the slot's folder into;
      # read-only, so writes outside that folder fail instead of vanishing.
      TemporaryFileSystem = [ "${userHome}/workspace:ro" ];
      # Supplementary groups survive the user namespace, so docker group
      # membership still opens the root-equivalent daemon socket. The user's
      # tmux socket would likewise run commands outside the sandbox.
      InaccessiblePaths = [
        "-/run/docker.sock"
        "-/tmp/tmux-%U"
      ];
    };
  };
in
{
  imports = [ ./proxy.nix ];

  options = {
    mine.ai-sandbox = {
      enable = lib.mkEnableOption "the AI sandbox for OpenCode and MCP servers";

      ghidra.enable = lib.mkEnableOption "the headless pyghidra-mcp reverse-engineering server (pulls ghidra + a JDK into the closure)";

      offlineModelCatalog.enable = lib.mkEnableOption "the bundled OpenCode model catalog instead of fetching it from models.opencode.ai";

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
        description = "Additional MCP server definitions merged into the default server set.";
      };

      extraPackages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "Additional packages to include in the AI sandbox service PATH.";
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
  };

  config = lib.mkIf config.mine.ai-sandbox.enable {
    mine.ai-sandbox.serverUrls = configData.serverUrls;
    mine.ai-sandbox.automationConfig =
      lib.mkDefault
        config.home-manager.users.${config.variables.username}.mine.home.opencode.automationConfig;

    # The host side (the terminal client and anything started from the desktop) opts out too.
    environment.sessionVariables = telemetryOptOut;

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

    # Mount point for the Codex sessions' enforced policy (modules/home/codex):
    # Codex reads it only from /etc/codex, which the user manager cannot
    # create, and only the session units mount the policy over this.
    environment.etc."codex/README" =
      lib.mkIf config.home-manager.users.${config.variables.username}.mine.home.codex.enable
        {
          text = ''
            Left empty on purpose: the sandboxed Codex sessions mount their policy here.
          '';
        };

    home-manager.users.${config.variables.username} = {
      mine.home.opencode.mcpServerUrls = configData.defaultServerUrls;
      mine.home.ai-sessions.sandbox = agentSessionSandbox;

      home.packages = [
        sandboxEnter
        opencodeSandbox
      ];

      # Terminal clients for the sandboxed servers (:4096 interactive,
      # :4097 automation), started in ~/workspace so sessions open there.
      xdg.desktopEntries =
        lib.mapAttrs
          (_: entry: {
            inherit (entry) name;
            genericName = "OpenCode - AI coding agent";
            comment = "OpenCode client for the sandboxed server";
            exec = "tmux new-session -A -D -s ${entry.session} -c ${userHome}/workspace bash -lc \"opencode-sandbox --server ${entry.url}\"";
            terminal = true;
            icon = "utilities-terminal";
            type = "Application";
            categories = [ "Utility" ];
          })
          {
            opencode-s1 = {
              name = "opencode S1";
              session = "ocode_s1";
              url = "http://127.0.0.1:4096";
            };
            opencode-s2 = {
              name = "opencode S2";
              session = "ocode_s2";
              url = "http://127.0.0.1:4096";
            };
            opencode-a1 = {
              name = "opencode (automation)";
              session = "ocode_a1";
              url = "http://127.0.0.1:4097";
            };
          };

      systemd.user.tmpfiles.rules = [
        "d ${userHome}/.config/opencode 0700 - - -"
        "d ${userHome}/.config/opencode/skills 0700 - - -"
        "d ${userHome}/.local/share/opencode 0700 - - -"
        "d ${userHome}/workspace 0755 - - -"
      ];

      systemd.user.services.ai-sandbox-ssh-agent = {
        Unit = {
          Description = "AI Sandbox SSH Agent";
          After = [ "graphical-session.target" ];
          PartOf = [ "ai-sandbox.service" ];
        };

        Service = {
          Environment = [ "PATH=${lib.makeBinPath sshAgentPackages}" ];
          RuntimeDirectory = "ai-sandbox-ssh-agent";
          LoadCredential = [ "github_ssh_key:${config.sops.secrets."MCP/GITHUB_SSH_KEY".path}" ];
          ExecStart = "${sandboxSshAgentScript} ${sandboxSshAgentSocket}";
        };
      };

      systemd.user.services.ai-sandbox = {
        Unit = {
          Description = "AI Sandbox";
          After = [
            "graphical-session.target"
            "network.target"
            "ai-sandbox-ssh-agent.service"
          ];
          PartOf = [ "graphical-session.target" ];
          Wants = [ "ai-sandbox-ssh-agent.service" ];
        };

        Install = {
          WantedBy = [ "graphical-session.target" ];
        };
        Service = sandboxHardening // {
          Environment = sandboxEnvironment;
          BindPaths = [
            sandboxHomeBind
            sandboxSshAgentBind
            "${userHome}/.local/share/opencode:${userHome}/.local/share/opencode"
            "${userHome}/.config/opencode:${userHome}/.config/opencode"
            "${userRuntimeDir}/hypr:${userRuntimeDir}/hypr"
            # The TUI runs on the host and sends its physical working
            # directory as the session location, so the workspace has to be
            # a real directory at the same path on both sides.
            "${userHome}/workspace:${userHome}/workspace"
          ];
          BindReadOnlyPaths = [ sandboxSshConfigBind ] ++ sandboxJfrogBinds;
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
