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
  dashboards = pkgs.writeTextDir "usage.json" (
    builtins.toJSON (import ./dashboard.nix { inherit lib datasource; })
  );
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
        "-housekeeping_interval=10s"
        "-enable_metrics=cpu,memory,diskIO,pressure,process,oom_event"
        "-store_container_labels=false"
      ];
    };

    services.prometheus = {
      enable = true;
      listenAddress = "127.0.0.1";
      retentionTime = cfg.retention;
      globalConfig.scrape_interval = "10s";
      exporters = {
        node = {
          enable = true;
          listenAddress = "127.0.0.1";
        };
        process = {
          enable = true;
          listenAddress = "127.0.0.1";
          extraFlags = [ "-threads=false" ];
          settings.process_names = [
            {
              name = "{{.Cgroups}}|{{.ExeBase}}|{{.Comm}}";
              cmdline = [ ".+" ];
            }
          ];
        };
      };
      scrapeConfigs =
        lib.mapAttrsToList
          (job_name: port: {
            inherit job_name;
            static_configs = [ { targets = [ "127.0.0.1:${toString port}" ]; } ];
          })
          {
            cadvisor = config.services.cadvisor.port;
            node = prom.exporters.node.port;
            process = prom.exporters.process.port;
          };
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
