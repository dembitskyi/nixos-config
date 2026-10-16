# Shared building blocks: the agent sandbox and socket-started services.
{
  lib,
  pkgs,
  config,
}:
let
  cfg = config.mine.ai-sandbox;
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  telemetryOptOut = import ./telemetry.nix;

  # ssh rejects the Include'd systemd drop-in, owned by `nobody` in the user namespace.
  sshConfig = pkgs.writeText "ssh_config-sandbox" (
    lib.concatStringsSep "\n" (
      lib.filter (line: !(lib.hasInfix "20-systemd-ssh-proxy.conf" line)) (
        lib.splitString "\n" config.environment.etc."ssh/ssh_config".text
      )
    )
  );

  packages =
    with pkgs;
    [
      bash
      bat
      bun
      coreutils-full
      fd
      file
      findutils
      fzf
      gawk
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
      gnutar
      gzip
      unzip
      curl
      wget
      ffmpeg-headless
      imagemagick
      poppler-utils
      iproute2
      util-linux
    ]
    ++ cfg.extraPackages
    ++ lib.optional config.mine.jfrog.enable config.mine.jfrog.package;

  gpuDevices = map (dev: "-${dev}") (
    [
      "/dev/nvidiactl"
      "/dev/nvidia-uvm"
      "/dev/nvidia-uvm-tools"
      "/dev/nvidia-modeset"
    ]
    ++ map (i: "/dev/nvidia${toString i}") (lib.range 0 7)
  );

  proxyUrl = "http://127.0.0.1:${toString cfg.proxy.port}";
  caBundle = "/etc/ssl/certs/ca-bundle.crt";

  sleep = lib.getExe' pkgs.coreutils "sleep";
in
{
  inherit userHome telemetryOptOut;

  backendPort = port: port + 10000;

  # Unit sections every agent unit shares, around its own home.
  sandbox =
    {
      home ? "ai-sandbox",
      extraPackages ? [ ],
      proxy ? true,
    }:
    let
      useProxy = proxy && cfg.proxy.enable;
      helpers = [ "ai-sandbox-ssh-agent.service" ] ++ lib.optional useProxy "ai-sandbox-proxy.service";
    in
    {
      Unit = {
        After = helpers;
        Wants = helpers;
      };
      Service = {
        NoNewPrivileges = true;
        ProtectClock = true;
        PrivateDevices = true;
        PrivateMounts = true;
        ProtectHome = "tmpfs";
        StateDirectory = home;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        Environment = [
          "HOME=${userHome}"
          "SSH_AUTH_SOCK=%t/ai-sandbox-ssh-agent/socket"
          "XDG_CACHE_HOME=${userHome}/.cache"
          "XDG_DATA_HOME=${userHome}/.local/share"
          "XDG_STATE_HOME=${userHome}/.local/state"
          "UV_CACHE_DIR=${userHome}/.cache/uv"
          "UV_STATE_DIR=${userHome}/.local/state/uv"
          "UV_DATA_DIR=${userHome}/.local/share/uv"
          "PATH=${lib.makeBinPath (packages ++ extraPackages)}"
        ]
        ++ lib.mapAttrsToList (name: value: "${name}=${value}") telemetryOptOut
        ++ lib.optional cfg.offlineModelCatalog.enable "OPENCODE_DISABLE_MODELS_FETCH=1"
        ++ lib.optionals useProxy [
          "HTTP_PROXY=${proxyUrl}"
          "HTTPS_PROXY=${proxyUrl}"
          "NO_PROXY=127.0.0.1,localhost"
          "NODE_EXTRA_CA_CERTS=${caBundle}"
          "CODEX_CA_CERTIFICATE=${caBundle}"
          # uv trusts only its bundled roots otherwise.
          "UV_SYSTEM_CERTS=1"
        ];
        BindPaths = [
          "%S/${home}:${userHome}"
          "%t/ai-sandbox-ssh-agent:%t/ai-sandbox-ssh-agent"
          # PrivateDevices' /dev/ptmx breaks openpty() in a user namespace.
          "/dev/pts/ptmx:/dev/ptmx"
        ]
        ++ lib.optionals cfg.gpu.enable gpuDevices;
        BindReadOnlyPaths = [
          "${sshConfig}:/etc/ssh/ssh_config"
        ]
        ++ lib.optional config.mine.jfrog.enable "${config.mine.jfrog.confPath}:${config.mine.jfrog.targetPath}"
        ++ lib.optionals useProxy [
          "%S/ai-sandbox/ca-bundle.crt:${caBundle}"
          "%S/ai-sandbox/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt"
        ];
        # Its own /tmp: no host sockets (tmux, X11) or files.
        PrivateTmp = true;
        # Docker is root through the docker group, which survives the user
        # namespace. Units get their secrets as credentials or binds.
        InaccessiblePaths = [
          "-/run/docker.sock"
          "-/run/secrets.d"
        ];
      };
    };

  # A service started by the first connection to `port` (proxied to
  # backendPort once `ready` holds) that exits after idleMinutes without one
  # while `busy` fails.
  onDemand =
    name:
    {
      description,
      port,
      setup ? "",
      command,
      busy ? "false",
      ready ? "(exec 3<>/dev/tcp/127.0.0.1/${toString (port + 10000)}) 2>/dev/null",
      unit,
    }:
    let
      backend = toString (port + 10000);
      run = pkgs.writeShellScript name ''
        ${setup}
        busy() {
          ${busy}
        }
        ${command} &
        server=$!
        trap 'kill "$server"; wait "$server"; exit 0' TERM INT
        idle=0
        while :; do
          ${sleep} 60 &
          wait -n -p finished "$server" "$!"
          status=$?
          if [ "''${finished:-}" = "$server" ]; then
            # Fails a start still waiting for readiness.
            touch /tmp/.server-exited
            exit "$status"
          fi
          if [ -n "$(${lib.getExe' pkgs.iproute2 "ss"} -Htn state established '( sport = :${backend} )')" ] || busy; then
            idle=0
          elif [ "$((idle += 1))" -ge ${toString cfg.idleMinutes} ]; then
            kill "$server"
            wait "$server"
            exit 0
          fi
        done
      '';
      readyScript = pkgs.writeShellScript "${name}-ready" ''
        ready() {
          ${ready}
        }
        until ready; do
          if [ -e /tmp/.server-exited ]; then
            exit 1
          fi
          ${sleep} 0.2
        done
      '';
    in
    {
      sockets."${name}-proxy" = {
        Unit.Description = description;
        Socket.ListenStream = "127.0.0.1:${toString port}";
        Install.WantedBy = [ "sockets.target" ];
      };
      services."${name}-proxy" = {
        Unit = {
          Description = "${description} (proxy)";
          BindsTo = [ "${name}.service" ];
          After = [ "${name}.service" ];
        };
        Service.ExecStart = "${config.systemd.package}/lib/systemd/systemd-socket-proxyd 127.0.0.1:${backend}";
      };
      services.${name} = lib.mkMerge [
        unit
        {
          Unit.Description = description;
          Service = {
            ExecStart = "${run}";
            ExecStartPost = "${readyScript}";
            TimeoutStartSec = "5min";
            # Hides its processes (and their environment) from other sandboxes.
            PrivatePIDs = true;
          };
        }
      ];
    };
}
