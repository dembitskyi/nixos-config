{
  lib,
  pkgs,
}:
let
  npx = lib.getExe' pkgs.nodejs "npx";
  uvx = lib.getExe' pkgs.uv "uvx";
in
rec {
  npxServer = package: {
    command = npx;
    args = [
      "-y"
      package
    ];
  };
  npxServerWithEnv = package: env: {
    command = npx;
    args = [
      "-y"
      package
    ];
    inherit env;
  };
  npxServerWithArgs =
    package: args:
    let
      base = npxServer package;
    in
    base // { args = base.args ++ args; };

  uvxServer = package: {
    command = uvx;
    args = [ package ];
  };

  uvxServerWithEnv = package: env: {
    command = uvx;
    args = [ package ];
    inherit env;
  };

  uvxServerWithArgs =
    package: args:
    let
      base = uvxServer package;
    in
    base // { args = base.args ++ args; };
}
