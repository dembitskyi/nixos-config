{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.usage;
  prom = config.services.prometheus;
  datasource = "usage-prometheus";
  url = "${config.services.grafana.settings.server.root_url}/d/usage/usage?kiosk";

  dashboards = pkgs.runCommand "usage-dashboards" { } (
    "mkdir $out\n"
    + lib.concatStrings (
      lib.mapAttrsToList (
        name: dashboard:
        "cp ${pkgs.writeText "${name}.json" (builtins.toJSON dashboard)} $out/${name}.json\n"
      ) (import ./dashboard.nix { inherit lib datasource; })
    )
  );

  # Unit (or docker container) name and parent slice of each cgroup.
  cgroupLabels = [
    {
      source_labels = [ "id" ];
      regex = ".*/([^/]+)";
      target_label = "unit";
    }
    {
      source_labels = [ "name" ];
      regex = "(.+)";
      target_label = "unit";
      replacement = "$1 (docker)";
    }
    {
      source_labels = [ "id" ];
      regex = ".*/([^/]+)/[^/]+";
      target_label = "group";
    }
  ];

  # Splits the process-exporter group name into labels; keeps what the dashboards use.
  processLabels = [
    {
      source_labels = [ "__name__" ];
      regex = "namedprocess_namegroup_(cpu_seconds_total|memory_bytes|num_threads|read_bytes_total|write_bytes_total|oldest_start_time_seconds)";
      action = "keep";
    }
    {
      source_labels = [ "memtype" ];
      regex = "virtual|proportionalSwapped";
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
        "args"
      ]
  ++ [
    # Chromium rewrites argv[0] to the whole command line.
    {
      source_labels = [ "program" ];
      regex = "([^ ]+) .*";
      target_label = "program";
    }
    {
      source_labels = [ "cgroup" ];
      regex = ".*/([^/]+)";
      target_label = "unit";
    }
    {
      regex = "groupname";
      action = "labeldrop";
    }
  ];
in
{
  options.mine.usage = {
    enable = lib.mkEnableOption "the Usage app: CPU, memory, swap, I/O and pressure per systemd unit, docker container and process, as a Grafana dashboard in its own window";
    retention = lib.mkOption {
      type = lib.types.str;
      default = "15d";
      description = "How long Prometheus keeps the usage history.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.services.grafana.enable;
        message = "mine.usage provisions into Grafana; enable it (mine.grafana).";
      }
    ];

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
        process = {
          enable = true;
          listenAddress = "127.0.0.1";
          extraFlags = [
            "-threads=false"
            "-remove-empty-groups"
          ];
          settings.process_names = [
            {
              name = "{{.Cgroups}}|{{.PID}}|{{.Username}}|{{.ExeBase}}|{{.Matches.Args}}";
              cmdline = [ ''^\S+\s?(?P<Args>.{0,200})'' ];
            }
          ];
        };
      };
      scrapeConfigs = [
        {
          job_name = "cadvisor";
          static_configs = [ { targets = [ "127.0.0.1:${toString config.services.cadvisor.port}" ]; } ];
          metric_relabel_configs = cgroupLabels;
        }
        {
          job_name = "node";
          static_configs = [ { targets = [ "127.0.0.1:${toString prom.exporters.node.port}" ]; } ];
        }
        {
          # Reading every process's smaps takes ~1.4 s.
          job_name = "process";
          scrape_interval = "10s";
          static_configs = [ { targets = [ "127.0.0.1:${toString prom.exporters.process.port}" ]; } ];
          metric_relabel_configs = processLabels;
        }
      ];
    };

    # Other users' smaps and io are ptrace-guarded.
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

    services.grafana.provision = {
      datasources.settings.datasources = [
        {
          name = "Usage";
          type = "prometheus";
          uid = datasource;
          url = "http://127.0.0.1:${toString prom.port}";
          isDefault = false;
          jsonData.timeInterval = prom.globalConfig.scrape_interval;
        }
      ];
      dashboards.settings.providers = [
        {
          name = "usage";
          folder = "Usage";
          options.path = dashboards;
        }
      ];
    };

    home-manager.users.${config.variables.username} = hm: {
      xdg.desktopEntries.usage = {
        name = "Usage";
        genericName = "System monitor";
        comment = "CPU and memory per service and process";
        icon = "utilities-system-monitor";
        exec = "${lib.getExe hm.config.programs.chromium.package} --class=usage --user-data-dir=${hm.config.xdg.stateHome}/usage-app --no-first-run --no-default-browser-check \"--app=${url}\"";
        categories = [
          "System"
          "Monitor"
        ];
      };
    };
  };
}
