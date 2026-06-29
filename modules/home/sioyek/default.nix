{
  lib,
  config,
  pkgs,
  ...
}:
{
  options = {
    mine.home.sioyek = {
      enable = lib.mkEnableOption "enable sioyek pdf viewer";
      nvidia = lib.mkEnableOption "run via XWayland + GLX (fixes NVIDIA EGL error 3009)";
    };
  };

  config = lib.mkIf config.mine.home.sioyek.enable {
    home.packages = [
      (pkgs.symlinkJoin {
        name = "sioyek-wrapped";
        paths = [ pkgs.sioyek ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        # On NVIDIA, Qt6 defaults to EGL even on xcb and hits GL error 3009
        # (EGL_BAD_MATCH); run via XWayland and force GLX instead.
        postBuild = lib.optionalString config.mine.home.sioyek.nvidia ''
          wrapProgram $out/bin/sioyek \
            --set QT_QPA_PLATFORM xcb \
            --set QT_XCB_GL_INTEGRATION xcb_glx
        '';
      })
    ];
  };
}
