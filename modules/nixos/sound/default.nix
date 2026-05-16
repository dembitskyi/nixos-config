{ lib, config, ... }:
{

  options = {
    mine.sound.enable = lib.mkEnableOption "enable audio services";
  };

  config = lib.mkIf config.mine.sound.enable {
    security.rtkit.enable = true;
    services.pipewire = {
      enable = true;
      alsa.enable = true;
      alsa.support32Bit = true;
      wireplumber.enable = true;
      pulse.enable = true;
      jack.enable = true;
      extraConfig.pipewire-pulse."99-null-sink-ai-chromium" = {
        "pulse.cmd" = [
          {
            cmd = "load-module";
            args = "module-null-sink sink_name=ai-chromium-sink sink_properties=device.description=AiChromiumSink";
          }
        ];
      };
    };
  };

}
