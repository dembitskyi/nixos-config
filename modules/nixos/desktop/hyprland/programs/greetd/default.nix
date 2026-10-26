{
  lib,
  config,
  pkgs,
  ...
}:
let
  output = config.mine.hyprland.mainOutput;
  westonConfig = ''
    [keyboard]
    keymap_layout=us
    keymap_model=pc104
    keymap_options=terminate:ctrl_alt_bksp
    keymap_variant=

    [libinput]
    enable-tap=true
    left-handed=false
  ''
  + lib.optionalString (output != null) ''

    [output]
    name=${output.name}
    mode=${output.mode}
    scale=${toString output.scale}
  '';
  sddmDependencies = [
    pkgs.sddm-astronaut
    pkgs.kdePackages.qtsvg # Sddm Dependency
    pkgs.kdePackages.qtmultimedia # Sddm Dependency
    pkgs.kdePackages.qtvirtualkeyboard # Sddm Dependency
  ];
in
{
  config = lib.mkIf config.mine.hyprland.enable {
    environment.etc."sddm-weston.ini".text = westonConfig;
    services.displayManager = {
      sddm = {
        enable = true;
        wayland.enable = true;
        package = lib.mkForce pkgs.kdePackages.sddm;
        extraPackages = sddmDependencies;
        theme = "sddm-astronaut-theme";
        settings = {
          Theme = {
            Current = "sddm-astronaut-theme";
          };
          General = {
            DisplayServer = "wayland";
            Greeter = "${pkgs.kdePackages.sddm}/bin/sddm-greeter-qt6";
          };
          Wayland.CompositorCommand = ''
            ${pkgs.weston}/bin/weston --shell=kiosk -c /etc/sddm-weston.ini
          '';
        };
      };
    };

    environment.systemPackages = sddmDependencies;
  };
}
