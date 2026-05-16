{
  lib,
  config,
  pkgs,
  ...
}:
{
  options = {
    mine.grafana.enable = lib.mkEnableOption "enable Grafana";
  };

  config = lib.mkIf config.mine.grafana.enable {
    services.nginx = {
      enable = true;
      virtualHosts."grafana.vmserver.vnet" = {
        locations."/" = {
          proxyPass = "http://unix:${toString config.services.grafana.settings.server.socket}";
          proxyWebsockets = true;
        };
      };
    };
    systemd.services.nginx.serviceConfig.SupplementaryGroups = [ "grafana" ];

    services.grafana = {
      enable = true;
      declarativePlugins = with pkgs.grafanaPlugins; [
        grafana-piechart-panel
        grafana-worldmap-panel
      ];
      settings = {
        "auth.anonymous" = {
          enabled = true;
          org_name = "Main Org.";
          org_role = "Admin";
        };
        auth = {
          disable_login_form = true;
        };
        news.news_feed_enabled = false;
        analytics = {
          reporting_enabled = false;
          feedback_links_enabled = false;
        };
        server = {
          protocol = "socket";
          root_url = "http://grafana.vmserver.vnet";
          domain = "grafana.vmserver.vnet";
        };
        security = {
          secret_key = "SW2YcwTIb9zpOOhoPsMm";
        };
      };
      provision = {
        enable = true;
        datasources.settings.datasources = [
          {
            name = "Loki";
            type = "loki";
            url = "http://localhost:3100"; # Your Loki endpoint
          }
        ];
        dashboards.settings = {
          apiVersion = 1;
          providers = [
            {
              name = "nix provisioned";
              options.path = ./dashboards;
            }
          ];
        };
      };
    };
  };
}
