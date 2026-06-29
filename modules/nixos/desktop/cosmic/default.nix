{
  lib,
  config,
  ...
}:
{
  options = {
    mine.cosmic.enable = lib.mkEnableOption "enable cosmic";
  };

  config = lib.mkIf config.mine.cosmic.enable {
    # Enable the X11 windowing system.
    services.xserver.enable = true;
    services.xserver.videoDrivers = [ "nvidia" ];

    services.displayManager.cosmic-greeter.enable = true;
    services.desktopManager.cosmic.enable = true;
    services.desktopManager.cosmic.xwayland.enable = true; # (optional, for legacy X11 apps)
    services.orca.enable = false;

    # Configure keymap in X11
    services.xserver.xkb = {
      layout = "us";
      variant = "";
    };
  };
}
