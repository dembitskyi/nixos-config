{
  lib,
  config,
  pkgs,
  ncInputs,
  ...
}:
let
  cfg = config.mine.home.sioyek;

  # On NVIDIA, Qt6 defaults to EGL even on xcb and hits GL error 3009
  # (EGL_BAD_MATCH); run via XWayland and force GLX instead.
  sioyekPkg =
    if cfg.nvidia then
      pkgs.symlinkJoin {
        name = "sioyek-wrapped";
        paths = [ pkgs.sioyek ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/sioyek \
            --set QT_QPA_PLATFORM xcb \
            --set QT_XCB_GL_INTEGRATION xcb_glx
        '';
      }
    else
      pkgs.sioyek;

  # Catppuccin theme requires `toggle_custom_color` to apply on startup.
  theme = ncInputs.catppuccin-sioyek + "/themes/catppuccin-${cfg.flavor}.config";
in
{
  options = {
    mine.home.sioyek = {
      enable = lib.mkEnableOption "enable sioyek pdf viewer";
      nvidia = lib.mkEnableOption "run via XWayland + GLX (fixes NVIDIA EGL error 3009)";
      flavor = lib.mkOption {
        type = lib.types.enum [
          "latte"
          "frappe"
          "macchiato"
          "mocha"
        ];
        default = "mocha";
        description = "Catppuccin flavor for sioyek.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    programs.sioyek = {
      enable = true;
      package = sioyekPkg;
    };

    xdg.configFile."sioyek/prefs_user.config".text = ''
      ${builtins.readFile theme}
      startup_commands toggle_custom_color
    '';
  };
}
