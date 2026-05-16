{
  lib,
  config,
  ...
}:
{
  options = {
    mine.loki.enable = lib.mkEnableOption "enable loki";
  };

  config = lib.mkIf config.mine.loki.enable {
    services.loki = {
      enable = true;
      dataDir = "/var/lib/loki";
      configuration = {
        auth_enabled = false; # Disable for local/single-node
        server = {
          http_listen_port = 3100;
        };
        analytics = {
          reporting_enabled = false;
        };
        ingester = {
          lifecycler = {
            address = "127.0.0.1";
            ring = {
              kvstore = {
                store = "inmemory";
              };
              replication_factor = 1;
            };
          };
          chunk_idle_period = "1h";
          max_chunk_age = "1h";
          chunk_target_size = 999999;
          chunk_retain_period = "30s";
        };

        schema_config = {
          configs = [
            {
              from = "2024-04-25";
              store = "tsdb";
              object_store = "filesystem";
              schema = "v13";
              index = {
                prefix = "index_";
                period = "24h";
              };
            }
          ];
        };

        storage_config = {
          tsdb_shipper = {
            active_index_directory = "/var/lib/loki/tsdb-shipper-active";
            cache_location = "/var/lib/loki/tsdb-shipper-cache";
            cache_ttl = "24h";
          };

          filesystem = {
            directory = "/var/lib/loki/chunks";
          };
        };

        limits_config = {
          creation_grace_period = "12h";
          reject_old_samples = true;
          reject_old_samples_max_age = "168h";
          max_query_series = 100000;
          max_entries_limit_per_query = 100000;
          query_timeout = "3m";
        };

        table_manager = {
          retention_deletes_enabled = false;
          retention_period = "0s";
        };

        compactor = {
          working_directory = "/var/lib/loki";
          compactor_ring = {
            kvstore = {
              store = "inmemory";
            };
          };
        };
      };
    };

    services.nginx = {
      enable = true;
      virtualHosts."loki.vmserver.vnet" = {
        locations = {
          "/" = {
            proxyPass = "http://127.0.0.1:3100";
            extraConfig = ''
              proxy_http_version 1.1;
              proxy_read_timeout 1800s;
              proxy_connect_timeout 1600s;
              proxy_set_header Upgrade $http_upgrade;
              proxy_set_header Connection $connection_upgrade;
              proxy_set_header Connection "Keep-Alive";
              proxy_set_header Proxy-Connection "Keep-Alive";
              proxy_redirect off;
            '';
          };
          "/ready" = {
            proxyPass = "http://127.0.0.1:3100";
            extraConfig = ''
              proxy_http_version 1.1;
              proxy_set_header Connection "Keep-Alive";
              proxy_set_header Proxy-Connection "Keep-Alive";
              proxy_redirect off;
            '';
          };
        };
      };
    };
  };
}
