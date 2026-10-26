# Shared building blocks of the sandbox's units.
{
  lib,
  pkgs,
  config,
}:
let
  cfg = config.mine.ai-sandbox;
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  telemetryOptOut = import ./telemetry.nix;

  netns = "/run/netns/ai-sandbox";
  network = "ai-sandbox-network.service";
  resolvConf = pkgs.writeText "ai-sandbox-resolv.conf" (
    lib.concatMapStrings (server: "nameserver ${server}\n") cfg.network.nameservers
  );
  sshAgentDir = "/run/ai-sandbox-ssh-agent";

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
      (python3.withPackages (
        ps:
        with ps;
        [
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
          emcee
          arviz
          pyomo
          pulp
          openpyxl
          python-pptx
        ]
        ++ cfg.pythonPackages ps
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

  proxyUrl = "http://127.0.0.1:${toString cfg.proxy.port}";
  caBundle = "/etc/ssl/certs/ca-bundle.crt";

  sleep = lib.getExe' pkgs.coreutils "sleep";
in
{
  inherit
    userHome
    telemetryOptOut
    netns
    network
    sshAgentDir
    ;

  backendPort = port: port + 10000;

  portOf =
    url:
    lib.toInt (
      lib.last (lib.splitString ":" (lib.head (lib.splitString "/" (lib.removePrefix "http://" url))))
    );

  sandbox =
    {
      home ? "ai-sandbox",
      extraPackages ? [ ],
      proxy ? true,
      docker ? false,
    }:
    let
      useProxy = proxy && cfg.proxy.enable;
      helpers = [ "ai-sandbox-ssh-agent.service" ] ++ lib.optional useProxy "ai-sandbox-proxy.service";
    in
    {
      Unit = {
        After = helpers ++ [ network ];
        Wants = helpers;
        BindsTo = [ network ];
      };
      Service = {
        NetworkNamespacePath = netns;
        NoNewPrivileges = true;
        ProtectClock = true;
        PrivateDevices = true;
        PrivateMounts = true;
        ProtectHome = "tmpfs";
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        Environment = [
          "HOME=${userHome}"
          "SSH_AUTH_SOCK=${sshAgentDir}/socket"
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
          "UV_SYSTEM_CERTS=1"
        ];
        BindPaths = [
          "${userHome}/.local/state/${home}:${userHome}"
          "${sshAgentDir}:${sshAgentDir}"
          "/dev/pts/ptmx:/dev/ptmx"
        ]
        ++ map (dev: "-${dev}") cfg.devices;
        BindReadOnlyPaths = [
          "${resolvConf}:/etc/resolv.conf"
        ]
        ++ lib.optional config.mine.jfrog.enable "${config.mine.jfrog.confPath}:${config.mine.jfrog.targetPath}"
        ++ lib.optionals useProxy [
          "${cfg.home}/ca-bundle.crt:${caBundle}"
          "${cfg.home}/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt"
        ];
        PrivateTmp = true;
        TemporaryFileSystem = [ "/run/ai-sandbox-sessions:ro" ];
        InaccessiblePaths = lib.optional (!docker) "-/run/docker.sock" ++ [ "-/run/secrets.d" ];
      };
    };

  # A service started by its socket, stopped when idle.
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
      sockets."${name}-proxy-sandbox" = {
        Unit = {
          Description = "${description} (in the sandbox)";
          After = [ network ];
          BindsTo = [ network ];
        };
        Socket = {
          ListenStream = "127.0.0.1:${toString port}";
          NetworkNamespacePath = netns;
          Service = "${name}-proxy.service";
        };
        Install.WantedBy = [ "sockets.target" ];
      };
      services."${name}-proxy" = {
        Unit = {
          Description = "${description} (proxy)";
          BindsTo = [
            "${name}.service"
            network
          ];
          After = [
            "${name}.service"
            network
          ];
        };
        Service = {
          ExecStart = "${config.systemd.package}/lib/systemd/systemd-socket-proxyd 127.0.0.1:${backend}";
          Sockets = [
            "${name}-proxy.socket"
            "${name}-proxy-sandbox.socket"
          ];
          NetworkNamespacePath = netns;
        };
      };
      services.${name} = lib.mkMerge [
        unit
        {
          Unit.Description = description;
          Service = {
            ExecStart = "${run}";
            ExecStartPost = "${readyScript}";
            TimeoutStartSec = "5min";
            PrivatePIDs = true;
          };
        }
      ];
    };
}
