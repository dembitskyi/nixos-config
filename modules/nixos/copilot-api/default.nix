{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.copilot-api.enable = lib.mkEnableOption "enable copilot-api server";
  };

  config = lib.mkIf config.mine.copilot-api.enable {
    services.nginx = {
      enable = true;
      virtualHosts."copilot-api.vmserver.vnet" = {
        locations."/" = {
          proxyPass = "http://127.0.0.1:8999";
          extraConfig = ''
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
          '';
        };
      };
    };

    systemd.services.copilot-api = {
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment.HOME = "/var/lib/copilot-api";

      path = with pkgs; [
        bash
        nodejs
      ];

      serviceConfig = {
        WorkingDirectory = "/var/lib/copilot-api";
        StateDirectory = "copilot-api";
        RuntimeDirectory = "copilot-api";
        DynamicUser = true;

        NoNewPrivileges = true;
        ProtectClock = true;
        PrivateDevices = true;
        PrivateMounts = true;
        PrivateTmp = true;
        PrivateUsers = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        ExecPaths = [
          "/var/lib/copilot-api/.npm/_npx"
        ];
      };
      script =
        [
          (lib.getExe' pkgs.nodejs "npx")
          "copilot-api@latest start --port 8999"
        ]
        |> builtins.filter (v: v != "")
        |> lib.concatStringsSep " ";
    };
  };
}
