# Thermal monitoring for GPU, CPU, motherboard, RAM, and NVMe.
#
# Polls each source on its own interval and emits structured journal entries
# at INFO/WARN/CRIT severity. All services log via systemd's stdout journal
# integration using sd-daemon(3) <N> priority prefixes.
#
# Three independent systemd units are used so that a hung nvidia-smi (e.g.
# Xid 79 "GPU has fallen off the bus") cannot take CPU/NVMe monitoring down
# with it.
#
# Query examples:
#   journalctl -u 'thermal-monitor-*' -f                    # live tail
#   journalctl -u 'thermal-monitor-*' -p warning            # warns + crits
#   journalctl -u thermal-monitor-gpu --since "1 hour ago"
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.thermal-monitor;

  gpuMonitor = pkgs.writeShellApplication {
    name = "thermal-monitor-gpu";
    runtimeInputs = [
      config.hardware.nvidia.package
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.gawk
    ];
    text = ''
      POLL_INTERVAL="''${POLL_INTERVAL:-${toString cfg.gpu.pollInterval}}"
      GPU_PCI_ADDR="''${GPU_PCI_ADDR:-${cfg.gpu.pciAddress}}"
      TLIMIT_WARN="''${TLIMIT_WARN:-${toString cfg.gpu.tlimitWarn}}"
      TLIMIT_CRIT="''${TLIMIT_CRIT:-${toString cfg.gpu.tlimitCrit}}"

      PCI_SYSFS="/sys/bus/pci/devices/''${GPU_PCI_ADDR}"

      # sd-daemon(3) priority prefixes: <3>=err <4>=warning <6>=info.
      log_info() { printf '<6>%s\n' "$*"; }
      log_warn() { printf '<4>%s\n' "$*"; }
      log_crit() { printf '<3>%s\n' "$*"; }

      while true; do
        if ! basic=$(nvidia-smi \
            --query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,clocks_throttle_reasons.active \
            --format=csv,noheader,nounits 2>&1); then
          log_crit "nvidia-smi failed: $basic"
          sleep "$POLL_INTERVAL"
          continue
        fi

        IFS=',' read -r temp util power_draw power_limit throttle <<< "$basic"
        temp="''${temp// /}"
        util="''${util// /}"
        power_draw="''${power_draw// /}"
        power_limit="''${power_limit// /}"
        throttle="''${throttle# }"

        # Blackwell/Hopper expose temperature as margin-to-throttle, not
        # absolute °C. Filter to the "GPU T.Limit Temp" line only — there
        # are sibling lines for Shutdown/Slowdown/Max that we do not want.
        tlimit=$(nvidia-smi -q -d TEMPERATURE 2>/dev/null \
          | grep -E '^[[:space:]]*GPU T\.Limit Temp[[:space:]]*:' \
          | awk -F: '{gsub(/[^0-9-]/,"",$2); print $2}' \
          | head -n1)
        tlimit="''${tlimit:-?}"

        if [[ -d "$PCI_SYSFS" ]]; then
          cur_speed=$(cat "$PCI_SYSFS/current_link_speed" 2>/dev/null || echo "?")
          max_speed=$(cat "$PCI_SYSFS/max_link_speed" 2>/dev/null || echo "?")
          cur_width=$(cat "$PCI_SYSFS/current_link_width" 2>/dev/null || echo "?")
          max_width=$(cat "$PCI_SYSFS/max_link_width" 2>/dev/null || echo "?")
        else
          cur_speed="?"; max_speed="?"; cur_width="?"; max_width="?"
        fi

        level=info
        if [[ "$tlimit" =~ ^-?[0-9]+$ ]]; then
          if (( tlimit <= TLIMIT_CRIT )); then
            level=crit
          elif (( tlimit <= TLIMIT_WARN )); then
            level=warn
          fi
        fi

        if [[ "$throttle" != "Not Active" && -n "$throttle" && "$level" == "info" ]]; then
          level=warn
        fi

        pcie_note=""
        if [[ "$cur_speed" != "$max_speed" && "$max_speed" != "?" ]]; then
          level=crit
          pcie_note=" PCIe-SPEED-DEGRADED"
        fi
        if [[ "$cur_width" != "$max_width" && "$max_width" != "?" ]]; then
          level=crit
          pcie_note="$pcie_note PCIe-WIDTH-DEGRADED"
        fi

        msg="temp=''${temp}C tlimit_margin=''${tlimit}C util=''${util}% power=''${power_draw}/''${power_limit}W throttle=$throttle pcie=''${cur_speed}/''${max_speed}@x''${cur_width}/x''${max_width}$pcie_note"
        case "$level" in
          crit) log_crit "$msg" ;;
          warn) log_warn "$msg" ;;
          *)    log_info "$msg" ;;
        esac

        sleep "$POLL_INTERVAL"
      done
    '';
  };

  sensorsMonitor = pkgs.writeShellApplication {
    name = "thermal-monitor-sensors";
    runtimeInputs = with pkgs; [
      lm_sensors
      jq
      coreutils
    ];
    text = ''
      POLL_INTERVAL="''${POLL_INTERVAL:-${toString cfg.sensors.pollInterval}}"
      TEMP_WARN="''${TEMP_WARN:-${toString cfg.sensors.tempWarn}}"
      TEMP_CRIT="''${TEMP_CRIT:-${toString cfg.sensors.tempCrit}}"

      log_info() { printf '<6>%s\n' "$*"; }
      log_warn() { printf '<4>%s\n' "$*"; }
      log_crit() { printf '<3>%s\n' "$*"; }

      while true; do
        if ! json=$(sensors -j 2>/dev/null); then
          log_warn "sensors -j failed"
          sleep "$POLL_INTERVAL"
          continue
        fi

        # Walk lm_sensors JSON. Top level is keyed by chip ("k10temp-pci-00c3"),
        # each chip contains feature objects ("Tctl"), and each feature contains
        # a temp[N]_input scalar plus optional crit/max thresholds.
        readings=$(jq -c '
          [
            to_entries[] |
            .key as $chip |
            .value |
            to_entries[] |
            select(.value | type == "object") |
            .key as $feature |
            .value |
            to_entries[] |
            select(.key | test("^temp[0-9]+_input$")) |
            {chip: $chip, feature: $feature, value: .value}
          ]
        ' <<<"$json")

        summary=$(jq -r '
          .[] | "\(.chip | split("-")[0]).\(.feature)=\(.value | tostring)C"
        ' <<<"$readings" | tr '\n' ' ')

        max_temp=$(jq -r '[.[].value] | max // 0' <<<"$readings")
        max_int="''${max_temp%.*}"

        level=info
        if [[ "$max_int" =~ ^-?[0-9]+$ ]]; then
          if (( max_int >= TEMP_CRIT )); then
            level=crit
          elif (( max_int >= TEMP_WARN )); then
            level=warn
          fi
        fi

        if [[ -n "$summary" ]]; then
          msg="max=''${max_temp}C $summary"
        else
          msg="no readings (no hwmon chips detected; try sensors-detect)"
          level=warn
        fi

        case "$level" in
          crit) log_crit "$msg" ;;
          warn) log_warn "$msg" ;;
          *)    log_info "$msg" ;;
        esac

        sleep "$POLL_INTERVAL"
      done
    '';
  };

  nvmeMonitor = pkgs.writeShellApplication {
    name = "thermal-monitor-nvme";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      shopt -s nullglob

      POLL_INTERVAL="''${POLL_INTERVAL:-${toString cfg.nvme.pollInterval}}"
      TEMP_WARN="''${TEMP_WARN:-${toString cfg.nvme.tempWarn}}"
      TEMP_CRIT="''${TEMP_CRIT:-${toString cfg.nvme.tempCrit}}"

      log_info() { printf '<6>%s\n' "$*"; }
      log_warn() { printf '<4>%s\n' "$*"; }
      log_crit() { printf '<3>%s\n' "$*"; }

      while true; do
        level=info
        msgs=()

        for nvme_dev in /sys/class/nvme/nvme*; do
          [[ -d "$nvme_dev" ]] || continue
          name="$(basename "$nvme_dev")"
          for hwmon in "$nvme_dev"/hwmon*/; do
            for ti in "$hwmon"temp*_input; do
              [[ -e "$ti" ]] || continue
              lf="''${ti%_input}_label"
              label="?"
              if [[ -e "$lf" ]]; then
                label="$(cat "$lf" 2>/dev/null || echo '?')"
              fi
              raw="$(cat "$ti" 2>/dev/null || echo 0)"
              c=$(( raw / 1000 ))
              msgs+=("''${name}.''${label}=''${c}C")
              if (( c >= TEMP_CRIT )); then
                level=crit
              elif (( c >= TEMP_WARN )) && [[ "$level" != "crit" ]]; then
                level=warn
              fi
            done
          done
        done

        if (( ''${#msgs[@]} > 0 )); then
          msg="''${msgs[*]}"
          case "$level" in
            crit) log_crit "$msg" ;;
            warn) log_warn "$msg" ;;
            *)    log_info "$msg" ;;
          esac
        fi

        sleep "$POLL_INTERVAL"
      done
    '';
  };

  commonHardening = {
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    NoNewPrivileges = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictAddressFamilies = [
      "AF_UNIX"
    ];
    RestrictNamespaces = true;
    LockPersonality = true;
    MemoryDenyWriteExecute = true;
    SystemCallArchitectures = "native";
  };
in
{
  options.mine.thermal-monitor = {
    enable = lib.mkEnableOption "thermal monitoring for GPU/CPU/motherboard/NVMe";

    gpu = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run the GPU thermal poller (requires NVIDIA driver).";
      };
      pciAddress = lib.mkOption {
        type = lib.types.str;
        default = "0000:01:00.0";
        description = "PCI address of the NVIDIA GPU; used to read PCIe link state from sysfs.";
      };
      pollInterval = lib.mkOption {
        type = lib.types.int;
        default = 10;
        description = "Seconds between GPU thermal samples.";
      };
      tlimitWarn = lib.mkOption {
        type = lib.types.int;
        default = 15;
        description = ''
          WARN when GPU "T.Limit Temp" margin (°C until throttle) drops to this
          value or below. On Blackwell/Hopper this margin is the canonical
          thermal-headroom indicator; throttle starts at 0.
        '';
      };
      tlimitCrit = lib.mkOption {
        type = lib.types.int;
        default = 5;
        description = "CRIT when GPU T.Limit margin (°C until throttle) drops to this value or below.";
      };
    };

    sensors = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run the lm_sensors thermal poller (CPU/motherboard/RAM via hwmon).";
      };
      pollInterval = lib.mkOption {
        type = lib.types.int;
        default = 10;
        description = "Seconds between lm_sensors samples.";
      };
      tempWarn = lib.mkOption {
        type = lib.types.int;
        default = 88;
        description = ''
          WARN when any lm_sensors temperature reaches this value (°C).
          Tuned for Ryzen Tctl under sustained inference load; modern Ryzen
          Tjmax is 95 °C and Tctl carries a +offset over Tdie, so 80-85 °C
          is normal under load.
        '';
      };
      tempCrit = lib.mkOption {
        type = lib.types.int;
        default = 95;
        description = "CRIT when any lm_sensors temperature reaches this value (°C); matches Ryzen Tjmax.";
      };
    };

    nvme = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run the NVMe thermal poller.";
      };
      pollInterval = lib.mkOption {
        type = lib.types.int;
        default = 30;
        description = "Seconds between NVMe thermal samples.";
      };
      tempWarn = lib.mkOption {
        type = lib.types.int;
        default = 70;
        description = "WARN when any NVMe sensor reaches this value (°C).";
      };
      tempCrit = lib.mkOption {
        type = lib.types.int;
        default = 80;
        description = "CRIT when any NVMe sensor reaches this value (°C).";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # AMD CPU temperature sensor; safe no-op on Intel hosts.
    boot.kernelModules = [ "k10temp" ];

    # Make `sensors` and `sensors-detect` available interactively for
    # one-time motherboard chip discovery.
    environment.systemPackages = [ pkgs.lm_sensors ];

    systemd.services.thermal-monitor-gpu = lib.mkIf cfg.gpu.enable {
      description = "Thermal monitor: NVIDIA GPU";
      wantedBy = [ "multi-user.target" ];
      after = [ "nvidia-persistenced.service" ];
      wants = [ "nvidia-persistenced.service" ];
      serviceConfig = commonHardening // {
        Type = "simple";
        ExecStart = lib.getExe gpuMonitor;
        Restart = "on-failure";
        RestartSec = "30s";
        SyslogIdentifier = "thermal-monitor-gpu";
        DynamicUser = true;
        # nvidia-smi needs /dev/nvidia* which is gated by the video group.
        SupplementaryGroups = [ "video" ];
      };
    };

    systemd.services.thermal-monitor-sensors = lib.mkIf cfg.sensors.enable {
      description = "Thermal monitor: lm_sensors (CPU/motherboard/RAM)";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-modules-load.service" ];
      serviceConfig = commonHardening // {
        Type = "simple";
        ExecStart = lib.getExe sensorsMonitor;
        Restart = "on-failure";
        RestartSec = "30s";
        SyslogIdentifier = "thermal-monitor-sensors";
        DynamicUser = true;
      };
    };

    systemd.services.thermal-monitor-nvme = lib.mkIf cfg.nvme.enable {
      description = "Thermal monitor: NVMe drives";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = commonHardening // {
        Type = "simple";
        ExecStart = lib.getExe nvmeMonitor;
        Restart = "on-failure";
        RestartSec = "30s";
        SyslogIdentifier = "thermal-monitor-nvme";
        DynamicUser = true;
      };
    };
  };
}
