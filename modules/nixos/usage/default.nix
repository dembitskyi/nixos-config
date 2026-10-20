{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.usage;
  prom = config.services.prometheus;
  url = "http://127.0.0.1:${toString cfg.port}/";

  npm =
    name: version: hash:
    pkgs.fetchurl {
      url = "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz";
      inherit hash;
    };
  preact = npm "preact" "11.0.1" "sha256-pIoX66pcyuOXX+5C86DuMELvaNlwYLb7Aazj+pmWQF0=";
  htm = npm "htm" "3.1.1" "sha256-JCW5vuEUCRd7yrx/MuMZkm/GaQwXAcCyV8iL3/LVupA=";

  app = pkgs.runCommand "usage-app" { } ''
    cp -r ${./app} $out
    chmod u+w $out
    mkdir $out/vendor
    tar -xzf ${preact} -O package/dist/preact.mjs > $out/vendor/preact.mjs
    tar -xzf ${preact} -O package/hooks/dist/hooks.mjs > $out/vendor/hooks.mjs
    tar -xzf ${htm} -O package/dist/htm.mjs > $out/vendor/htm.mjs
  '';

  # Splits the process-exporter group name into labels; keeps what the app uses.
  processLabels = [
    {
      source_labels = [ "__name__" ];
      regex = "namedprocess_namegroup_(cpu_seconds_total|memory_bytes|num_threads|oldest_start_time_seconds)";
      action = "keep";
    }
    {
      source_labels = [ "memtype" ];
      regex = "virtual";
      action = "drop";
    }
  ]
  ++
    lib.imap1
      (i: label: {
        source_labels = [ "groupname" ];
        regex = ''\[(.*)\]\|([0-9]+)\|([^|]*)\|([^|]*)\|(.*)'';
        target_label = label;
        replacement = "$" + toString i;
      })
      [
        "cgroup"
        "pid"
        "user"
        "program"
        "comm"
      ]
  ++ [
    # Chromium rewrites argv[0] to the whole command line.
    {
      source_labels = [ "program" ];
      regex = "([^ ]+) .*";
      target_label = "program";
    }
    {
      regex = "groupname";
      action = "labeldrop";
    }
  ];
in
{
  options.mine.usage = {
    enable = lib.mkEnableOption "the Usage app: live and historical CPU, memory, swap and I/O per systemd unit, docker container and process";
    port = lib.mkOption {
      type = lib.types.port;
      default = 9340;
      description = "Localhost port that serves the Usage app.";
    };
    retention = lib.mkOption {
      type = lib.types.str;
      default = "15d";
      description = "How long Prometheus keeps the usage history.";
    };
  };

  config = lib.mkIf cfg.enable {
    services.cadvisor = {
      enable = true;
      port = 9338;
      extraOptions = [
        "-housekeeping_interval=5s"
        "-allow_dynamic_housekeeping=false"
        "-enable_metrics=cpu,memory,diskIO,pressure,process,oom_event"
        "-store_container_labels=false"
      ];
    };

    services.prometheus = {
      enable = true;
      listenAddress = "127.0.0.1";
      retentionTime = cfg.retention;
      globalConfig.scrape_interval = "5s";
      exporters = {
        node = {
          enable = true;
          listenAddress = "127.0.0.1";
        };
        # Command lines stay out: they can carry secrets and Prometheus is
        # reachable from the AI sandboxes.
        process = {
          enable = true;
          listenAddress = "127.0.0.1";
          # smaps (PSS) costs ~15% of a core every scrape; RSS comes from status.
          extraFlags = [
            "-threads=false"
            "-gather-smaps=false"
            "-remove-empty-groups"
          ];
          settings.process_names = [
            {
              name = "{{.Cgroups}}|{{.PID}}|{{.Username}}|{{.ExeBase}}|{{.Comm}}";
              cmdline = [ ".+" ];
            }
          ];
        };
      };
      scrapeConfigs = [
        {
          job_name = "cadvisor";
          static_configs = [ { targets = [ "127.0.0.1:${toString config.services.cadvisor.port}" ]; } ];
        }
        {
          job_name = "node";
          static_configs = [ { targets = [ "127.0.0.1:${toString prom.exporters.node.port}" ]; } ];
        }
        {
          job_name = "process";
          scrape_interval = "10s";
          static_configs = [ { targets = [ "127.0.0.1:${toString prom.exporters.process.port}" ]; } ];
          metric_relabel_configs = processLabels;
        }
      ];
    };

    # Other users' smaps are ptrace-guarded.
    systemd.services.prometheus-process-exporter.serviceConfig = {
      AmbientCapabilities = [
        "CAP_SYS_PTRACE"
        "CAP_DAC_READ_SEARCH"
      ];
      CapabilityBoundingSet = [
        "CAP_SYS_PTRACE"
        "CAP_DAC_READ_SEARCH"
      ];
    };

    services.nginx = {
      enable = true;
      virtualHosts.usage = {
        listen = [
          {
            addr = "127.0.0.1";
            inherit (cfg) port;
          }
        ];
        root = app;
        locations."~ ^/api/v1/(query|query_range)$" = {
          proxyPass = "http://127.0.0.1:${toString prom.port}";
          extraConfig = ''
            limit_except GET POST { deny all; }
          '';
        };
      };
    };

    # The Grafana datasource of the first version; Grafana keeps removed ones otherwise.
    services.grafana.provision.datasources.settings.deleteDatasources =
      lib.mkIf config.services.grafana.enable
        [
          {
            name = "Usage";
            orgId = 1;
          }
        ];

    home-manager.users.${config.variables.username} = hm: {
      xdg.desktopEntries.usage = {
        name = "Usage";
        genericName = "System monitor";
        comment = "CPU and memory per service and process";
        icon = "utilities-system-monitor";
        exec = "${lib.getExe hm.config.programs.chromium.package} --class=usage --user-data-dir=${hm.config.xdg.stateHome}/usage-app --no-first-run --no-default-browser-check --app=${url}";
        categories = [
          "System"
          "Monitor"
        ];
      };
    };
  };
}
