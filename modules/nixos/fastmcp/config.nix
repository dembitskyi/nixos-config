{
  lib,
  pkgs,
  config,
  placeholder,
  proxyEnv ? false,
}:
let
  fastmcp = lib.getExe' (pkgs.python313.withPackages (ps: [ ps.fastmcp ])) "fastmcp";
  opencode = lib.getExe pkgs.opencode;
  proxyCfg = config.mine.fastmcp.proxy;
  # Inline env prefix applied only to opencode processes.
  proxyPrefix =
    if proxyEnv then
      "HTTP_PROXY=http://127.0.0.1:${toString proxyCfg.port} HTTPS_PROXY=http://127.0.0.1:${toString proxyCfg.port} NO_PROXY=127.0.0.1,localhost "
    else
      "";
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  homeDir = "${userHome}/.local/state/fastmcp";
  helpers = import ./helpers.nix {
    inherit lib pkgs;
  };
  inherit (helpers)
    npxServer
    npxServerWithEnv
    uvxServer
    uvxServerWithArgs
    uvxServerWithEnv
    ;

  browseruse-conf = pkgs.writeText "browseruse.conf" ''
    {
      "browser_profile": {
        "fe352f2b-c9ab-41b5-bd14-d315cd952404": {
          "id": "fe352f2b-c9ab-41b5-bd14-d315cd952404",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268569",
          "headless": false,
          "user_data_dir": null,
          "allowed_domains": null,
          "downloads_path": null,
          "cdp_url": "http://127.0.0.1:9222"
        }
      },
      "llm": {
        "85b108a4-a573-4f6c-b739-f605553f66ce": {
          "id": "85b108a4-a573-4f6c-b739-f605553f66ce",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268580",
          "api_key": null,
          "provider": "${config.mine.fastmcp.browseruse.provider}",
          "model": "${config.mine.fastmcp.browseruse.opencode.model}",
          "host": null
        }
      },
      "agent": {
        "02a2dfdb-d7da-4f48-acae-2766ea324d0d": {
          "id": "02a2dfdb-d7da-4f48-acae-2766ea324d0d",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268586",
          "max_steps": null,
          "use_vision": null,
          "system_prompt": null
        }
      }
    }
  '';

  defaultServerOrder = [
    "git"
    "nixos"
    "github"
    "jira"
    "pdf"
    "context7"
    "memory"
    "wikipedia"
    "fetch"
    "playwright"
    "time"
    "browseruse"
  ];

  builtInServers = {
    time = uvxServerWithArgs "mcp-server-time" [ "--local-timezone=America/Chicago" ];
    browseruse = {
      command = lib.getExe pkgs.browser-use;
      args = [
        "--mcp"
      ];
      env = {
        BROWSER_USE_DEBUG_LOG_FILE = "/tmp/browser.log";
        ANONYMIZED_TELEMETRY = "False";
        BROWSER_USE_CONFIG_PATH = browseruse-conf;
        BROWSER_USE_LOGGING_LEVEL = "info";
        MODEL_PROVIDER = config.mine.fastmcp.browseruse.provider;
        OPENCODE_MODEL = config.mine.fastmcp.browseruse.opencode.model;
        OPENCODE_PROVIDER = config.mine.fastmcp.browseruse.opencode.provider;
        OPENCODE_BASE_URL = "http://127.0.0.1:4097";
        PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
      };
    };

    # Developer Tools
    git = uvxServer "mcp-server-git";
    nixos = uvxServer "mcp-nixos";
    github = npxServerWithEnv "@modelcontextprotocol/server-github" {
      GITHUB_PERSONAL_ACCESS_TOKEN = placeholder."MCP/GITHUB_TOKEN";
    };
    jira = uvxServerWithEnv "mcp-atlassian" {
      JIRA_URL = placeholder."MCP/JIRA_URL";
      JIRA_USERNAME = placeholder."MCP/JIRA_USERNAME";
      JIRA_API_TOKEN = placeholder."MCP/JIRA_API_TOKEN";
      CONFLUENCE_URL = placeholder."MCP/CONFLUENCE_URL";
      CONFLUENCE_USERNAME = placeholder."MCP/CONFLUENCE_USERNAME";
      CONFLUENCE_API_TOKEN = placeholder."MCP/CONFLUENCE_API_TOKEN";
    };
    #kagi = uvxServerWithEnv "kagimcp" {
    #  KAGI_API_KEY = placeholder."MCP/KAGI_API_TOKEN";
    #  KAGI_SUMMARIZER_ENGINE = "cecil";
    #};
    # Information & Knowledge
    pdf = npxServer "@sylphx/pdf-reader-mcp";
    context7 = npxServer "@upstash/context7-mcp";
    memory = {
      command = lib.getExe' pkgs.nodejs "npx";
      args = [
        "-y"
        "@modelcontextprotocol/server-memory"
      ];
      env = {
        MEMORY_FILE_PATH = "${homeDir}/memory.jsonl";
      };
    };
    wikipedia = uvxServerWithArgs "wikipedia-mcp" [ "--enable-cache" ];
    # Search, Web
    fetch = uvxServerWithArgs "mcp-server-fetch" [ "--ignore-robots-txt" ];
    playwright = {
      command = lib.getExe pkgs.playwright-mcp;
      args = [ "--cdp-endpoint=http://127.0.0.1:9222" ];
    };
  };

  servers = builtInServers // config.mine.fastmcp.extraServers;

  extraServerNames = lib.subtractLists defaultServerOrder (builtins.attrNames servers);
  serverOrder = defaultServerOrder ++ extraServerNames;

  mkTemplate = name: serverConfig: {
    name = "mcp-${name}";
    value = {
      content = builtins.toJSON { mcpServers.${name} = serverConfig; };
      owner = config.variables.username;
    };
  };

  # Canonical port assignment: the single source of truth for server → port.
  serverPorts = lib.listToAttrs (
    lib.imap0 (i: name: lib.nameValuePair name (8000 + i)) serverOrder
  );

  # URLs for only the built-in (default) servers.
  defaultServerUrls = lib.listToAttrs (
    map (name: lib.nameValuePair name "http://127.0.0.1:${toString serverPorts.${name}}/${name}") defaultServerOrder
  );

in
{
  templates = builtins.listToAttrs (lib.mapAttrsToList mkTemplate servers);

  loadConfig = lib.mapAttrsToList (
    name: _: "config_${name}.json:${config.sops.templates."mcp-${name}".path}"
  ) servers;

  # All server URLs (built-in + extra). Exposed as mine.fastmcp.serverUrls.
  serverUrls = lib.mapAttrs (
    name: port: "http://127.0.0.1:${toString port}/${name}"
  ) serverPorts;

  # Only built-in server URLs, passed to the home-manager opencode module.
  inherit defaultServerUrls;

  execStartScript = pkgs.writeShellScript "fastmcp-server" ''
    mkdir -p ~/workspace
    cd ~/workspace
    ${proxyPrefix}${opencode} serve --hostname 127.0.0.1 --port 4096 & # --print-logs
    ${proxyPrefix}OPENCODE_DB=opencode-automation.db ${opencode} serve --hostname 127.0.0.1 --port 4097 & # --print-logs
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        name: port:
        "${fastmcp} run $CREDENTIALS_DIRECTORY/config_${name}.json --no-banner -t streamable-http -p ${toString port} --path /${name} &"
      ) serverPorts
    )}
    wait
  '';
}
