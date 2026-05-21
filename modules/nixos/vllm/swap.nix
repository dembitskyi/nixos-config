# llama-swap reverse proxy in front of the per-model vLLM units.
# Routes by the request's `model` field, starts the corresponding
# vllm-<key>.service on demand, stops it after `ttlSeconds` of idle time.
# A polkit rule lets the llama-swap user manage only vllm-*.service units.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.vllm;
  scfg = cfg.swap;

  activeModelKeys = lib.attrNames cfg.activeModels;

  # Build llama-swap YAML as JSON (YAML is a superset of JSON, llama-swap
  # parses both — avoids fragile string templating).
  swapConfig = {
    healthCheckTimeout = scfg.healthCheckTimeoutSeconds;

    models = lib.listToAttrs (
      map (
        modelKey:
        let
          m = cfg.models.${modelKey};
          port = cfg.activeModels.${modelKey}.port;
          unit = cfg._unitName modelKey;
        in
        {
          name = m.servedName;
          value = {
            cmd = "${pkgs.systemd}/bin/systemctl start --wait ${unit}.service";
            cmdStop = "${pkgs.systemd}/bin/systemctl stop ${unit}.service";
            proxy = "http://127.0.0.1:${toString port}";
            checkEndpoint = "/v1/models";
            ttl = scfg.ttlSeconds;
          };
        }
      ) activeModelKeys
    );

    groups = lib.optionalAttrs scfg.exclusive {
      exclusive = {
        swap = true;
        exclusive = true;
        members = map (k: cfg.models.${k}.servedName) activeModelKeys;
      };
    };
  };

  configFile = pkgs.writeText "llama-swap-config.yaml" (builtins.toJSON swapConfig);
in
{
  options.mine.vllm.swap = {
    enable = lib.mkEnableOption "llama-swap on-demand proxy in front of vLLM";

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address llama-swap binds to.";
    };

    listenPort = lib.mkOption {
      type = lib.types.port;
      default = 5411;
      description = "Port llama-swap binds to. This is the endpoint clients hit.";
    };

    ttlSeconds = lib.mkOption {
      type = lib.types.int;
      default = 1200;
      description = "Idle timeout (seconds) before an inactive model is stopped.";
    };

    healthCheckTimeoutSeconds = lib.mkOption {
      type = lib.types.int;
      default = 300;
      description = ''
        Maximum time (seconds) llama-swap waits for a model's checkEndpoint
        to return 200 after starting. Cold-start of large quantized models
        with long context can take a couple of minutes.
      '';
    };

    exclusive = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        If true, only one model is loaded at a time (swap on request). Set
        to false if you intentionally want concurrent residency and have
        split GPU memory accordingly.
      '';
    };
  };

  config = lib.mkIf (cfg.enable && scfg.enable) {
    assertions = [
      {
        assertion = cfg.activeModels != { };
        message = "mine.vllm.swap.enable requires at least one mine.vllm.activeModels entry.";
      }
    ];

    users.users.llama-swap = {
      isSystemUser = true;
      group = "llama-swap";
      description = "llama-swap proxy user";
    };
    users.groups.llama-swap = { };

    # Allow the llama-swap user to start/stop/restart only vllm-*.service
    # units, with no password and no other systemd management permissions.
    security.polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (action.id == "org.freedesktop.systemd1.manage-units" &&
            subject.user == "llama-swap") {
          var unit = action.lookup("unit");
          var verb = action.lookup("verb");
          if (unit && unit.indexOf("vllm-") == 0 && unit.indexOf(".service") > 0 &&
              (verb == "start" || verb == "stop" || verb == "restart")) {
            return polkit.Result.YES;
          }
        }
      });
    '';

    systemd.services.llama-swap = {
      description = "llama-swap on-demand model proxy";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.systemd ];
      serviceConfig = {
        Type = "simple";
        User = "llama-swap";
        Group = "llama-swap";
        Restart = "on-failure";
        RestartSec = "5s";
        ExecStart = "${pkgs.llama-swap}/bin/llama-swap --config ${configFile} --listen ${scfg.listenAddress}:${toString scfg.listenPort}";
      };
    };
  };
}
