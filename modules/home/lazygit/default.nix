{
  lib,
  config,
  ...
}:
{

  options = {
    mine.home.lazygit.enable = lib.mkEnableOption "enable lazygit";
  };

  config = lib.mkIf config.mine.home.lazygit.enable {
    programs.lazygit = {
      enable = true;

      settings = {
        disableStartupPopups = true;
        git = {
          autoFetch = false;
          autoRefresh = false;
          allBranchesLogCmds = [
            "git log --graph --all --abbrev-commit --color=always --decorate  --pretty=full --show-signature"
          ];
          branchLogCmd = "git log --graph --abbrev-commit --color=always --decorate --pretty=full --show-signature {{branchName}} --";
          commit = {
            signOff = true;
          };
          pagers = [
            {
              colorArg = "always";
              pager = "delta --dark --paging=never --line-numbers --hyperlinks --hyperlinks-file-link-format=\"lazygit-edit://{path}:{line}\"";
              useConfig = false;
            }
          ];
        };
        gui = {
          filterMode = "fuzzy";
          nerdFontsVersion = "3";
        };
        os = {
          # Full edit preset settings (in place of `editPreset = "vscode"`).
          # Based on:
          # https://github.com/jesseduffield/lazygit/blob/61636d820c9bb6f0f52b0821b7114e9c7ba38e0b/pkg/config/editor_presets.go#L94
          # but adapted to `code-insiders`.
          edit = "code-insiders --reuse-window -- {{filename}}";
          editAtLine = "code-insiders --reuse-window --goto -- {{filename}}:{{line}}";
          editAtLineAndWait = "code-insiders --reuse-window --goto --wait -- {{filename}}:{{line}}";
          editInTerminal = false;
          openDirInEditor = "code-insiders -- {{dir}}";

          # Other settings.
          open = "xdg-open {{filename}}";
          openLink = "xdg-open {{link}}";
        };
        update = {
          method = "never";
        };
      };
    };
  };
}
